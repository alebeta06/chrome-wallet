import { describe, expect, it, vi } from "vitest";

import { ErrorCode, type PendingRequest, type RequestId } from "@/types/messages";
import { createApprovalCoordinator, type ApprovalWindows } from "@/lib/approvals";
import { ProviderError } from "@/lib/errors";
import { createWalletStorage } from "@/lib/storage";
import { createMemoryStorageArea } from "./helpers/memory-storage-area";

const VERCEL = "https://chrome-wallet.vercel.app";
const LOCAL = "http://localhost:3000";
const ANVIL_FIRST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const ANVIL_SECOND = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const ACCOUNTS = [ANVIL_FIRST, ANVIL_SECOND];

/** Lets a test drive the clock without touching real timers. */
function setup(options: { timeoutMs?: number; failOpen?: boolean } = {}) {
  const area = createMemoryStorageArea();
  const opened: RequestId[] = [];
  const closed: number[] = [];
  let clock = 1_000;
  let nextWindowId = 100;

  const windows: ApprovalWindows = {
    open: vi.fn(async (requestId) => {
      if (options.failOpen === true) throw new Error("no windows today");
      opened.push(requestId);
      return nextWindowId++;
    }),
    close: vi.fn(async (windowId) => {
      closed.push(windowId);
    }),
  };

  const coordinator = createApprovalCoordinator({
    storage: createWalletStorage(area),
    windows,
    now: () => clock,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  return {
    area,
    windows,
    opened,
    closed,
    coordinator,
    advance: (ms: number) => {
      clock += ms;
    },
    pending: () =>
      (area.snapshot()["cc:pendingRequests"] as Record<RequestId, PendingRequest> | undefined) ?? {},
  };
}

const CONNECT = { origin: VERCEL, accounts: ACCOUNTS, suggestedAccountIndex: 0 };

/** Lets the microtask queue drain so a pending request reaches storage. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function expectRejection(promise: Promise<unknown>, code: number): Promise<ProviderError> {
  const outcome: unknown = await promise.then(
    (value) => value,
    (cause: unknown) => cause,
  );

  if (!(outcome instanceof ProviderError)) {
    throw new Error(`expected a ProviderError, got ${String(outcome)}`);
  }

  expect(outcome.serialized.code).toBe(code);
  return outcome;
}

describe("requestConnect", () => {
  it("persists the request before opening the window", async () => {
    const { coordinator, opened, pending } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();

    const stored = Object.values(pending());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "connect", origin: VERCEL, accounts: ACCOUNTS });
    expect(opened).toEqual([stored[0].id]);

    await coordinator.settle(stored[0].id, 1);
    await expect(decision).resolves.toBe(1);
  });

  it("records the window id so the request can be closed later", async () => {
    const { coordinator, pending, closed } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    const id = Object.keys(pending())[0];
    expect(pending()[id].windowId).toBe(100);

    await coordinator.settle(id, 0);
    await decision;

    expect(closed).toEqual([100]);
  });

  it("stamps an expiry from the injected clock", async () => {
    const { coordinator, pending } = setup({ timeoutMs: 60_000 });

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    const stored = Object.values(pending())[0];

    expect(stored.createdAt).toBe(1_000);
    expect(stored.expiresAt).toBe(61_000);

    await coordinator.reject(stored.id, { code: ErrorCode.USER_REJECTED, message: "done" });
    await decision.catch(() => {});
  });

  it("clears the request from storage once settled", async () => {
    const { coordinator, pending } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    await coordinator.settle(Object.keys(pending())[0], 1);
    await decision;

    expect(pending()).toEqual({});
  });
});

describe("concurrent requests from the same origin", () => {
  /**
   * ------------------------------------------------------------------------
   * ONE WINDOW, TWO PROMISES
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: no es un caso raro. React en StrictMode monta dos veces en
   * desarrollo, así que una dApp llamando dos veces seguidas es lo NORMAL. Dos
   * ventanas obligarían al usuario a decidir dos veces y dejarían una huérfana
   * pase lo que pase.
   */
  it("opens a single window and resolves both callers", async () => {
    const { coordinator, opened, pending } = setup();

    const first = coordinator.requestConnect(CONNECT);
    await flush();
    const second = coordinator.requestConnect(CONNECT);
    await flush();

    expect(opened).toHaveLength(1);
    expect(Object.keys(pending())).toHaveLength(1);

    await coordinator.settle(Object.keys(pending())[0], 1);

    expect(await first).toBe(1);
    expect(await second).toBe(1);
  });

  it("rejects both callers together", async () => {
    const { coordinator, pending } = setup();

    const first = coordinator.requestConnect(CONNECT);
    await flush();
    const second = coordinator.requestConnect(CONNECT);
    await flush();

    await coordinator.reject(Object.keys(pending())[0], {
      code: ErrorCode.USER_REJECTED,
      message: "nope",
    });

    await expectRejection(first, ErrorCode.USER_REJECTED);
    await expectRejection(second, ErrorCode.USER_REJECTED);
  });

  /** A different origin is a different question, so it gets its own window. */
  it("opens a separate window for a different origin", async () => {
    const { coordinator, opened, pending } = setup();

    const fromVercel = coordinator.requestConnect(CONNECT);
    await flush();
    const fromLocal = coordinator.requestConnect({ ...CONNECT, origin: LOCAL });
    await flush();

    expect(opened).toHaveLength(2);
    const ids = Object.values(pending());
    expect(ids).toHaveLength(2);

    for (const entry of ids) await coordinator.settle(entry.id, 0);
    await expect(Promise.all([fromVercel, fromLocal])).resolves.toEqual([0, 0]);
  });

  /**
   * 🇪🇸 NOTA: el caso del worker resucitado. La petición sigue en storage pero
   * sus esperantes murieron con el worker. Una llamada nueva se engancha a ella
   * y sí recibe respuesta — y no se abre una segunda ventana encima de la que
   * el usuario ya tiene delante.
   */
  it("joins a request left behind by a dead worker", async () => {
    const { coordinator, area, opened } = setup();

    // A pending request in storage with nobody waiting on it in memory.
    await area.set({
      "cc:pendingRequests": {
        "orphan-1": {
          id: "orphan-1",
          kind: "connect",
          origin: VERCEL,
          createdAt: 500,
          expiresAt: 90_000,
          accounts: ACCOUNTS,
          suggestedAccountIndex: 0,
          windowId: 7,
        },
      },
    });

    const decision = coordinator.requestConnect(CONNECT);
    await flush();

    expect(opened).toEqual([]);
    await coordinator.settle("orphan-1", 1);
    expect(await decision).toBe(1);
  });

  /** An expired leftover must not block the origin forever. */
  it("starts fresh when the leftover request has expired", async () => {
    const { coordinator, area, opened, pending } = setup();

    await area.set({
      "cc:pendingRequests": {
        "stale-1": {
          id: "stale-1",
          kind: "connect",
          origin: VERCEL,
          createdAt: 0,
          expiresAt: 500, // the injected clock is already at 1000
          accounts: ACCOUNTS,
          suggestedAccountIndex: 0,
        },
      },
    });

    const decision = coordinator.requestConnect(CONNECT);
    await flush();

    expect(opened).toHaveLength(1);
    const fresh = Object.values(pending()).find((entry) => entry.id !== "stale-1");
    expect(fresh).toBeDefined();

    await coordinator.settle(fresh!.id, 0);
    await expect(decision).resolves.toBe(0);
  });
});

describe("rejection paths", () => {
  it("rejects with 4001 when the user says no", async () => {
    const { coordinator, pending } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    await coordinator.reject(Object.keys(pending())[0], {
      code: ErrorCode.USER_REJECTED,
      message: "User rejected the request.",
    });

    await expectRejection(decision, ErrorCode.USER_REJECTED);
    expect(pending()).toEqual({});
  });

  /**
   * 🇪🇸 NOTA: el puerto keep-alive cayendo es como el background se entera de
   * que la ventana se cerró con la X. Más fiable que `chrome.windows.onRemoved`
   * porque cubre además un crash o una navegación de la propia página.
   */
  it("rejects with 4001 when the approval window is closed", async () => {
    const { coordinator, pending } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    const id = Object.keys(pending())[0];

    // What background.ts does on port.onDisconnect.
    await coordinator.reject(id, {
      code: ErrorCode.USER_REJECTED,
      message: "The approval window was closed.",
    });

    await expectRejection(decision, ErrorCode.USER_REJECTED);
  });

  it("rejects with 4001 on timeout, closing the window", async () => {
    const { coordinator, closed } = setup({ timeoutMs: 10 });

    const decision = coordinator.requestConnect(CONNECT);
    await flush();

    const error = await expectRejection(decision, ErrorCode.USER_REJECTED);
    expect(error.serialized.message).toContain("timed out");
    expect(closed).toEqual([100]);
  });

  it("answers -32603 when the window cannot be opened at all", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { coordinator, pending } = setup({ failOpen: true });

    await expectRejection(coordinator.requestConnect(CONNECT), ErrorCode.INTERNAL);
    expect(pending()).toEqual({});
  });
});

describe("settle is idempotent", () => {
  /**
   * ------------------------------------------------------------------------
   * THE RACE THAT WOULD OTHERWISE OVERWRITE AN APPROVAL WITH A 4001
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: el usuario aprueba → el background resuelve y cierra la ventana →
   * el puerto keep-alive cae → llega un `reject` por cierre. Si ese reject
   * pudiera pisar la aprobación, aprobar y cerrar sería indistinguible de
   * cancelar. El primero gana y el segundo no hace nada.
   */
  it("ignores a rejection that arrives after the approval", async () => {
    const { coordinator, pending } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    const id = Object.keys(pending())[0];

    await coordinator.settle(id, 1);
    await coordinator.reject(id, { code: ErrorCode.USER_REJECTED, message: "window closed" });

    await expect(decision).resolves.toBe(1);
  });

  it("ignores an approval that arrives after the rejection", async () => {
    const { coordinator, pending } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    const id = Object.keys(pending())[0];

    await coordinator.reject(id, { code: ErrorCode.USER_REJECTED, message: "no" });
    await coordinator.settle(id, 1);

    await expectRejection(decision, ErrorCode.USER_REJECTED);
  });

  it("does not close the window twice", async () => {
    const { coordinator, pending, closed } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    const id = Object.keys(pending())[0];

    await coordinator.settle(id, 0);
    await coordinator.settle(id, 0);
    await decision;

    expect(closed).toEqual([100]);
  });

  it("is a no-op for a request id nobody has heard of", async () => {
    const { coordinator, closed } = setup();

    await expect(coordinator.settle("never-existed", 0)).resolves.toBeUndefined();
    await expect(
      coordinator.reject("never-existed", { code: ErrorCode.USER_REJECTED, message: "x" }),
    ).resolves.toBeUndefined();
    expect(closed).toEqual([]);
  });
});

describe("read", () => {
  it("hands the approval window its request", async () => {
    const { coordinator, pending } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    const id = Object.keys(pending())[0];

    const found = await coordinator.read(id);
    expect(found).toMatchObject({ kind: "connect", origin: VERCEL, suggestedAccountIndex: 0 });

    await coordinator.settle(id, 0);
    await decision;
  });

  it("returns null for an unknown id", async () => {
    const { coordinator } = setup();

    expect(await coordinator.read("nope")).toBeNull();
  });

  /**
   * 🇪🇸 NOTA: una petición caducada NO se renderiza. La dApp ya recibió su
   * rechazo, así que enseñarla dejaría al usuario aprobando algo que para el
   * otro lado terminó hace rato.
   */
  it("returns null once the request has expired", async () => {
    const { coordinator, pending, advance } = setup({ timeoutMs: 60_000 });

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    const id = Object.keys(pending())[0];

    advance(60_001);

    expect(await coordinator.read(id)).toBeNull();

    await coordinator.reject(id, { code: ErrorCode.USER_REJECTED, message: "cleanup" });
    await decision.catch(() => {});
  });
});
