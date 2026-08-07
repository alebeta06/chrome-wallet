/**
 * @file lib/signer.ts
 * @description Where a transaction is actually signed and sent.
 *
 * ---------------------------------------------------------------------------
 * THIS RUNS IN THE SERVICE WORKER AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: la regla de oro del proyecto. El mnemonic y las claves privadas
 * viven SOLO aquí. `notification.html` aprueba o rechaza — no deriva, no firma y
 * no ve una clave en su vida. Si algún día este archivo se importara desde
 * `src/ui/`, la wallet dejaría de cumplir su propia premisa.
 *
 * El provider y el signer se inyectan para poder probar el orden de la cola, el
 * cálculo del nonce y el mapeo de errores sin un nodo delante.
 */

import { toBeHex, type TransactionResponse } from "ethers";

import {
  ErrorCode,
  ProviderErrors,
  type Address,
  type Hex,
  type NetworkConfig,
  type TypedDataPayload,
} from "@/types/messages";

import { createRpcProvider } from "./chain";
import { ProviderError } from "./errors";
import { deriveSigner } from "./hd-wallet";
import type { ParsedTransaction } from "./tx";
import { signableTypes } from "./typed-data";

/** The slice of an ethers provider this module needs. */
export interface ChainWriter {
  /**
   * 🇪🇸 NOTA: `getTransactionCount` y no `getNonce`. En ethers v6 `getNonce` es
   * un método del Signer, no del Provider — y el signer NO se conecta al
   * provider aquí a propósito: firma sin red y el envío es un paso aparte.
   */
  getTransactionCount(address: string, blockTag: "pending"): Promise<number>;
  /**
   * 🇪🇸 NOTA: `gasPrice` además de los dos campos de EIP-1559. Una red que no
   * implementa 1559 devuelve los dos primeros a null y solo éste con valor, y
   * sin leerlo no habría forma de fijar el precio de una transacción legacy.
   */
  getFeeData(): Promise<FeeData>;
  estimateGas(tx: Record<string, unknown>): Promise<bigint>;
  broadcast(signed: string): Promise<TransactionResponse>;
  destroy(): void;
}

export interface FeeData {
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  gasPrice: bigint | null;
}

/**
 * What a transaction will pay, in one of the two shapes a chain can offer.
 *
 * ---------------------------------------------------------------------------
 * TWO SHAPES, AND THE TYPE MAKES THEM EXCLUSIVE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: una unión discriminada y no tres campos opcionales. Con opcionales,
 * "1559 a medias" —`maxFeePerGas` puesto y `gasPrice` también— sería un estado
 * representable, y alguien acabaría firmando una transacción con los dos
 * campos, que los nodos rechazan. Aquí no se puede escribir.
 */
export type Fees =
  | { txType: 2; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }
  | { txType: 0; gasPrice: Hex };

export type FeeEstimate = Fees & { gas: Hex };

export interface SendInput {
  network: NetworkConfig;
  phrase: string;
  accountIndex: number;
  transaction: ParsedTransaction;
}

export interface SignTypedDataInput {
  phrase: string;
  accountIndex: number;
  address: Address;
  payload: TypedDataPayload;
}

export interface TransactionSender {
  /** Signs and broadcasts. Resolves with the transaction hash. */
  send(input: SendInput): Promise<Hex>;
  /** Best-effort numbers for the approval window. Never throws. */
  estimate(input: Omit<SendInput, "phrase" | "accountIndex">): Promise<FeeEstimate | null>;
  /** Signs an EIP-712 payload. Needs no network at all — see the note. */
  signTypedData(input: SignTypedDataInput): Promise<Hex>;
}

export type ChainWriterFactory = (network: NetworkConfig) => ChainWriter;

/**
 * 🇪🇸 NOTA: el provider se construye con `createRpcProvider` de `chain.ts` en vez
 * de repetir aquí las opciones. Eran dos copias de la misma configuración, y la
 * Fase 8 demostró por qué eso es un problema: al medir que faltaba pasar la red
 * en el constructor, una copia se habría arreglado y la otra no — con el
 * resultado de que leer un saldo costaría una petición y firmar costaría dos,
 * sin nada que lo delatara.
 */
export const createChainWriter: ChainWriterFactory = (network) => {
  const provider = createRpcProvider(network);

  return {
    getTransactionCount: (address, blockTag) => provider.getTransactionCount(address, blockTag),
    getFeeData: () => provider.getFeeData(),
    estimateGas: (tx) => provider.estimateGas(tx),
    broadcast: (signed) => provider.broadcastTransaction(signed),
    destroy: () => provider.destroy(),
  };
};

export function createTransactionSender(
  createWriter: ChainWriterFactory = createChainWriter,
): TransactionSender {
  /**
   * ------------------------------------------------------------------------
   * THE QUEUE IS THE NONCE FIX. NOT NonceManager.
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: dos transacciones aprobadas seguidas cogen el mismo nonce y la
   * segunda muere con `replacement transaction underpriced`.
   *
   * `ethers.NonceManager` no resuelve esto aquí. Uno por operación no cuenta
   * nada —consulta el nonce igual, y dos concurrentes leen el mismo—. Uno a
   * nivel de módulo sería estado global en el background, que el proyecto
   * prohíbe, y además se desincroniza en cuanto el usuario mueve fondos desde
   * otro sitio con la misma cuenta.
   *
   * El problema no es llevar la cuenta, es el SOLAPAMIENTO. La cola garantiza
   * que la tx N está difundida antes de que la N+1 pregunte su nonce, y
   * `getTransactionCount(from, "pending")` ya la incluye porque está en la mempool.
   *
   * Que la cola no sobreviva al reinicio del worker da igual: si el worker
   * murió, no hay envíos en vuelo contra los que serializar. Mismo razonamiento
   * que el Map de esperantes de `approvals.ts`.
   */
  let queue: Promise<unknown> = Promise.resolve();

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    // Both branches run the task: one failed send must not stall every later one.
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  async function estimate({
    network,
    transaction,
  }: Omit<SendInput, "phrase" | "accountIndex">): Promise<FeeEstimate | null> {
    const writer = createWriter(network);

    try {
      const [feeData, gas] = await Promise.all([
        writer.getFeeData(),
        writer.estimateGas({
          from: transaction.from,
          to: transaction.to,
          value: transaction.value,
          data: transaction.data,
        }),
      ]);

      const fees = resolveFees(transaction, feeData);
      if (fees === null) return null;

      return {
        ...fees,
        gas: transaction.gas ?? (toBeHex(gas) as Hex),
      };
    } catch (cause) {
      /**
       * 🇪🇸 NOTA: devuelve null, no lanza. Esto solo alimenta la ventana de
       * aprobación, y no poder estimar el coste no puede impedir firmar: si fue
       * un parpadeo del nodo, el envío funciona igual. La ventana enseña "no se
       * pudo estimar" en vez de un número inventado, que sería mucho peor.
       */
      console.error("[codecrypto] could not estimate the transaction:", cause);
      return null;
    } finally {
      writer.destroy();
    }
  }

  function send(input: SendInput): Promise<Hex> {
    return serialize(() => doSend(input, createWriter));
  }

  /**
   * ------------------------------------------------------------------------
   * SIGNING A MESSAGE NEEDS NO NETWORK, AND SO NO QUEUE
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: esto es criptografía local y nada más — no hay nonce que pedir, no
   * hay fees que estimar y no hay nada que difundir. Dos consecuencias que no
   * son obvias:
   *
   *   - NO pasa por la cola. La cola existe para que dos transacciones no cojan
   *     el mismo nonce; aquí no hay nonce, así que serializar solo haría que una
   *     firma esperase a que terminara un envío que no tiene nada que ver.
   *   - FUNCIONA CON EL NODO APAGADO. Con Anvil parado, `eth_sendTransaction`
   *     falla y `eth_signTypedData_v4` no. Hay una comprobación manual para eso
   *     porque es una propiedad que sorprende.
   */
  async function signTypedData({
    phrase,
    accountIndex,
    address,
    payload,
  }: SignTypedDataInput): Promise<Hex> {
    const wallet = deriveSigner(phrase, accountIndex);

    // Same belt-and-braces as doSend: the derived key must be the authorised one.
    if (wallet.address.toLowerCase() !== address.toLowerCase()) {
      throw new ProviderError({
        code: ErrorCode.INTERNAL,
        message: "The wallet derived a different account than the one authorised.",
      });
    }

    try {
      return (await wallet.signTypedData(
        payload.domain,
        signableTypes(payload),
        payload.message,
      )) as Hex;
    } catch (cause) {
      /**
       * 🇪🇸 NOTA: si ethers rechaza el payload aquí es porque tiene algo que
       * `typed-data.ts` no supo ver — un tipo declarado que no existe, un valor
       * que no encaja con su tipo. Es culpa de la petición, no de la wallet, así
       * que -32602 y no -32603. El mensaje se escribe aquí en vez de reenviar el
       * de ethers, que puede llevar dentro el payload entero.
       */
      console.error("[codecrypto] could not sign the typed data:", cause);
      throw new ProviderError(
        ProviderErrors.invalidParams("The typed data could not be signed as declared."),
      );
    }
  }

  return { send, estimate, signTypedData };
}

async function doSend(
  { network, phrase, accountIndex, transaction }: SendInput,
  createWriter: ChainWriterFactory,
): Promise<Hex> {
  const writer = createWriter(network);

  try {
    const wallet = deriveSigner(phrase, accountIndex);

    /**
     * 🇪🇸 NOTA: se comprueba que la clave derivada corresponde de verdad a la
     * dirección autorizada. Es barato y cierra el caso en el que un índice
     * equivocado —por un `connectedSites` corrupto o un bug futuro de
     * indexación— firmaría con otra cuenta sin que nada lo notara.
     */
    if (wallet.address.toLowerCase() !== transaction.from.toLowerCase()) {
      throw new ProviderError({
        code: ErrorCode.INTERNAL,
        message: "The wallet derived a different account than the one authorised.",
      });
    }

    const nonce =
      transaction.nonce !== undefined
        ? Number(BigInt(transaction.nonce))
        : await viaNode(network, () => writer.getTransactionCount(transaction.from, "pending"));

    const feeData = await viaNode(network, () => writer.getFeeData());
    const fees = resolveFees(transaction, feeData);

    /**
     * 🇪🇸 NOTA: null aquí significa que el nodo respondió y no dio NINGÚN precio
     * —ni 1559 ni legacy—, que es una red que no sabe decir cuánto cuesta
     * enviar. Sigue siendo 4901 y no -32602: la wallet está bien y la petición
     * también; el que no sirve es el nodo.
     */
    if (fees === null) {
      throw new ProviderError({
        code: ErrorCode.CHAIN_DISCONNECTED,
        message: `Cannot get a gas price from ${network.name}.`,
      });
    }

    const gas =
      transaction.gas ??
      (toBeHex(
        await viaNode(network, () =>
          writer.estimateGas({
            from: transaction.from,
            to: transaction.to,
            value: transaction.value,
            data: transaction.data,
          }),
        ),
      ) as Hex);

    /**
     * 🇪🇸 NOTA: el `type` explícito, no confiado a la inferencia. Ethers suele
     * acertar, pero "suele" no es una garantía, y el error va en las dos
     * direcciones: una legacy en una red 1559 paga de más y puede quedarse
     * atascada; una 1559 en una red que no lo implementa la rechaza el nodo.
     * Se comprueba en el recibo durante las comprobaciones manuales.
     */
    const priced =
      fees.txType === 2
        ? {
            type: 2 as const,
            maxFeePerGas: BigInt(fees.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGas),
          }
        : { type: 0 as const, gasPrice: BigInt(fees.gasPrice) };

    const signed = await wallet.signTransaction({
      ...priced,
      chainId: BigInt(network.chainId),
      to: transaction.to,
      value: BigInt(transaction.value),
      data: transaction.data,
      nonce,
      gasLimit: BigInt(gas),
    });

    const response = await viaNode(network, () => writer.broadcast(signed));
    return response.hash as Hex;
  } catch (cause) {
    throw toSendError(cause);
  } finally {
    writer.destroy();
  }
}

/**
 * Explicit fees win. Missing ones come from the node.
 *
 * 🇪🇸 NOTA: si la dApp manda las fees, se respetan. Es una petición legítima —
 * una dApp puede querer acelerar una transacción — y sobrescribirlas en silencio
 * haría que la wallet enviara algo distinto de lo que se le pidió.
 *
 * ---------------------------------------------------------------------------
 * 1559 FIRST, LEGACY ONLY WHEN THE CHAIN CANNOT DO 1559
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: el orden importa y el fallback NO puede activarse de más. Anvil y
 * Sepolia soportan EIP-1559 y tienen que seguir yendo por `type: 2`: una
 * transacción legacy en una red 1559 paga de más y puede quedarse atascada, que
 * es exactamente el problema que 1559 vino a resolver.
 *
 * Por eso legacy es la ÚLTIMA opción y solo cuando falta alguno de los dos
 * campos de 1559 — que es lo que devuelve una red que no lo implementa. Una red
 * añadida en runtime puede ser cualquiera de las dos cosas, y hasta la Fase 8 el
 * caso "falta un campo" era un 4901: la wallet decía que el nodo no respondía
 * cuando el nodo había respondido perfectamente y la respuesta era "aquí no hay
 * 1559".
 */
function resolveFees(transaction: ParsedTransaction, feeData: FeeData): Fees | null {
  const maxFeePerGas =
    transaction.maxFeePerGas ??
    (feeData.maxFeePerGas === null ? null : (toBeHex(feeData.maxFeePerGas) as Hex));

  const maxPriorityFeePerGas =
    transaction.maxPriorityFeePerGas ??
    (feeData.maxPriorityFeePerGas === null ? null : (toBeHex(feeData.maxPriorityFeePerGas) as Hex));

  if (maxFeePerGas !== null && maxPriorityFeePerGas !== null) {
    return { txType: 2, maxFeePerGas, maxPriorityFeePerGas };
  }

  const gasPrice =
    transaction.gasPrice ?? (feeData.gasPrice === null ? null : (toBeHex(feeData.gasPrice) as Hex));

  if (gasPrice === null) return null;
  return { txType: 0, gasPrice };
}

/**
 * ---------------------------------------------------------------------------
 * WHAT IT MEANS THAT THE NODE ANSWERED
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: esta lista está al revés de como estaba, y el motivo es un bug real
 * que encontró la comprobación manual 50.
 *
 * Antes se enumeraban los fallos de TRANSPORTE (`NETWORK_ERROR`, `SERVER_ERROR`,
 * `TIMEOUT`) para mapearlos a 4901, y todo lo demás caía a un -32603 genérico.
 * Con Anvil apagado, ethers no lanza ninguno de esos tres: lanza
 * `code: "ECONNREFUSED"`, el errno de socket crudo. Resultado: "The wallet could
 * not send this transaction" cuando lo que pasaba es que el nodo no estaba.
 *
 * Perseguir códigos de transporte es un juego que no se gana — Node da
 * ECONNREFUSED/ENOTFOUND/ECONNRESET, undici los suyos, y Chrome envuelve el
 * fallo de `fetch` de otra forma. Así que se enumera lo CONTRARIO: los códigos
 * que significan que el nodo sí habló y dijo que no. Cualquier otra cosa que
 * salga de una llamada de red es, por definición, que no llegamos a él.
 *
 * Es el mismo criterio que `chain.ts` usa para los saldos, que por eso sí
 * acertaba con el 4901.
 */
const NODE_ANSWERED: Readonly<Record<string, string>> = {
  INSUFFICIENT_FUNDS: "Not enough ETH in this account to cover the value plus gas.",
  NONCE_EXPIRED: "Another transaction from this account is already in flight. Try again.",
  REPLACEMENT_UNDERPRICED: "Another transaction from this account is already in flight. Try again.",
  CALL_EXCEPTION: "The transaction would fail on-chain, so it was not sent.",
  UNPREDICTABLE_GAS_LIMIT: "The transaction would fail on-chain, so it was not sent.",
  TRANSACTION_REPLACED: "This transaction was replaced by another one.",
};

/**
 * Runs a call that goes over the wire, and classifies whatever it throws.
 *
 * 🇪🇸 NOTA: envolver SOLO las llamadas de red es lo que permite invertir la
 * lista sin mentir en el otro sentido. Un `TypeError` de un bug mío en el resto
 * de `doSend` sigue saliendo por el -32603 genérico; lo que sale de aquí sin que
 * el nodo lo haya explicado es que el nodo no está.
 */
async function viaNode<T>(network: NetworkConfig, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof ProviderError) throw cause;

    const explained = NODE_ANSWERED[String((cause as { code?: unknown }).code)];

    // Full detail stays in the service worker console; the wire gets a code.
    console.error("[codecrypto] an RPC call failed:", cause);

    /**
     * 🇪🇸 NOTA: los mensajes se escriben aquí en vez de reenviar el de ethers
     * porque un error de ethers puede llevar dentro la rpcUrl con su API key, y
     * ese objeto cruzaría hasta la dApp. Hay un test que lo comprueba.
     */
    throw new ProviderError(
      explained === undefined
        ? {
            code: ErrorCode.CHAIN_DISCONNECTED,
            message: `Cannot reach the RPC endpoint for ${network.name}.`,
          }
        : { code: ErrorCode.INTERNAL, message: explained },
    );
  }
}

/**
 * ---------------------------------------------------------------------------
 * A FAILED SEND IS NEVER 4001
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: el usuario YA aprobó. Si un fallo de envío llegara como 4001, la
 * dApp enseñaría "cancelaste la transacción" a alguien que la aprobó y se quedó
 * sin fondos: le culpa de algo que no hizo y esconde la causa real. 4001 queda
 * reservado exclusivamente a "el humano dijo que no".
 *
 * Lo que llega aquí ya viene clasificado por `viaNode`. Este último catch es
 * para lo que NO salió de la red: un bug propio en la derivación o en la firma.
 */
function toSendError(cause: unknown): ProviderError {
  if (cause instanceof ProviderError) return cause;

  console.error("[codecrypto] the transaction could not be sent:", cause);

  return new ProviderError({
    code: ErrorCode.INTERNAL,
    message: "The wallet could not send this transaction.",
  });
}
