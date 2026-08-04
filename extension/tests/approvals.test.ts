import { describe, expect, it, vi } from "vitest";

import { ErrorCode, type PendingRequest, type RequestId } from "@/types/messages";
import {
  createApprovalCoordinator,
  type ApprovalCoordinator,
  type ApprovalWindows,
} from "@/lib/approvals";
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
  // One override drives both kinds: these tests care about the mechanism, not
  // about which of the contract's two numbers applies.
  const area = createMemoryStorageArea();
  const opened: RequestId[] = [];
  const closed: number[] = [];
  let clock = 1_000;
  let nextWindowId = 100;

  const windows: ApprovalWindows = {
    open: vi.fn(async (requestId, _kind) => {
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
    ...(options.timeoutMs === undefined
      ? {}
      : { timeouts: { connect: options.timeoutMs, signature: options.timeoutMs } }),
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


/**
 * 🇪🇸 NOTA: `settle` recibe la decisión entera y no solo un índice desde la Fase
 * 6, porque una firma aprobada no lleva ninguno. Este helper mantiene los tests
 * de conexión legibles sin esconder que el mensaje es el del contrato.
 */
function approveConnect(
  coordinator: ApprovalCoordinator,
  requestId: RequestId,
  accountIndex: number,
): Promise<void> {
  return coordinator.settle(requestId, {
    type: "CODECRYPTO_DECISION",
    requestId,
    kind: "connect",
    approved: true,
    accountIndex,
  });
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

    await approveConnect(coordinator, stored[0].id, 1);
    await expect(decision).resolves.toBe(1);
  });

  it("records the window id so the request can be closed later", async () => {
    const { coordinator, pending, closed } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    const id = Object.keys(pending())[0];
    expect(pending()[id].windowId).toBe(100);

    await approveConnect(coordinator, id, 0);
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
    await approveConnect(coordinator, Object.keys(pending())[0], 1);
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

    await approveConnect(coordinator, Object.keys(pending())[0], 1);

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

    for (const entry of ids) await approveConnect(coordinator, entry.id, 0);
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
    await approveConnect(coordinator, "orphan-1", 1);
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

    await approveConnect(coordinator, fresh!.id, 0);
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

    await approveConnect(coordinator, id, 1);
    await coordinator.reject(id, { code: ErrorCode.USER_REJECTED, message: "window closed" });

    await expect(decision).resolves.toBe(1);
  });

  it("ignores an approval that arrives after the rejection", async () => {
    const { coordinator, pending } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    const id = Object.keys(pending())[0];

    await coordinator.reject(id, { code: ErrorCode.USER_REJECTED, message: "no" });
    await approveConnect(coordinator, id, 1);

    await expectRejection(decision, ErrorCode.USER_REJECTED);
  });

  it("does not close the window twice", async () => {
    const { coordinator, pending, closed } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    const id = Object.keys(pending())[0];

    await approveConnect(coordinator, id, 0);
    await approveConnect(coordinator, id, 0);
    await decision;

    expect(closed).toEqual([100]);
  });

  it("is a no-op for a request id nobody has heard of", async () => {
    const { coordinator, closed } = setup();

    await expect(approveConnect(coordinator, "never-existed", 0)).resolves.toBeUndefined();
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

    await approveConnect(coordinator, id, 0);
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

// ============================================================================
// Phase 6 — signature requests share the mechanism, not the deduplication
// ============================================================================

const SIGNATURE = {
  origin: VERCEL,
  method: "eth_sendTransaction" as const,
  params: [{ to: ANVIL_SECOND, value: "0xde0b6b3a7640000" }],
  chainId: "0x7a69" as const,
  accountIndex: 0,
};

function approveSignature(coordinator: ApprovalCoordinator, requestId: RequestId): Promise<void> {
  return coordinator.settle(requestId, {
    type: "CODECRYPTO_DECISION",
    requestId,
    kind: "signature",
    approved: true,
  });
}

describe("requestSignature", () => {
  it("persists the request and opens the signature surface", async () => {
    const { coordinator, windows, pending } = setup();

    const decision = coordinator.requestSignature(SIGNATURE);
    await flush();

    const stored = Object.values(pending());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: "signature",
      origin: VERCEL,
      method: "eth_sendTransaction",
      chainId: "0x7a69",
      accountIndex: 0,
    });

    // The background needs the kind to know which HTML to open.
    expect(windows.open).toHaveBeenCalledWith(stored[0].id, "signature");

    await approveSignature(coordinator, stored[0].id);
    await expect(decision).resolves.toBeUndefined();
  });

  it("uses the signature timeout from the contract, not the connect one", async () => {
    const area = createMemoryStorageArea();
    const coordinator = createApprovalCoordinator({
      storage: createWalletStorage(area),
      windows: { open: async () => 1, close: async () => {} },
      now: () => 1_000,
    });

    const decision = coordinator.requestSignature(SIGNATURE);
    await flush();

    const stored = Object.values(
      (area.snapshot()["cc:pendingRequests"] ?? {}) as Record<RequestId, PendingRequest>,
    )[0];

    // APPROVAL_TIMEOUT_MS.signature is 120_000; connect is 60_000.
    expect(stored.expiresAt - stored.createdAt).toBe(120_000);

    await coordinator.reject(stored.id, { code: ErrorCode.USER_REJECTED, message: "cleanup" });
    await decision.catch(() => {});
  });

  it("rejects with 4001 when the user says no", async () => {
    const { coordinator, pending } = setup();

    const decision = coordinator.requestSignature(SIGNATURE);
    await flush();

    await coordinator.reject(Object.keys(pending())[0], {
      code: ErrorCode.USER_REJECTED,
      message: "User rejected the request.",
    });

    await expectRejection(decision, ErrorCode.USER_REJECTED);
  });

  it("closes its window once approved", async () => {
    const { coordinator, pending, closed } = setup();

    const decision = coordinator.requestSignature(SIGNATURE);
    await flush();
    await approveSignature(coordinator, Object.keys(pending())[0]);
    await decision;

    expect(closed).toEqual([100]);
  });
});

describe("signatures never deduplicate", () => {
  /**
   * ------------------------------------------------------------------------
   * THE DIFFERENCE BETWEEN A CONVENIENCE AND A SECURITY HOLE
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: para conexiones, engancharse a la pendiente es una comodidad — la
   * pregunta es la misma y el usuario decide una vez.
   *
   * Para firmas sería un agujero. Dos `eth_sendTransaction` del mismo origen son
   * dos transacciones DISTINTAS, con otro destino y otra cantidad. Compartir una
   * sola aprobación enviaría la segunda sin que el usuario la haya visto jamás:
   * apruebas mandar 0.1 ETH a un amigo y de paso firmas otra que vacía la
   * cuenta.
   */
  it("opens one window per transaction, even from the same origin", async () => {
    const { coordinator, opened, pending } = setup();

    // Two different transactions: same origin, different destination and value.
    const inFlight = [
      coordinator.requestSignature(SIGNATURE),
      coordinator.requestSignature({ ...SIGNATURE, params: [{ to: ANVIL_FIRST, value: "0x1" }] }),
    ];
    await flush();

    expect(opened).toHaveLength(2);
    expect(Object.keys(pending())).toHaveLength(2);

    for (const promise of inFlight) void promise.catch(() => {});
  });

  it("keeps the two decisions independent", async () => {
    const { coordinator, pending } = setup();

    const first = coordinator.requestSignature(SIGNATURE);
    await flush();
    const second = coordinator.requestSignature(SIGNATURE);
    await flush();

    const [firstId, secondId] = Object.keys(pending());

    // Approving one must not resolve the other.
    await approveSignature(coordinator, firstId);
    await expect(first).resolves.toBeUndefined();

    await coordinator.reject(secondId, {
      code: ErrorCode.USER_REJECTED,
      message: "not this one",
    });
    await expectRejection(second, ErrorCode.USER_REJECTED);
  });

  /** A pending signature must not swallow a later connect request, or vice versa. */
  it("does not let a pending signature absorb a connection request", async () => {
    const { coordinator, opened, pending } = setup();

    const signature = coordinator.requestSignature(SIGNATURE);
    await flush();
    const connect = coordinator.requestConnect(CONNECT);
    await flush();

    expect(opened).toHaveLength(2);

    const entries = Object.values(pending());
    const signatureId = entries.find((entry) => entry.kind === "signature")!.id;
    const connectId = entries.find((entry) => entry.kind === "connect")!.id;

    await approveConnect(coordinator, connectId, 1);
    await expect(connect).resolves.toBe(1);

    await approveSignature(coordinator, signatureId);
    await expect(signature).resolves.toBeUndefined();
  });

  it("still deduplicates connections while a signature is pending", async () => {
    const { coordinator, opened } = setup();

    const signature = coordinator.requestSignature(SIGNATURE);
    await flush();
    const first = coordinator.requestConnect(CONNECT);
    await flush();
    const second = coordinator.requestConnect(CONNECT);
    await flush();

    // signature + one connect window, not three.
    expect(opened).toHaveLength(2);

    void signature.catch(() => {});
    void first.catch(() => {});
    void second.catch(() => {});
  });
});

describe("a decision that answers the wrong request", () => {
  /**
   * 🇪🇸 NOTA: si una decisión de firma resolviera una solicitud de conexión,
   * `accountIndex` no existiría y devolver 0 conectaría al usuario a una cuenta
   * que no eligió. Significaría que los ids se han cruzado, así que es mejor
   * reventar que adivinar.
   */
  it("refuses to connect on a signature decision", async () => {
    const { coordinator, pending } = setup();

    const decision = coordinator.requestConnect(CONNECT);
    await flush();
    const id = Object.keys(pending())[0];

    await approveSignature(coordinator, id);

    await expectRejection(decision, ErrorCode.INTERNAL);
  });
});

describe("truly concurrent requests", () => {
  /**
   * ------------------------------------------------------------------------
   * THE RACE THAT ONLY SHOWS UP WITHOUT A flush() IN BETWEEN
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: los tests de la Fase 5 intercalaban un `flush()` entre las dos
   * llamadas, así que la segunda siempre veía a la primera ya escrita. Sin él,
   * las dos leen el mapa a la vez.
   *
   * `chrome.runtime.onMessage` despacha CONCURRENTE, así que esto no es un caso
   * de laboratorio: dos dApps —o una llamando dos veces— llegan así de verdad.
   */
  it("does not lose a pending request when two arrive at once", async () => {
    const { coordinator, pending } = setup();

    // No flush between them: both read cc:pendingRequests before either writes.
    const inFlight = [
      coordinator.requestSignature(SIGNATURE),
      coordinator.requestSignature({ ...SIGNATURE, params: [{ to: ANVIL_FIRST, value: "0x1" }] }),
    ];
    await flush();

    expect(Object.keys(pending())).toHaveLength(2);

    for (const promise of inFlight) void promise.catch(() => {});
  });

  it("still opens a single window for two simultaneous connect calls", async () => {
    const { coordinator, opened, pending } = setup();

    const inFlight = [coordinator.requestConnect(CONNECT), coordinator.requestConnect(CONNECT)];
    await flush();

    expect(opened).toHaveLength(1);
    expect(Object.keys(pending())).toHaveLength(1);

    await approveConnect(coordinator, Object.keys(pending())[0], 1);
    await expect(Promise.all(inFlight)).resolves.toEqual([1, 1]);
  });

  it("keeps three simultaneous signatures apart", async () => {
    const { coordinator, opened, pending } = setup();

    const inFlight = [0, 1, 2].map((index) =>
      coordinator.requestSignature({ ...SIGNATURE, params: [{ value: `0x${index + 1}` }] }),
    );
    await flush();

    expect(opened).toHaveLength(3);
    expect(Object.keys(pending())).toHaveLength(3);

    for (const promise of inFlight) void promise.catch(() => {});
  });
});
