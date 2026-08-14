/**
 * @file lib/logs.ts
 * @description The activity log (`cc:logs`), base for specs 13-16.
 *
 * `cc:logs` is deliberately absent from `RESET_CLEARED_KEYS`, so the log
 * survives a `wallet_reset` (spec 24) — wiping the wallet is not the same as
 * erasing what happened.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT MATTERS
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: NUNCA se loguea el mnemonic, ni una clave, ni el payload de una
 * firma. Un registro es el sitio más fácil del mundo para filtrar un secreto,
 * porque se escribe una vez y se lee seis meses después.
 *
 * ---------------------------------------------------------------------------
 * ALLOWLIST, NOT DENYLIST. THIS IS THE PART THAT CHANGED
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: aquí hubo un `SECRET_PARAM_METHODS` — una lista de métodos cuyos
 * params no se escribían, y el resto pasaba tal cual. Eso es una denylist, y una
 * denylist es una apuesta a haber enumerado todos los casos.
 *
 * La apuesta se pierde por dónde no se mira. En `eth_signTypedData_v4` **el
 * nombre de los campos lo elige la dApp**: nada impide un payload con un campo
 * `userBackupPhrase`, o `notes`, o cualquier cosa. Ninguna lista de métodos
 * protege contra un nombre que aún no existe.
 *
 * Lo que hay ahora es estructural, no una lista:
 *
 *   1. `createLogEntry` copia SOLO los seis campos conocidos de `LogEntry`.
 *   2. `sanitizeDetail` deja pasar SOLO un objeto plano de escalares. Un payload
 *      de dApp es anidado por naturaleza —`types`, `domain`, `message`— así que
 *      no puede sobrevivir al filtro aunque alguien lo pase por error.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT GUARANTEE. SAY IT OUT LOUD
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: el filtro impide que pase una ESTRUCTURA, no que un llamador entregue
 * un secreto ya aplanado. `{ phrase: "doce palabras…" }` es un objeto plano de
 * escalares y se escribiría entero. El escritor no puede distinguir un chainId
 * de un mnemonic: los dos son strings.
 *
 * Por eso `detail` lo construye EXPLÍCITAMENTE cada llamador, campo a campo, con
 * lo que quiere enseñar —`method`, `chainId`, `accountIndex`— y nunca reenviando
 * lo que llegó de fuera. La regla es del llamador; el filtro es la red debajo.
 */

import { MAX_LOG_ENTRIES, type LogEntry, type LogLevel, type Origin } from "@/types/messages";

import { createSerializer } from "./serialize";
import type { WalletStorage } from "./storage";

/**
 * What may be written as the `detail` of an entry: one flat object of scalars.
 * Anything deeper is dropped, which is what keeps a dApp payload out.
 */
export type LogDetail = Record<string, string | number | boolean | null>;

/** Serialised `detail` is capped here, so one entry cannot eat the whole log. */
export const MAX_DETAIL_CHARS = 2048;

export const TRUNCATION_SUFFIX = "…[truncated]";

/** How many entries survive when the quota is hit. */
export const QUOTA_KEPT_ENTRIES = 100;

export interface LogWriter {
  /**
   * Writes one entry. NEVER rejects: see the note on `persist`.
   *
   * 🇪🇸 NOTA: una escritura de log no puede convertir una llamada correcta en un
   * error para la dApp, así que esto se traga todo lo que pueda fallar.
   */
  append(entry: LogEntry): Promise<void>;
}

/**
 * Copies the six known fields and nothing else.
 *
 * 🇪🇸 NOTA: los campos que el enunciado de la Fase 9 pedía sueltos —`method`,
 * `chainId`, `accountIndex`— viven dentro de `detail`, porque `LogEntry` es del
 * contrato inmutable y ya tiene la forma que las specs 13-16 necesitan: `level`
 * dice de qué clase es la línea y `label` qué pasó. Añadir un eje de severidad
 * aparte no lo pide ninguna spec — el rojo de la spec 15 es `level === "error"`.
 */
export function createLogEntry(
  level: LogLevel,
  label: string,
  origin?: Origin,
  detail?: LogDetail,
): LogEntry {
  const entry: LogEntry = { id: crypto.randomUUID(), ts: Date.now(), level, label };
  if (origin !== undefined) entry.origin = origin;
  if (detail !== undefined) entry.detail = detail;
  return entry;
}

/**
 * Keeps the scalar-valued keys and drops everything else.
 *
 * 🇪🇸 NOTA: devolver `undefined` cuando no queda nada es deliberado. Un
 * `detail: {}` en el registro sugiere que había algo y se perdió; no haber
 * escrito nada es la verdad.
 */
export function sanitizeDetail(detail: unknown): LogDetail | undefined {
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return undefined;

  const safe: LogDetail = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      safe[key] = value as string | number | boolean | null;
    }
  }

  return Object.keys(safe).length === 0 ? undefined : safe;
}

/**
 * Caps the serialised `detail`, falling back to a truncated string.
 *
 * 🇪🇸 NOTA: al truncar se guarda la forma SERIALIZADA y no el objeto, porque un
 * objeto recortado a medias miente sobre lo que había — parecería que esos eran
 * todos los campos. Una cadena que acaba en `…[truncated]` dice que falta algo.
 */
export function capDetail(detail: LogDetail | undefined): unknown {
  if (detail === undefined) return undefined;

  const serialized = JSON.stringify(detail);
  if (serialized.length <= MAX_DETAIL_CHARS) return detail;

  return serialized.slice(0, MAX_DETAIL_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/** Chrome reports a full storage area through the message, not a typed error. */
function isQuotaError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.toUpperCase().includes("QUOTA");
}

/**
 * The single writer of `cc:logs`.
 *
 * ---------------------------------------------------------------------------
 * APPENDING IS A READ-MODIFY-WRITE, AND IT GOES THROUGH THE CHAIN
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: `cc:logs` es un array entero en una sola clave. Añadir una línea es
 * leer, empujar y escribir, y `chrome.runtime.onMessage` despacha CONCURRENTE:
 * dos llamadas del provider a la vez leen el mismo array y la segunda escritura
 * se lleva por delante a la primera. La cadena de `serialize.ts` las pone en
 * fila, y por eso este módulo es una fábrica y no un puñado de funciones
 * sueltas: la cadena tiene que vivir en un closure, uno por dueño.
 *
 * Aquí había escrito lo contrario —que perder una línea de vez en cuando era
 * aceptable porque serializar habría sido estado que el worker se lleva al
 * dormirse—. Las dos mitades de aquel argumento eran falsas. Que la cadena no
 * sobreviva al reinicio del worker es CORRECTO, no una pega: si el worker murió,
 * no hay escrituras en vuelo contra las que serializar. Mismo razonamiento que
 * el Map de esperantes de `approvals.ts`.
 *
 * Y un registro que pierde líneas en concurrencia es peor que uno que no
 * existe: las pierde justo cuando más pasa a la vez, que es exactamente el
 * momento que alguien va a querer reconstruir después.
 */
export function createLogWriter(storage: WalletStorage): LogWriter {
  const serialize = createSerializer();

  /**
   * ------------------------------------------------------------------------
   * THE LOG NEVER TAKES A WALLET OPERATION DOWN WITH IT
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: si la escritura falla por cuota, se poda a las últimas
   * `QUOTA_KEPT_ENTRIES` y se reintenta UNA vez. Si vuelve a fallar, va a
   * consola y se sigue. En ningún camino se propaga el error: una firma correcta
   * no puede convertirse en un fallo para la dApp porque el registro esté lleno.
   */
  async function persist(next: LogEntry[]): Promise<void> {
    try {
      await storage.set("cc:logs", next);
      return;
    } catch (cause) {
      if (!isQuotaError(cause)) {
        console.error("[codecrypto] could not write to the activity log:", cause);
        return;
      }

      try {
        await storage.set("cc:logs", next.slice(-QUOTA_KEPT_ENTRIES));
      } catch (retryCause) {
        console.error("[codecrypto] the activity log is full and could not be pruned:", retryCause);
      }
    }
  }

  async function append(entry: LogEntry): Promise<void> {
    const capped = capDetail(sanitizeDetail(entry.detail));

    const safe: LogEntry = { id: entry.id, ts: entry.ts, level: entry.level, label: entry.label };
    if (entry.origin !== undefined) safe.origin = entry.origin;
    if (capped !== undefined) safe.detail = capped;

    return serialize(async () => {
      const existing = (await storage.get("cc:logs")) ?? [];
      const next = [...existing, safe];

      await persist(
        next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next,
      );
    });
  }

  return { append };
}
