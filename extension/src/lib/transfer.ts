/**
 * @file lib/transfer.ts
 * @description Parsing and authorising a transfer between the user's own
 * accounts (spec 25).
 *
 * ---------------------------------------------------------------------------
 * NO APPROVAL WINDOW, AND THE REASON IS THE RULE FOR THE WHOLE PROJECT
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: las ventanas de aprobación protegen al usuario DE LAS dApps, no de sí
 * mismo. Aquí no hay tercero: es el dueño de la wallet moviendo su dinero entre
 * sus propias cuentas, desde su propia UI. Una ventana pidiéndole permiso para
 * lo que acaba de pulsar no añade seguridad — añade un clic que enseña a
 * aprobar sin leer, que es exactamente el hábito que las ventanas existen para
 * no crear.
 *
 * Es la misma regla que la Fase 8 aplicó al alta manual de redes.
 *
 * ---------------------------------------------------------------------------
 * THE PARSING IS HERE; THE SENDING IS NOT
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: este módulo NO envía. Devuelve una transacción ya validada y quien la
 * firma es `signBroadcastAndRecord`, el mismo punto por el que pasa una
 * `eth_sendTransaction` de una dApp.
 *
 * Un `sender.send` propio aquí sería el gotcha 7.8 de vuelta: la cola que
 * serializa los envíos vive en la instancia del firmante, así que un segundo
 * camino de firma significa que una transferencia interna y una transacción de
 * dApp lanzadas a la vez piden el nonce en paralelo, cogen el mismo, y la
 * segunda muere con `replacement transaction underpriced`.
 */

import type { Address, Hex } from "@/types/messages";

import { invalidParams } from "./errors";

const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;

export interface InternalTransfer {
  fromIndex: number;
  toIndex: number;
  valueWei: Hex;
}

function requireIndex(value: unknown, field: string, accountCount: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidParams(`"${field}" must be an account index.`);
  }

  /**
   * 🇪🇸 NOTA: contra `accountCount` y no contra un tope fijo.
   * `noUncheckedIndexedAccess` está desactivado en este proyecto, así que
   * `accounts[7]` con cinco cuentas compila y devuelve `undefined` — y firmar
   * desde `undefined` reventaría mucho más abajo, con un mensaje que no se
   * parece en nada al problema.
   */
  if (value < 0 || value >= accountCount) {
    throw invalidParams(`"${field}" is not one of this wallet's accounts.`);
  }

  return value;
}

/**
 * Reads the params of `wallet_internalTransfer` and refuses anything odd.
 *
 * 🇪🇸 NOTA: el importe se valida aquí solo en lo ESTRUCTURAL —que sea una
 * cantidad hexadecimal mayor que cero—. Que quepa en el saldo una vez restada la
 * fee se comprueba más arriba, cuando ya se conoce la fee real, y con la misma
 * función que usa el formulario (`validateAmountWei`). Dos restas distintas para
 * la misma regla acabarían discrepando.
 */
export function parseInternalTransfer(params: unknown[], accountCount: number): InternalTransfer {
  const [raw] = params;

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidParams("wallet_internalTransfer expects a single object.");
  }

  const input = raw as Record<string, unknown>;

  const fromIndex = requireIndex(input.fromIndex, "fromIndex", accountCount);
  const toIndex = requireIndex(input.toIndex, "toIndex", accountCount);

  /**
   * 🇪🇸 NOTA: mandarse dinero a uno mismo no es un error de la cadena —la
   * transacción sería válida y se minaría— pero sí es una petición sin sentido
   * que solo quema gas. Se rechaza aquí para que el desplegable de la UI y el
   * background digan lo mismo.
   */
  if (fromIndex === toIndex) {
    throw invalidParams("Choose a different account to send to.");
  }

  if (typeof input.valueWei !== "string" || !HEX_QUANTITY.test(input.valueWei)) {
    throw invalidParams('"valueWei" must be a hex quantity like "0x1".');
  }
  if (BigInt(input.valueWei) <= 0n) {
    throw invalidParams("Send an amount greater than zero.");
  }

  return { fromIndex, toIndex, valueWei: input.valueWei as Hex };
}

/** The transaction shape the shared signing path expects. */
export function transferTransaction(
  accounts: Address[],
  { fromIndex, toIndex, valueWei }: InternalTransfer,
): { from: Address; to: Address; value: Hex; data: Hex } {
  return {
    from: accounts[fromIndex] as Address,
    to: accounts[toIndex] as Address,
    value: valueWei,
    // A plain value transfer carries no calldata, and saying so is not the same
    // as leaving it undefined for the signer to guess.
    data: "0x",
  };
}
