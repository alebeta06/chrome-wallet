/**
 * @file lib/approvals.ts
 * @description The lifecycle of a request that has to wait for a human.
 *
 * ---------------------------------------------------------------------------
 * THE PROMISE IS A CACHE. STORAGE IS THE TRUTH.
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: esto es lo que el contrato llama "el contrato anti-sueño". Chrome
 * suspende el service worker a los ~30 s de inactividad, y el flujo "abro
 * ventana → el usuario piensa → decide" es exactamente el caso que lo dispara.
 * Por eso la petición vive en `cc:pendingRequests`, no en este Map.
 *
 * El Map guarda a los ESPERANTES: las funciones resolve/reject de las promesas
 * en vuelo. Si el worker muere se pierden, y la dApp que estaba esperando recibe
 * un 4900 del content script en vez de colgarse para siempre. La petición sigue
 * en storage y una llamada posterior se engancha a ella.
 *
 * Todo el estado vive en el closure de `createApprovalCoordinator`, NUNCA en una
 * variable de módulo: dos coordinadores en un test no pueden verse entre sí, y
 * el worker no arrastra nada entre suspensiones.
 */

import {
  APPROVAL_TIMEOUT_MS,
  ProviderErrors,
  type Address,
  type Origin,
  type PendingConnectRequest,
  type PendingRequest,
  type RequestId,
  type SerializedProviderError,
} from "@/types/messages";

import { ProviderError } from "./errors";
import type { WalletStorage } from "./storage";

/** What the coordinator needs from chrome.windows, and nothing more. */
export interface ApprovalWindows {
  /** Opens the approval surface for this request. Returns its window id. */
  open(requestId: RequestId): Promise<number | undefined>;
  close(windowId: number): Promise<void>;
}

export interface ApprovalDeps {
  storage: WalletStorage;
  windows: ApprovalWindows;
  /** Injected so tests are not at the mercy of the clock. */
  now?: () => number;
  /**
   * 🇪🇸 NOTA: parametrizado y no leído directamente del contrato porque la Fase
   * 6 trae `signature: 120_000`, que es un valor distinto para el mismo
   * mecanismo. El valor por defecto sí sale del contrato.
   */
  timeoutMs?: number;
}

export interface ConnectRequestInput {
  origin: Origin;
  accounts: Address[];
  suggestedAccountIndex: number;
  tabId?: number;
}

export interface ApprovalCoordinator {
  /** Resolves with the account index the user chose, or rejects with 4001. */
  requestConnect(input: ConnectRequestInput): Promise<number>;
  /** The user approved. First settle wins; later calls are no-ops. */
  settle(requestId: RequestId, accountIndex: number): Promise<void>;
  /** The user said no, the window closed, or the clock ran out. */
  reject(requestId: RequestId, error: SerializedProviderError): Promise<void>;
  /** Backs wallet_getPendingRequest so the approval window can render itself. */
  read(requestId: RequestId): Promise<PendingRequest | null>;
}

interface Waiter {
  resolve: (accountIndex: number) => void;
  reject: (cause: unknown) => void;
}

export function createApprovalCoordinator({
  storage,
  windows,
  now = () => Date.now(),
  timeoutMs = APPROVAL_TIMEOUT_MS.connect,
}: ApprovalDeps): ApprovalCoordinator {
  /** requestId -> everyone waiting on it. See the file header. */
  const waiters = new Map<RequestId, Waiter[]>();
  const timers = new Map<RequestId, ReturnType<typeof setTimeout>>();

  async function readAll(): Promise<Record<RequestId, PendingRequest>> {
    return (await storage.get("cc:pendingRequests")) ?? {};
  }

  /**
   * 🇪🇸 NOTA: los caducados se descartan al LEER, no con un temporizador global.
   * Un timer no sobrevive a la suspensión del worker, así que un pendiente que
   * expiró mientras el worker dormía seguiría ahí para siempre y bloquearía
   * cualquier intento futuro de ese mismo origen — "esta dApp ya no me deja
   * conectar" y nada que lo explique.
   */
  function isLive(pending: PendingRequest, at: number): boolean {
    return pending.expiresAt > at;
  }

  /** Removes the request from storage and hands back what was there. */
  async function forget(requestId: RequestId): Promise<PendingRequest | null> {
    const all = await readAll();
    const pending = all[requestId];
    if (pending === undefined) return null;

    const next = { ...all };
    delete next[requestId];
    await storage.set("cc:pendingRequests", next);

    return pending;
  }

  function clearTimer(requestId: RequestId): void {
    const timer = timers.get(requestId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(requestId);
  }

  function takeWaiters(requestId: RequestId): Waiter[] {
    const list = waiters.get(requestId) ?? [];
    waiters.delete(requestId);
    return list;
  }

  async function closeWindow(pending: PendingRequest | null): Promise<void> {
    if (pending?.windowId === undefined) return;

    try {
      await windows.close(pending.windowId);
    } catch {
      // Already gone — the user closed it themselves, which is a common path.
    }
  }

  async function settle(requestId: RequestId, accountIndex: number): Promise<void> {
    clearTimer(requestId);
    const pending = await forget(requestId);
    const list = takeWaiters(requestId);

    // Idempotent: nothing pending and nobody waiting means this already settled.
    if (pending === null && list.length === 0) return;

    for (const waiter of list) waiter.resolve(accountIndex);
    await closeWindow(pending);
  }

  async function reject(requestId: RequestId, error: SerializedProviderError): Promise<void> {
    clearTimer(requestId);
    const pending = await forget(requestId);
    const list = takeWaiters(requestId);

    if (pending === null && list.length === 0) return;

    for (const waiter of list) waiter.reject(new ProviderError(error));
    await closeWindow(pending);
  }

  /**
   * Registers one more waiter on a request, and arms the timeout once.
   *
   * 🇪🇸 NOTA: un solo temporizador por PETICIÓN, no por esperante. Dos llamadas
   * a la misma solicitud comparten destino, así que dos timers solo servirían
   * para que el segundo intentara rechazar algo ya resuelto.
   */
  function attach(requestId: RequestId): Promise<number> {
    return new Promise<number>((resolve, rejectPromise) => {
      waiters.set(requestId, [...(waiters.get(requestId) ?? []), { resolve, reject: rejectPromise }]);

      if (timers.has(requestId)) return;

      timers.set(
        requestId,
        setTimeout(() => {
          /**
           * 🇪🇸 NOTA: 4001 y no un código nuevo. Para la dApp la reacción
           * correcta es idéntica a un rechazo — no hay conexión, no es un fallo,
           * no merece un banner rojo. Un código propio haría que las dApps que
           * ya ramifican por 4001 enseñaran un error donde debería haber
           * silencio. El motivo real va en el mensaje y en `cc:logs`.
           */
          void reject(
            requestId,
            ProviderErrors.userRejected(
              `The connection request timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
            ),
          );
        }, timeoutMs),
      );
    });
  }

  async function requestConnect({
    origin,
    accounts,
    suggestedAccountIndex,
    tabId,
  }: ConnectRequestInput): Promise<number> {
    const at = now();
    const all = await readAll();

    /**
     * ------------------------------------------------------------------------
     * A SECOND CALL JOINS THE FIRST INSTEAD OF OPENING A SECOND WINDOW
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: una dApp que llama dos veces seguidas es lo normal, no un caso
     * raro — React en StrictMode monta dos veces en desarrollo. Abrir dos
     * ventanas para lo mismo obliga al usuario a decidir dos veces y deja una
     * huérfana pase lo que pase.
     */
    const existing = Object.values(all).find(
      (pending) => pending.kind === "connect" && pending.origin === origin && isLive(pending, at),
    );

    if (existing !== undefined) return attach(existing.id);

    const id = crypto.randomUUID();
    const pending: PendingConnectRequest = {
      id,
      kind: "connect",
      origin,
      createdAt: at,
      expiresAt: at + timeoutMs,
      accounts,
      suggestedAccountIndex,
      ...(tabId === undefined ? {} : { tabId }),
    };

    // Persisted BEFORE the window exists: if opening it fails, or the worker
    // dies between the two, the request is still recoverable and cancellable.
    await storage.set("cc:pendingRequests", { ...all, [id]: pending });

    const decision = attach(id);

    let windowId: number | undefined;
    try {
      windowId = await windows.open(id);
    } catch (cause) {
      console.error("[codecrypto] could not open the approval window:", cause);
      await reject(id, ProviderErrors.internal("The wallet could not open its approval window."));
      return decision;
    }

    if (windowId !== undefined) {
      // Re-read: the user may already have decided, or it may have timed out.
      const current = await readAll();
      const stored = current[id];
      if (stored !== undefined) {
        await storage.set("cc:pendingRequests", { ...current, [id]: { ...stored, windowId } });
      }
    }

    return decision;
  }

  async function read(requestId: RequestId): Promise<PendingRequest | null> {
    const pending = (await readAll())[requestId];
    if (pending === undefined) return null;

    // An expired request is not rendered: the window would let the user approve
    // something that already answered the dApp with a rejection.
    return isLive(pending, now()) ? pending : null;
  }

  return { requestConnect, settle, reject, read };
}
