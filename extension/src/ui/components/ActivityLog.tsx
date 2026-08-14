import { useState } from "react";

import { useLogs } from "@/ui/hooks/useLogs";
import { toRows, type LevelFilter } from "@/ui/hooks/log-view";

/**
 * 🇪🇸 NOTA: los cuatro valores de `LogLevel` son, uno a uno, las specs 13-16 —
 * llamadas, eventos, operaciones y errores. Por eso el filtro los lista los
 * cuatro en vez de ofrecer categorías inventadas: pulsándolos se demuestra cada
 * spec por separado, que es exactamente lo que hay que enseñar en el vídeo.
 */
const FILTERS: Array<{ value: LevelFilter; label: string }> = [
  { value: null, label: "All" },
  { value: "call", label: "Calls" },
  { value: "event", label: "Events" },
  { value: "operation", label: "Operations" },
  { value: "error", label: "Errors" },
];

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/**
 * The activity log (specs 13-16).
 *
 * 🇪🇸 NOTA: el color sale de `level`, y el registro guarda `level` y no un color.
 * Un cambio de paleta no puede obligar a reescribir historial — lo que quedó
 * escrito es qué CLASE de cosa pasó, y cómo se pinta es decisión de aquí y de
 * ahora. El rojo de los errores es la spec 15.
 */
export function ActivityLog() {
  const { entries, error } = useLogs();
  const [level, setLevel] = useState<LevelFilter>(null);
  const [hasCopied, setHasCopied] = useState(false);

  const rows = toRows(entries, level);

  async function copyAll(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(entries, null, 2));
      setHasCopied(true);
      setTimeout(() => setHasCopied(false), 1200);
    } catch {
      // Clipboard access can be denied; failing silently beats crashing the panel.
    }
  }

  return (
    <section className="stack stack--tight" data-testid="activity-log">
      <div className="row row--between">
        <h2>Activity</h2>
        <button
          type="button"
          className="button--ghost"
          onClick={() => void copyAll()}
          disabled={entries.length === 0}
          data-testid="activity-log-copy"
        >
          {hasCopied ? "Copied" : "Copy logs"}
        </button>
      </div>

      {error !== null && (
        <p className="banner banner--error" data-testid="activity-log-error">
          {error}
        </p>
      )}

      <div className="log-filters" data-testid="activity-log-filters">
        {FILTERS.map((filter) => (
          <button
            key={filter.value ?? "all"}
            type="button"
            className={`log-filter ${level === filter.value ? "log-filter--on" : ""}`}
            aria-pressed={level === filter.value}
            onClick={() => setLevel(filter.value)}
            data-testid={`activity-log-filter-${filter.value ?? "all"}`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {/*
        🇪🇸 NOTA: una wallet recién instalada no tiene ni la clave `cc:logs`. Eso
        no es un error ni un fallo de carga: es un registro vacío, y se dice con
        una frase en vez de con una lista de cero elementos que parecería que
        algo no cargó.
      */}
      {rows.length === 0 ? (
        <p className="log-empty" data-testid="activity-log-empty">
          {entries.length === 0
            ? "Nothing has happened yet."
            : "Nothing of this kind in the log."}
        </p>
      ) : (
        <ul className="log-list" data-testid="activity-log-list">
          {rows.map((row) => (
            <li
              key={row.key}
              className={`log-row log-row--${row.level}`}
              data-testid={`activity-log-row-${row.key}`}
            >
              <span className="log-row__level" data-testid={`activity-log-level-${row.key}`}>
                {row.level}
              </span>

              <span className="log-row__label">
                {row.label}
                {row.count > 1 && (
                  <span className="log-row__count" data-testid={`activity-log-count-${row.key}`}>
                    ×{row.count}
                  </span>
                )}
              </span>

              <span className="log-row__origin">{row.origin ?? "wallet"}</span>
              <span className="log-row__time">{timeOf(row.ts)}</span>

              {row.detail !== undefined && (
                <span className="log-row__detail" data-testid={`activity-log-detail-${row.key}`}>
                  {typeof row.detail === "string" ? row.detail : JSON.stringify(row.detail)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
