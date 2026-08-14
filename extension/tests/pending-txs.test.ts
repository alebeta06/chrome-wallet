import { describe, expect, it, vi } from "vitest";

import { pendingTxKey, type Hex, type LogEntry, type PendingTx } from "@/types/messages";
import type { ReceiptReader, TxReceipt } from "@/lib/chain";
import { createLogWriter } from "@/lib/logs";
import type { Notifier } from "@/lib/notifications";
import { MAX_PENDING_TX_AGE_MS, createPendingTxStore } from "@/lib/pending-txs";
import { defaultNetworks, ANVIL_CHAIN_ID } from "@/lib/networks";
import { createWalletStorage } from "@/lib/storage";
import { createMemoryStorageArea, type MemoryStorageArea } from "./helpers/memory-storage-area";

const HASH = "0xaaaa000000000000000000000000000000000000000000000000000000000001" as Hex;
const OTHER_HASH = "0xbbbb000000000000000000000000000000000000000000000000000000000002" as Hex;
const DAPP = "https://dapp.example";
const NOW = 1_000_000;

const ANVIL = defaultNetworks().find((network) => network.chainId === ANVIL_CHAIN_ID)!;

function entry(overrides: Partial<PendingTx> = {}): PendingTx {
  return {
    hash: HASH,
    chainId: ANVIL_CHAIN_ID,
    sentAt: NOW,
    accountIndex: 0,
    origin: DAPP,
    ...overrides,
  };
}

interface Options {
  /** What the node answers. A function so it can differ per hash. */
  receipt?: (hash: Hex) => TxReceipt | null;
  /** The node does not answer at all. */
  unreachable?: boolean;
  /** The user deleted the network this transaction was sent on. */
  networkGone?: boolean;
  now?: number;
  seed?: Record<string, PendingTx>;
}

function setup(options: Options = {}) {
  const area = createMemoryStorageArea(
    options.seed === undefined ? {} : { "cc:pendingTxs": options.seed },
  );
  const storage = createWalletStorage(area);

  const announced: Array<{ hash: string; confirmed: boolean }> = [];
  const notifier: Notifier = {
    announce: () => Promise.resolve(),
    dismiss: () => Promise.resolve(),
    announceTransaction: vi.fn(async (hash, confirmed) => {
      announced.push({ hash, confirmed });
    }),
  };

  const readReceipt: ReceiptReader = vi.fn(async (_network, hash) => {
    if (options.unreachable === true) throw new Error("Cannot reach the RPC endpoint");
    return options.receipt?.(hash as Hex) ?? null;
  });

  const store = createPendingTxStore({
    storage,
    logs: createLogWriter(storage),
    notifier,
    readReceipt,
    networkFor: async () => (options.networkGone === true ? null : ANVIL),
    now: () => options.now ?? NOW,
  });

  return { area, store, announced, readReceipt };
}

function stored(area: MemoryStorageArea): Record<string, PendingTx> {
  return (area.snapshot()["cc:pendingTxs"] as Record<string, PendingTx> | undefined) ?? {};
}

function logs(area: MemoryStorageArea): LogEntry[] {
  return (area.snapshot()["cc:logs"] as LogEntry[] | undefined) ?? [];
}

describe("track", () => {
  it("records a broadcast transaction under its composite key", async () => {
    const { area, store } = setup();

    await store.track(entry());

    expect(Object.keys(stored(area))).toEqual([pendingTxKey(ANVIL_CHAIN_ID, HASH)]);
  });

  /**
   * 🇪🇸 NOTA: la misma clave en dos redes son DOS entradas. Es la mitad del
   * motivo de que la clave sea compuesta — la otra mitad es que el chainId hace
   * falta igualmente para saber a qué nodo preguntar.
   */
  it("keeps the same hash on two chains apart", async () => {
    const { area, store } = setup();

    await store.track(entry());
    await store.track(entry({ chainId: "0xaa36a7" }));

    expect(Object.keys(stored(area))).toHaveLength(2);
  });

  /** No await between them: onMessage dispatches concurrently. */
  it("does not lose one of two transactions broadcast at once", async () => {
    const { area, store } = setup();

    await Promise.all([store.track(entry()), store.track(entry({ hash: OTHER_HASH }))]);

    expect(Object.keys(stored(area))).toHaveLength(2);
  });
});

describe("reconcile", () => {
  /**
   * ------------------------------------------------------------------------
   * null IS NOT status 0. THIS IS THE TEST THAT SAYS SO
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: `null` significa "el nodo no la conoce todavía" y puede minarse
   * dentro de diez segundos. Tratarlo como fallo le diría al usuario que algo
   * salió mal antes de que haya salido nada.
   */
  it("leaves an unmined transaction alone, with no log and no toast", async () => {
    const { area, store, announced } = setup({
      seed: { [pendingTxKey(ANVIL_CHAIN_ID, HASH)]: entry() },
      receipt: () => null,
    });

    const stillPending = await store.reconcile();

    expect(stillPending).toBe(1);
    expect(Object.keys(stored(area))).toHaveLength(1);
    expect(announced).toEqual([]);
    expect(logs(area)).toEqual([]);
  });

  it("confirms a mined transaction, notifies, logs and forgets it", async () => {
    const { area, store, announced } = setup({
      seed: { [pendingTxKey(ANVIL_CHAIN_ID, HASH)]: entry() },
      receipt: () => ({ status: 1, blockNumber: 42 }),
    });

    const stillPending = await store.reconcile();

    expect(stillPending).toBe(0);
    expect(stored(area)).toEqual({});
    expect(announced).toEqual([{ hash: HASH, confirmed: true }]);

    const [line] = logs(area);
    expect(line?.level).toBe("operation");
    expect(line?.label).toBe("transaction confirmed");
    expect(line?.origin).toBe(DAPP);
    expect(line?.detail).toMatchObject({ hash: HASH, accountIndex: 0, blockNumber: 42 });
  });

  /**
   * 🇪🇸 NOTA: revertida NO es lo mismo que sin minar ni que confirmada. Gastó gas
   * y está en la cadena. Se avisa, se registra distinto, y se deja de vigilar —
   * ya terminó.
   */
  it("tells a reverted transaction apart from a confirmed one", async () => {
    const { area, store, announced } = setup({
      seed: { [pendingTxKey(ANVIL_CHAIN_ID, HASH)]: entry() },
      receipt: () => ({ status: 0, blockNumber: 43 }),
    });

    const stillPending = await store.reconcile();

    expect(stillPending).toBe(0);
    expect(stored(area)).toEqual({});
    expect(announced).toEqual([{ hash: HASH, confirmed: false }]);
    expect(logs(area)[0]?.label).toBe("transaction reverted");
  });

  /**
   * 🇪🇸 NOTA: el nodo no contesta, así que NO SABEMOS NADA. Ni línea ni aviso: un
   * parpadeo del RPC no es información sobre la transacción. Misma regla que la
   * Fase 8 con el nodo caído.
   */
  it("keeps waiting when the node does not answer, silently", async () => {
    const { area, store, announced } = setup({
      seed: { [pendingTxKey(ANVIL_CHAIN_ID, HASH)]: entry() },
      unreachable: true,
    });

    const stillPending = await store.reconcile();

    expect(stillPending).toBe(1);
    expect(Object.keys(stored(area))).toHaveLength(1);
    expect(announced).toEqual([]);
    expect(logs(area)).toEqual([]);
  });

  it("keeps waiting when the user deleted the network it was sent on", async () => {
    const { area, store } = setup({
      seed: { [pendingTxKey(ANVIL_CHAIN_ID, HASH)]: entry() },
      networkGone: true,
    });

    expect(await store.reconcile()).toBe(1);
    expect(Object.keys(stored(area))).toHaveLength(1);
  });

  it("does nothing at all when there is nothing pending", async () => {
    const { store, readReceipt } = setup();

    expect(await store.reconcile()).toBe(0);
    expect(readReceipt).not.toHaveBeenCalled();
  });

  it("resolves several transactions in one pass", async () => {
    const { area, store } = setup({
      seed: {
        [pendingTxKey(ANVIL_CHAIN_ID, HASH)]: entry(),
        [pendingTxKey(ANVIL_CHAIN_ID, OTHER_HASH)]: entry({ hash: OTHER_HASH }),
      },
      receipt: (hash) => (hash === HASH ? { status: 1, blockNumber: 1 } : null),
    });

    expect(await store.reconcile()).toBe(1);
    expect(Object.keys(stored(area))).toEqual([pendingTxKey(ANVIL_CHAIN_ID, OTHER_HASH)]);
  });
});

describe("giving up after an hour", () => {
  /**
   * ------------------------------------------------------------------------
   * STOPPED TRACKING, NOT FAILED
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: la transacción puede seguir en la mempool y minarse mañana. Si el
   * registro dijera "failed", el usuario tendría fondos movidos y una línea
   * afirmando lo contrario. Lo que ha pasado es que la WALLET deja de mirar.
   */
  it("leaves a line saying the wallet stopped watching, not that it failed", async () => {
    const { area, store } = setup({
      seed: { [pendingTxKey(ANVIL_CHAIN_ID, HASH)]: entry() },
      receipt: () => null,
      now: NOW + MAX_PENDING_TX_AGE_MS,
    });

    expect(await store.reconcile()).toBe(0);
    expect(stored(area)).toEqual({});

    const [line] = logs(area);
    expect(line?.label).toBe("stopped tracking transaction");
    expect(line?.label).not.toContain("fail");
    expect(line?.level).toBe("operation");
    expect(line?.detail).toMatchObject({ hash: HASH, waitedMinutes: 60 });
  });

  /** Nothing happened TO THE USER, so nothing is announced. */
  it("does not notify when it gives up", async () => {
    const { announced, store } = setup({
      seed: { [pendingTxKey(ANVIL_CHAIN_ID, HASH)]: entry() },
      receipt: () => null,
      now: NOW + MAX_PENDING_TX_AGE_MS,
    });

    await store.reconcile();

    expect(announced).toEqual([]);
  });

  it("keeps waiting one millisecond before the hour is up", async () => {
    const { area, store } = setup({
      seed: { [pendingTxKey(ANVIL_CHAIN_ID, HASH)]: entry() },
      receipt: () => null,
      now: NOW + MAX_PENDING_TX_AGE_MS - 1,
    });

    expect(await store.reconcile()).toBe(1);
    expect(Object.keys(stored(area))).toHaveLength(1);
    expect(logs(area)).toEqual([]);
  });

  /**
   * 🇪🇸 NOTA: una transacción vieja que SÍ se minó se resuelve como minada, no se
   * descarta por antigüedad. El recibo manda: el descarte es para lo que sigue
   * sin respuesta.
   */
  it("confirms an old transaction that turns out to be mined", async () => {
    const { area, store, announced } = setup({
      seed: { [pendingTxKey(ANVIL_CHAIN_ID, HASH)]: entry() },
      receipt: () => ({ status: 1, blockNumber: 9 }),
      now: NOW + MAX_PENDING_TX_AGE_MS * 2,
    });

    await store.reconcile();

    expect(announced).toEqual([{ hash: HASH, confirmed: true }]);
    expect(logs(area)[0]?.label).toBe("transaction confirmed");
  });

  /**
   * 🇪🇸 NOTA: este test encontró un fallo real. La primera implementación volvía
   * antes de tiempo cuando el nodo no contestaba, así que un RPC muerto saltaba
   * el descarte y la lista habría crecido para siempre — justo lo contrario de
   * para lo que existe el descarte.
   *
   * Las tres formas de no saber nada —red borrada, nodo mudo, y nodo que dice
   * que aún no la conoce— tienen que acabar en el mismo sitio pasada la hora.
   */
  it("also gives up on an old transaction the node cannot be asked about", async () => {
    const { area, store } = setup({
      seed: { [pendingTxKey(ANVIL_CHAIN_ID, HASH)]: entry() },
      unreachable: true,
      now: NOW + MAX_PENDING_TX_AGE_MS,
    });

    expect(await store.reconcile()).toBe(0);
    expect(stored(area)).toEqual({});
    expect(logs(area)[0]?.label).toBe("stopped tracking transaction");
  });

  it("also gives up when the network it was sent on is gone", async () => {
    const { area, store } = setup({
      seed: { [pendingTxKey(ANVIL_CHAIN_ID, HASH)]: entry() },
      networkGone: true,
      now: NOW + MAX_PENDING_TX_AGE_MS,
    });

    expect(await store.reconcile()).toBe(0);
    expect(stored(area)).toEqual({});
  });
});
