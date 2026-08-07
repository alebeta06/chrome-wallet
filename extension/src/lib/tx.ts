/**
 * @file lib/tx.ts
 * @description Turning whatever a dApp sent into a transaction we are willing
 * to sign — or refusing, with a reason.
 *
 * Pure: no ethers, no storage, no chrome. Everything a dApp can put in a
 * transaction request is hostile input, and this is where it stops being that.
 */

import {
  ProviderErrors,
  type Address,
  type Hex,
} from "@/types/messages";

import { ProviderError, invalidParams } from "./errors";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;

/**
 * The fields a dApp may set. Anything else is refused rather than dropped.
 *
 * 🇪🇸 NOTA: lista blanca y no lista negra. Ignorar en silencio un campo que no
 * conocemos significa firmar algo distinto de lo que la dApp pidió, y la dApp
 * creería que se firmó lo suyo. Que exista `chainId` aquí sin usarse es
 * deliberado: se comprueba contra la red activa en vez de aceptarlo.
 */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "from",
  "to",
  "value",
  "data",
  "gas",
  "gasLimit",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "nonce",
  "chainId",
  "type",
]);

/** A request that has passed every check except "does the user approve?". */
export interface ParsedTransaction {
  /** Always resolved: the account this origin is allowed to sign with. */
  from: Address;
  /** Absent for a contract deployment, which this phase does not support. */
  to: Address;
  value: Hex;
  data: Hex;
  gas?: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
  /**
   * Phase 8, legacy chains only. Never parsed from a dApp: `TransactionRequest`
   * in the contract has no such field, so it stays in the unknown-field
   * rejection. The wallet fills it in when the chain cannot do EIP-1559.
   */
  gasPrice?: Hex;
  nonce?: Hex;
}

function requireHexQuantity(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) {
    throw invalidParams(`"${field}" must be a hex quantity like "0x1".`);
  }
  return value as Hex;
}

/**
 * Parses and authorises a transaction request.
 *
 * ---------------------------------------------------------------------------
 * THE `from` CHECK IS THE ONE THAT MATTERS
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: una dApp puede poner CUALQUIER `from`. Si no se comprueba contra la
 * cuenta que ese origen tiene autorizada, una web conectada a tu cuenta 0 podría
 * pedirte que firmes desde la cuenta 3 — y la ventana enseñaría la 3, y tú la
 * aprobarías porque la ventana lo dice. El permiso que diste era para una
 * cuenta, no para la wallet entera.
 *
 * Se rechaza con 4100 y SIN abrir ventana. Enseñar una ventana de firma para una
 * cuenta no autorizada entrena a la gente a leer y descartar avisos, que es
 * peor que no enseñar nada.
 *
 * Si `from` viene ausente, se rellena con la cuenta del origen: es lo que una
 * dApp bien escrita espera y no hay ambigüedad posible.
 */
export function parseTransactionRequest(
  params: unknown[],
  authorisedAccount: Address,
): ParsedTransaction {
  const [raw] = params;

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidParams("eth_sendTransaction expects a single transaction object.");
  }

  const tx = raw as Record<string, unknown>;

  const unknownField = Object.keys(tx).find((key) => !KNOWN_FIELDS.has(key));
  if (unknownField !== undefined) {
    throw invalidParams(`Unknown transaction field "${unknownField}".`);
  }

  // ---- from -------------------------------------------------------------
  if (tx.from !== undefined) {
    if (typeof tx.from !== "string" || !ADDRESS.test(tx.from)) {
      throw invalidParams('"from" must be a 20-byte hex address.');
    }
    if (tx.from.toLowerCase() !== authorisedAccount.toLowerCase()) {
      throw new ProviderError(
        ProviderErrors.unauthorized(
          `This site may only send transactions from ${authorisedAccount}.`,
        ),
      );
    }
  }

  // ---- to ---------------------------------------------------------------
  /**
   * 🇪🇸 NOTA: sin `to` es un DESPLIEGUE de contrato. No está en el alcance del
   * proyecto y firmarlo por accidente sería crear un contrato con los fondos del
   * usuario. Se rechaza explícitamente en vez de dejarlo pasar.
   */
  if (tx.to === undefined || tx.to === null) {
    throw invalidParams(
      'A "to" address is required. This wallet does not support contract deployment.',
    );
  }
  if (typeof tx.to !== "string" || !ADDRESS.test(tx.to)) {
    throw invalidParams('"to" must be a 20-byte hex address.');
  }

  // ---- data -------------------------------------------------------------
  /**
   * 🇪🇸 NOTA: el `data` tiene que ser un número PAR de dígitos hex. Un byte a
   * medias no es un calldata válido, y dejarlo pasar lo convierte en un fallo
   * del nodo después de que el usuario ya haya aprobado.
   */
  if (tx.data !== undefined && (typeof tx.data !== "string" || !HEX_DATA.test(tx.data))) {
    throw invalidParams('"data" must be hex with an even number of digits.');
  }

  // ---- the optional numbers ---------------------------------------------
  const optional = {
    ...(tx.value === undefined ? {} : { value: requireHexQuantity(tx.value, "value") }),
    ...(tx.gas === undefined ? {} : { gas: requireHexQuantity(tx.gas, "gas") }),
    ...(tx.gasLimit === undefined ? {} : { gas: requireHexQuantity(tx.gasLimit, "gasLimit") }),
    ...(tx.maxFeePerGas === undefined
      ? {}
      : { maxFeePerGas: requireHexQuantity(tx.maxFeePerGas, "maxFeePerGas") }),
    ...(tx.maxPriorityFeePerGas === undefined
      ? {}
      : {
          maxPriorityFeePerGas: requireHexQuantity(
            tx.maxPriorityFeePerGas,
            "maxPriorityFeePerGas",
          ),
        }),
    ...(tx.nonce === undefined ? {} : { nonce: requireHexQuantity(tx.nonce, "nonce") }),
  };

  return {
    from: authorisedAccount,
    to: tx.to as Address,
    value: (tx.value as Hex | undefined) ?? "0x0",
    data: (tx.data as Hex | undefined) ?? "0x",
    ...optional,
  };
}

/**
 * Does this transaction do something other than move ETH?
 *
 * 🇪🇸 NOTA: una transferencia de ETH y una llamada a contrato se ven IGUAL si
 * solo enseñas destino y cantidad. Y el caso peligroso es justo el que parece
 * inofensivo: `value: 0` con un `data` que aprueba a un tercero a vaciarte un
 * token. La ventana de firma tiene que poder distinguirlos.
 */
export function isContractCall(tx: Pick<ParsedTransaction, "data">): boolean {
  return tx.data !== "0x" && tx.data.length > 2;
}

/** The first four bytes of calldata: the function selector. */
export function functionSelector(tx: Pick<ParsedTransaction, "data">): Hex | null {
  return isContractCall(tx) && tx.data.length >= 10 ? (tx.data.slice(0, 10) as Hex) : null;
}
