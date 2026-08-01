/**
 * @file lib/logs.ts
 * @description The activity log (`cc:logs`), base for specs 13-16.
 *
 * This phase only accumulates entries; the UI that renders them is phase 9.
 * `cc:logs` is deliberately absent from `RESET_CLEARED_KEYS`, so the log
 * survives a `wallet_reset` (spec 24) — wiping the wallet is not the same as
 * erasing what happened.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT MATTERS
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: NUNCA se loguea el mnemonic, ni una clave, ni los params de una
 * firma. En esta fase no existe la firma todavía, y por eso mismo la regla se
 * establece AHORA: cuando llegue la Fase 6 el sitio donde se decide qué se
 * escribe ya existe, ya tiene un test que lo fija, y nadie tiene que acordarse
 * de nada. Un registro es el sitio más fácil del mundo para filtrar una clave,
 * porque se escribe una vez y se lee seis meses después.
 */

import {
  MAX_LOG_ENTRIES,
  isPublicMethod,
  type LogEntry,
  type LogLevel,
  type Origin,
} from "@/types/messages";

import type { WalletStorage } from "./storage";

const REDACTED = "[redacted]";

/**
 * Methods whose params are secret by nature.
 *
 * 🇪🇸 NOTA: no se reutiliza `APPROVAL_REQUIRED_METHODS` del contrato, que
 * también incluye `eth_requestAccounts` y `wallet_addEthereumChain`. Son
 * conjuntos distintos con una intersección grande: uno responde "¿necesita que
 * el usuario apruebe?" y este otro "¿lleva algo que no debe quedar escrito?".
 * Fundirlos haría que añadir un método a uno cambiara silenciosamente el otro.
 */
const SECRET_PARAM_METHODS: ReadonlySet<string> = new Set([
  "eth_sendTransaction",
  "eth_signTypedData_v4",
]);

/**
 * What may be written to the log as the `detail` of a call.
 *
 * The second branch is the belt to the braces: only page-originated calls are
 * logged today, so an internal method cannot reach this function anyway. If that
 * ever changes, `wallet_importMnemonic` still does not get its phrase written to
 * disk — and the check is a set lookup.
 */
export function redactParams(method: string, params: unknown[]): unknown {
  if (SECRET_PARAM_METHODS.has(method)) return REDACTED;
  if (!isPublicMethod(method)) return REDACTED;
  return params;
}

export function createLogEntry(
  level: LogLevel,
  label: string,
  origin?: Origin,
  detail?: unknown,
): LogEntry {
  const entry: LogEntry = { id: crypto.randomUUID(), ts: Date.now(), level, label };
  if (origin !== undefined) entry.origin = origin;
  if (detail !== undefined) entry.detail = detail;
  return entry;
}

/**
 * Appends one entry, keeping at most `MAX_LOG_ENTRIES`, oldest dropped first.
 *
 * ---------------------------------------------------------------------------
 * KNOWN GAP: this is a read-modify-write
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: `chrome.storage.local` no tiene transacciones. Dos llamadas del
 * provider que caigan a la vez leen el mismo array y la segunda escritura pisa
 * la primera, así que se pierde una entrada. Se asume a conciencia: esto es un
 * registro de diagnóstico, no un libro contable, y la alternativa —una cola
 * serializada— sería estado a nivel de módulo, que es justo lo que el service
 * worker se lleva por delante al dormirse. Perder una línea de log de vez en
 * cuando es mejor que un registro que miente después de una suspensión.
 */
export async function appendLog(storage: WalletStorage, entry: LogEntry): Promise<void> {
  const existing = (await storage.get("cc:logs")) ?? [];
  const next = [...existing, entry];

  await storage.set(
    "cc:logs",
    next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next,
  );
}
