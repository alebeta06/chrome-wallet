import { describe, expect, it } from "vitest";

import type { LogEntry, LogLevel } from "@/types/messages";
import {
  affectsLogs,
  collapseRepeats,
  filterByLevel,
  toRows,
} from "@/ui/hooks/log-view";

const DAPP = "https://dapp.example";
const OTHER = "https://other.example";

let nextId = 0;

function entry(
  label: string,
  options: { level?: LogLevel; origin?: string; ts?: number; detail?: unknown } = {},
): LogEntry {
  nextId += 1;
  const built: LogEntry = {
    id: `id-${nextId}`,
    ts: options.ts ?? nextId,
    level: options.level ?? "call",
    label,
  };
  if (options.origin !== undefined) built.origin = options.origin;
  if (options.detail !== undefined) built.detail = options.detail;
  return built;
}

describe("collapseRepeats", () => {
  it("leaves a single entry alone", () => {
    const rows = collapseRepeats([entry("eth_chainId", { origin: DAPP })]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
    expect(rows[0]?.label).toBe("eth_chainId");
  });

  it("collapses a run of identical entries into one row with a count", () => {
    const rows = collapseRepeats([
      entry("eth_chainId", { origin: DAPP }),
      entry("eth_chainId", { origin: DAPP }),
      entry("eth_chainId", { origin: DAPP }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
  });

  /**
   * ------------------------------------------------------------------------
   * THE TEST THAT SAYS "CONSECUTIVE" MEANS CONSECUTIVE
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: A, A, B, A son CUATRO cosas en TRES filas. Agrupar las tres A en
   * una sola diría que ocurrieron seguidas, y no ocurrieron: entre medias pasó
   * B. Un registro que reordena para agrupar deja de servir para lo único que
   * sirve un registro, que es reconstruir en qué orden pasaron las cosas.
   */
  it("does not collapse across something else", () => {
    const rows = collapseRepeats([
      entry("eth_chainId", { origin: DAPP }),
      entry("eth_chainId", { origin: DAPP }),
      entry("eth_accounts", { origin: DAPP }),
      entry("eth_chainId", { origin: DAPP }),
    ]);

    expect(rows.map((row) => [row.label, row.count])).toEqual([
      ["eth_chainId", 2],
      ["eth_accounts", 1],
      ["eth_chainId", 1],
    ]);
  });

  it("keeps two origins apart even when they ask the same thing", () => {
    const rows = collapseRepeats([
      entry("eth_chainId", { origin: DAPP }),
      entry("eth_chainId", { origin: OTHER }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.origin)).toEqual([DAPP, OTHER]);
  });

  it("keeps two levels apart even when the label matches", () => {
    const rows = collapseRepeats([
      entry("eth_sendTransaction", { level: "call", origin: DAPP }),
      entry("eth_sendTransaction", { level: "error", origin: DAPP }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.level)).toEqual(["call", "error"]);
  });

  it("does not merge an entry that has an origin with one that has none", () => {
    const rows = collapseRepeats([entry("chainChanged"), entry("chainChanged", { origin: DAPP })]);

    expect(rows).toHaveLength(2);
  });

  /** The key must not move when the run grows, or React remounts the row. */
  it("keys a run by its first entry and times it by its last", () => {
    const first = entry("eth_chainId", { origin: DAPP, ts: 100 });
    const last = entry("eth_chainId", { origin: DAPP, ts: 900 });

    const rows = collapseRepeats([first, last]);

    expect(rows[0]?.key).toBe(first.id);
    expect(rows[0]?.ts).toBe(900);
  });

  it("survives an empty log", () => {
    expect(collapseRepeats([])).toEqual([]);
  });
});

describe("filterByLevel", () => {
  const mixed = [
    entry("eth_chainId", { level: "call" }),
    entry("chainChanged", { level: "event" }),
    entry("transaction sent", { level: "operation" }),
    entry("eth_getBalance", { level: "error" }),
  ];

  it("returns everything when nothing is selected", () => {
    expect(filterByLevel(mixed, null)).toHaveLength(4);
  });

  /** One filter per spec: 13 calls, 14 events, 16 operations, 15 errors. */
  it.each<LogLevel>(["call", "event", "operation", "error"])("keeps only %s", (level) => {
    const kept = filterByLevel(mixed, level);

    expect(kept).toHaveLength(1);
    expect(kept[0]?.level).toBe(level);
  });
});

describe("toRows", () => {
  /**
   * 🇪🇸 NOTA: `toRows` invierte para pintar lo último arriba, y eso NO es
   * ordenar: no compara `ts` con nada. Hay un solo escritor, así que la posición
   * en el array es el orden real — y es más fiable que el reloj, porque
   * `Date.now()` tiene resolución de milisegundo y dos entradas del mismo
   * milisegundo saldrían intercambiadas.
   */
  it("shows the newest first without looking at the clock", () => {
    const rows = toRows(
      [
        entry("first", { ts: 5_000 }),
        // Same millisecond, and out of clock order on purpose: the array wins.
        entry("second", { ts: 1_000 }),
        entry("third", { ts: 1_000 }),
      ],
      null,
    );

    expect(rows.map((row) => row.label)).toEqual(["third", "second", "first"]);
  });

  it("filters before collapsing, so a filtered-out entry cannot split a run", () => {
    const rows = toRows(
      [
        entry("eth_chainId", { level: "call", origin: DAPP }),
        entry("chainChanged", { level: "event", origin: DAPP }),
        entry("eth_chainId", { level: "call", origin: DAPP }),
      ],
      "call",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);
  });

  it("renders an empty log as no rows at all", () => {
    expect(toRows([], null)).toEqual([]);
  });
});

describe("affectsLogs", () => {
  const change = { newValue: [], oldValue: [] };

  it("redraws when the log itself changed", () => {
    expect(affectsLogs({ "cc:logs": change }, "local")).toBe(true);
  });

  /**
   * ------------------------------------------------------------------------
   * THE OTHER HALF OF THE FILTER, AND WHY IT IS NOT DECORATION
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: `cc:pendingRequests` se escribe DOS veces por cada solicitud —al
   * crearla y al resolverla— y `cc:networks` en cada alta o cambio de red. Sin
   * la comprobación de la clave, cada una de esas escrituras volvería a leer el
   * registro entero y repintaría el panel sin que hubiera cambiado una sola
   * línea.
   *
   * (Esto prueba la DECISIÓN de repintar, no el repintado: aquí no hay jsdom, y
   * es la razón de que esta función viva fuera del componente.)
   */
  it.each(["cc:pendingRequests", "cc:networks", "cc:chainId", "cc:connectedSites"])(
    "does not redraw when %s changed",
    (key) => {
      expect(affectsLogs({ [key]: change }, "local")).toBe(false);
    },
  );

  it("redraws when the log changed alongside something else", () => {
    expect(affectsLogs({ "cc:networks": change, "cc:logs": change }, "local")).toBe(true);
  });

  /** The wallet never writes to sync, but the browser can still emit for it. */
  it("ignores another storage area", () => {
    expect(affectsLogs({ "cc:logs": change }, "sync")).toBe(false);
    expect(affectsLogs({ "cc:logs": change }, "session")).toBe(false);
  });

  it("ignores a change with nothing in it", () => {
    expect(affectsLogs({}, "local")).toBe(false);
  });
});
