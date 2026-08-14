import { describe, expect, it, vi } from "vitest";

import type { PendingTxStore } from "@/lib/pending-txs";
import {
  FAST_PATH_DELAY_MS,
  TX_ALARM,
  TX_ALARM_PERIOD_MINUTES,
  createTxWatcher,
  type AlarmsPort,
} from "@/lib/tx-watcher";

/**
 * @param remaining what each successive reconcile() reports as still pending.
 *                  The last value repeats once the list runs out.
 */
function setup(remaining: number[] = [0]) {
  const created: Array<{ name: string; periodInMinutes: number }> = [];
  const cleared: string[] = [];
  const scheduled: Array<{ task: () => void; delayMs: number }> = [];

  let call = 0;
  const pendingTxs: PendingTxStore = {
    track: () => Promise.resolve(),
    read: () => Promise.resolve([]),
    reconcile: vi.fn(async () => remaining[Math.min(call++, remaining.length - 1)] ?? 0),
  };

  const alarms: AlarmsPort = {
    create: vi.fn(async (name, info) => {
      created.push({ name, ...info });
    }),
    clear: vi.fn(async (name) => {
      cleared.push(name);
    }),
  };

  const watcher = createTxWatcher({
    pendingTxs,
    alarms,
    schedule: (task, delayMs) => {
      scheduled.push({ task, delayMs });
    },
  });

  return { watcher, created, cleared, scheduled, pendingTxs, alarms };
}

describe("the alarm period", () => {
  /**
   * 🇪🇸 NOTA: 0.5 y no 1. Medido contra la documentación oficial de Chrome —
   * "setting delayInMinutes or periodInMinutes to less than 0.5 will not be
   * honored and will cause a warning"— y no contra `@types/chrome`, que es un
   * paquete de terceros. El minuto era cierto en las primeras versiones de MV3.
   */
  it("sits exactly at the floor Chrome honours", () => {
    expect(TX_ALARM_PERIOD_MINUTES).toBe(0.5);
    expect(TX_ALARM_PERIOD_MINUTES).toBeGreaterThanOrEqual(0.5);
  });
});

describe("sweep", () => {
  it("arms the alarm while something is still pending", async () => {
    const { watcher, created, cleared } = setup([2]);

    expect(await watcher.sweep()).toBe(2);
    expect(created).toEqual([{ name: TX_ALARM, periodInMinutes: TX_ALARM_PERIOD_MINUTES }]);
    expect(cleared).toEqual([]);
  });

  /**
   * ------------------------------------------------------------------------
   * THIS IS WHAT KEEPS AN ALARM FROM RUNNING FOREVER
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: una alarma cada treinta segundos que despierta al worker para no
   * hacer nada es gasto que nadie relaciona jamás con la wallet, porque no se
   * ve por ninguna parte. Se borra en cuanto no queda nada que vigilar.
   */
  it("clears the alarm the moment the last one resolves", async () => {
    const { watcher, created, cleared } = setup([0]);

    expect(await watcher.sweep()).toBe(0);
    expect(cleared).toEqual([TX_ALARM]);
    expect(created).toEqual([]);
  });

  it("clears it on the sweep that empties the list, not before", async () => {
    const { watcher, created, cleared } = setup([1, 0]);

    await watcher.sweep();
    expect(cleared).toEqual([]);
    expect(created).toHaveLength(1);

    await watcher.sweep();
    expect(cleared).toEqual([TX_ALARM]);
  });

  it("reconciles before deciding, never the other way round", async () => {
    const { watcher, pendingTxs } = setup([0]);

    await watcher.sweep();

    expect(pendingTxs.reconcile).toHaveBeenCalledTimes(1);
  });
});

describe("noteNewWork", () => {
  /**
   * 🇪🇸 NOTA: arma SIN reconciliar. Preguntar por el recibo de una transacción
   * difundida hace un milisegundo es una llamada garantizada a devolver null.
   */
  it("arms the net immediately without asking the chain", async () => {
    const { watcher, created, pendingTxs } = setup();

    await watcher.noteNewWork();

    expect(created).toEqual([{ name: TX_ALARM, periodInMinutes: TX_ALARM_PERIOD_MINUTES }]);
    expect(pendingTxs.reconcile).not.toHaveBeenCalled();
  });

  /**
   * ------------------------------------------------------------------------
   * THE FAST PATH IS A SHORTCUT, AND IT IS ALLOWED TO NEVER RUN
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: Anvil mina en un segundo y la alarma no baja de treinta, así que
   * sin el atajo el aviso local llegaría medio minuto tarde. Pero un
   * `setTimeout` NO mantiene vivo al worker: si Chrome lo suspende antes, el
   * temporizador muere y no queda rastro.
   *
   * Por eso el test comprueba las DOS cosas — que se programa, y que la alarma
   * ya está armada ANTES de programarlo. Si el atajo no corre, la red sigue
   * puesta y la transacción se resuelve igual, treinta segundos más tarde.
   */
  it("takes the shortcut, but only after the net is already in place", async () => {
    const { watcher, created, scheduled } = setup([0]);

    await watcher.noteNewWork();

    expect(created).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(FAST_PATH_DELAY_MS);
  });

  it("sweeps when the shortcut does run", async () => {
    const { watcher, scheduled, pendingTxs, cleared } = setup([0]);

    await watcher.noteNewWork();
    expect(pendingTxs.reconcile).not.toHaveBeenCalled();

    scheduled[0]?.task();
    await vi.waitFor(() => {
      expect(pendingTxs.reconcile).toHaveBeenCalledTimes(1);
    });

    // And it left the alarm matching reality, exactly like any other sweep.
    expect(cleared).toEqual([TX_ALARM]);
  });

  /** Losing the shortcut costs a delay, never an outcome. */
  it("leaves the alarm armed if the shortcut never runs", async () => {
    const { watcher, created, cleared } = setup([1]);

    await watcher.noteNewWork();
    // The worker died here: the scheduled task is simply never invoked.

    expect(created).toHaveLength(1);
    expect(cleared).toEqual([]);
  });

  it("does not let a failing shortcut escape", async () => {
    const complain = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { watcher, scheduled, pendingTxs } = setup();
    vi.mocked(pendingTxs.reconcile).mockRejectedValueOnce(new Error("the node is gone"));

    await watcher.noteNewWork();
    expect(() => scheduled[0]?.task()).not.toThrow();

    await vi.waitFor(() => {
      expect(complain).toHaveBeenCalled();
    });
  });
});
