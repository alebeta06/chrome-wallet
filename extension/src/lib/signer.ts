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

import { JsonRpcProvider, toBeHex, type TransactionResponse } from "ethers";

import { ErrorCode, type Hex, type NetworkConfig } from "@/types/messages";

import { ProviderError } from "./errors";
import { deriveSigner } from "./hd-wallet";
import type { ParsedTransaction } from "./tx";

/** The slice of an ethers provider this module needs. */
export interface ChainWriter {
  /**
   * 🇪🇸 NOTA: `getTransactionCount` y no `getNonce`. En ethers v6 `getNonce` es
   * un método del Signer, no del Provider — y el signer NO se conecta al
   * provider aquí a propósito: firma sin red y el envío es un paso aparte.
   */
  getTransactionCount(address: string, blockTag: "pending"): Promise<number>;
  getFeeData(): Promise<{ maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null }>;
  estimateGas(tx: Record<string, unknown>): Promise<bigint>;
  broadcast(signed: string): Promise<TransactionResponse>;
  destroy(): void;
}

export interface FeeEstimate {
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  gas: Hex;
}

export interface SendInput {
  network: NetworkConfig;
  phrase: string;
  accountIndex: number;
  transaction: ParsedTransaction;
}

export interface TransactionSender {
  /** Signs and broadcasts. Resolves with the transaction hash. */
  send(input: SendInput): Promise<Hex>;
  /** Best-effort numbers for the approval window. Never throws. */
  estimate(input: Omit<SendInput, "phrase" | "accountIndex">): Promise<FeeEstimate | null>;
}

export type ChainWriterFactory = (network: NetworkConfig) => ChainWriter;

/**
 * 🇪🇸 NOTA: mismas opciones que `chain.ts` y por los mismos motivos —
 * `batchMaxCount: 1` porque dRPC rechaza los batches, `staticNetwork: true` para
 * no añadir un `eth_chainId` de validación a cada llamada en un worker que
 * arranca de cero constantemente.
 */
export const createChainWriter: ChainWriterFactory = (network) => {
  const provider = new JsonRpcProvider(network.rpcUrl, undefined, {
    batchMaxCount: 1,
    staticNetwork: true,
  });

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

  return { send, estimate };
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
        : await writer.getTransactionCount(transaction.from, "pending");

    const feeData = await writer.getFeeData();
    const fees = resolveFees(transaction, feeData);
    if (fees === null) {
      throw new ProviderError({
        code: ErrorCode.CHAIN_DISCONNECTED,
        message: `Cannot get a gas price from ${network.name}.`,
      });
    }

    const gas =
      transaction.gas ??
      (toBeHex(
        await writer.estimateGas({
          from: transaction.from,
          to: transaction.to,
          value: transaction.value,
          data: transaction.data,
        }),
      ) as Hex);

    /**
     * 🇪🇸 NOTA: `type: 2` explícito, no confiado a la inferencia. Ethers suele
     * acertar, pero "suele" no es una garantía y una transacción legacy en una
     * red EIP-1559 paga de más y puede quedarse atascada. Se comprueba en el
     * recibo durante las comprobaciones manuales.
     */
    const signed = await wallet.signTransaction({
      type: 2,
      chainId: BigInt(network.chainId),
      to: transaction.to,
      value: BigInt(transaction.value),
      data: transaction.data,
      nonce,
      gasLimit: BigInt(gas),
      maxFeePerGas: BigInt(fees.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGas),
    });

    const response = await writer.broadcast(signed);
    return response.hash as Hex;
  } catch (cause) {
    throw toSendError(cause, network);
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
 */
function resolveFees(
  transaction: ParsedTransaction,
  feeData: { maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null },
): { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } | null {
  const maxFeePerGas =
    transaction.maxFeePerGas ??
    (feeData.maxFeePerGas === null ? null : (toBeHex(feeData.maxFeePerGas) as Hex));

  const maxPriorityFeePerGas =
    transaction.maxPriorityFeePerGas ??
    (feeData.maxPriorityFeePerGas === null ? null : (toBeHex(feeData.maxPriorityFeePerGas) as Hex));

  if (maxFeePerGas === null || maxPriorityFeePerGas === null) return null;
  return { maxFeePerGas, maxPriorityFeePerGas };
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
 * Los mensajes se escriben aquí en vez de reenviar el de ethers porque
 * `toSerializedError` redacta cualquier error no tipado a un -32603 genérico
 * cuando el que pregunta es una web — con razón, porque un error de ethers puede
 * llevar dentro la rpcUrl con su API key.
 */
function toSendError(cause: unknown, network: NetworkConfig): ProviderError {
  if (cause instanceof ProviderError) return cause;

  console.error("[codecrypto] the transaction could not be sent:", cause);

  const code = (cause as { code?: unknown }).code;

  switch (code) {
    case "INSUFFICIENT_FUNDS":
      return new ProviderError({
        code: ErrorCode.INTERNAL,
        message: "Not enough ETH in this account to cover the value plus gas.",
      });

    case "NONCE_EXPIRED":
    case "REPLACEMENT_UNDERPRICED":
      return new ProviderError({
        code: ErrorCode.INTERNAL,
        message: "Another transaction from this account is already in flight. Try again.",
      });

    case "CALL_EXCEPTION":
    case "UNPREDICTABLE_GAS_LIMIT":
      return new ProviderError({
        code: ErrorCode.INTERNAL,
        message: "The transaction would fail on-chain, so it was not sent.",
      });

    case "NETWORK_ERROR":
    case "SERVER_ERROR":
    case "TIMEOUT":
      return new ProviderError({
        code: ErrorCode.CHAIN_DISCONNECTED,
        message: `Cannot reach the RPC endpoint for ${network.name}.`,
      });

    default:
      return new ProviderError({
        code: ErrorCode.INTERNAL,
        message: "The wallet could not send this transaction.",
      });
  }
}
