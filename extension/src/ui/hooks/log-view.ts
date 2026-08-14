/**
 * @file ui/hooks/log-view.ts
 * @description Turning `cc:logs` into rows, with no React in the way.
 *
 * 🇪🇸 NOTA: vive fuera del componente por el mismo motivo que `balance-poller.ts`
 * — y no por elegancia. Aquí no hay jsdom (`vitest.config.ts` fija
 * `environment: "node"` a propósito), así que la única forma de que el colapso y
 * el filtro de re-render tengan un test que pueda ponerse ROJO es que sean
 * funciones puras. Dentro de un `.tsx` no serían comprobables en absoluto.
 */

import type { LogEntry, LogLevel } from "@/types/messages";

/** One rendered line: an entry, plus how many identical ones followed it. */
export interface LogRow {
  /** Stable across re-reads: the id of the FIRST entry of the run. */
  key: string;
  level: LogLevel;
  label: string;
  origin?: string;
  detail?: unknown;
  /** The most recent occurrence of the run. */
  ts: number;
  /** 1 when nothing was collapsed. */
  count: number;
}

/** The filter the panel offers. `null` means "everything". */
export type LevelFilter = LogLevel | null;

/**
 * ---------------------------------------------------------------------------
 * CONSECUTIVE, AND CONSECUTIVE MEANS CONSECUTIVE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: se colapsan entradas IGUALES Y SEGUIDAS, nunca saltándose lo que
 * haya en medio. Con A, A, B, A el panel enseña cuatro cosas en tres filas
 * —A×2, B, A—, no "A×3 y B".
 *
 * Agrupar salteado convertiría el registro en un recuento y le quitaría lo
 * único que lo hace útil para reconstruir un fallo: el ORDEN. "Pidió saldo dos
 * veces, luego firmó, luego volvió a pedir saldo" y "pidió saldo tres veces y
 * firmó" son dos historias distintas, y la segunda no ocurrió.
 *
 * El colapso es SOLO de pintado. En el escritor no se descarta nada nunca: lo
 * que está en `cc:logs` está entero, y esto solo decide cómo se enseña.
 */
export function collapseRepeats(entries: LogEntry[]): LogRow[] {
  const rows: LogRow[] = [];

  for (const entry of entries) {
    const previous = rows[rows.length - 1];

    if (
      previous !== undefined &&
      previous.level === entry.level &&
      previous.label === entry.label &&
      previous.origin === entry.origin
    ) {
      previous.count += 1;
      // The run is shown at its most recent occurrence, which is what someone
      // reading "×4" wants to know: when it last happened, not when it started.
      previous.ts = entry.ts;
      if (entry.detail !== undefined) previous.detail = entry.detail;
      continue;
    }

    rows.push({
      key: entry.id,
      level: entry.level,
      label: entry.label,
      ...(entry.origin === undefined ? {} : { origin: entry.origin }),
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      ts: entry.ts,
      count: 1,
    });
  }

  return rows;
}

export function filterByLevel(entries: LogEntry[], level: LevelFilter): LogEntry[] {
  return level === null ? entries : entries.filter((entry) => entry.level === level);
}

/**
 * ---------------------------------------------------------------------------
 * ORDER COMES FROM THE ARRAY, NEVER FROM `ts`
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: `toRows` NO ordena. Hay un único escritor —el service worker—, así
 * que la posición en el array ES el orden en que ocurrieron las cosas, y es más
 * fiable que el reloj: `Date.now()` tiene resolución de milisegundo y dos
 * entradas del mismo milisegundo saldrían intercambiadas respecto a como
 * pasaron. Un registro que miente sobre el orden no sirve para reconstruir nada.
 *
 * Lo de abajo es un `reverse`, que no es lo mismo que ordenar: no compara nada,
 * solo pinta el array al revés para que lo último quede arriba. Si el array
 * está bien, el reverso está bien.
 */
export function toRows(entries: LogEntry[], level: LevelFilter): LogRow[] {
  return collapseRepeats(filterByLevel(entries, level)).reverse();
}

/**
 * Whether a storage change is one the activity panel has to redraw for.
 *
 * 🇪🇸 NOTA: las DOS mitades del filtro cargan peso. Sin `areaName === "local"`
 * entrarían cambios de `sync`, que la wallet no usa pero el navegador sí puede
 * emitir. Y sin la comprobación de la clave, CADA escritura de
 * `cc:pendingRequests` —una por cada solicitud que se crea y se resuelve— o de
 * `cc:networks` volvería a leer y repintar el panel entero sin que haya cambiado
 * una sola línea del registro.
 *
 * Mismo filtro de dos mitades que `useWalletState`, que escucha las suyas.
 */
export function affectsLogs(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): boolean {
  return areaName === "local" && changes["cc:logs"] !== undefined;
}
