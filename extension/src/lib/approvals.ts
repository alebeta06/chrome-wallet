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
 *
 * ---------------------------------------------------------------------------
 * ONE MECHANISM, THREE KINDS OF REQUEST
 * ---------------------------------------------------------------------------
 * Phase 5 shipped this for `connect`. Phase 6 adds `signature`, and phase 8 will
 * add `add-chain`. They share everything that was hard to get right — the
 * keep-alive port, the idempotent settle, closing from the background, surviving
 * a suspension — and differ only in the timeout, the surface that renders them,
 * and whether repeats deduplicate.
 */

import {
  APPROVAL_TIMEOUT_MS,
  ProviderErrors,
  type Address,
  type DecisionMessage,
  type Hex,
  type Origin,
  type PendingConnectRequest,
  type PendingKind,
  type PendingRequest,
  type PendingSignatureRequest,
  type RequestId,
  type SerializedProviderError,
} from "@/types/messages";

import { ProviderError } from "./errors";
import type { WalletStorage } from "./storage";

/** The approved half of a decision. What a waiter resolves with. */
export type ApprovedDecision = Extract<DecisionMessage, { approved: true }>;

/** What the coordinator needs from chrome.windows, and nothing more. */
export interface ApprovalWindows {
  /**
   * Presents this request to the user and returns the id of the window it
   * opened.
   *
   * 🇪🇸 NOTA: el `kind` viaja porque el background es quien sabe qué superficie
   * corresponde — `connect.html` o `notification.html`. El coordinador no
   * conoce ninguna URL, que es lo que le permite no depender de `chrome.*`.
   */
  open(requestId: RequestId, kind: PendingKind): Promise<number | undefined>;
  close(windowId: number): Promise<void>;
}

export interface ApprovalDeps {
  storage: WalletStorage;
  windows: ApprovalWindows;
  /** Injected so tests are not at the mercy of the clock. */
  now?: () => number;
  /** Overrides per kind. Anything missing falls back to the contract's value. */
  timeouts?: Partial<Record<PendingKind, number>>;
}

export interface ConnectRequestInput {
  origin: Origin;
  accounts: Address[];
  suggestedAccountIndex: number;
  tabId?: number;
}

export interface SignatureRequestInput {
  origin: Origin;
  method: PendingSignatureRequest["method"];
  params: unknown[];
  chainId: Hex;
  accountIndex: number;
  tabId?: number;
}

export interface ApprovalCoordinator {
  /** Resolves with the account index the user chose, or rejects with 4001. */
  requestConnect(input: ConnectRequestInput): Promise<number>;
  /** Resolves when the user approves, or rejects with 4001. */
  requestSignature(input: SignatureRequestInput): Promise<void>;
  /** The user approved. First settle wins; later calls are no-ops. */
  settle(requestId: RequestId, decision: ApprovedDecision): Promise<void>;
  /** The user said no, the window closed, or the clock ran out. */
  reject(requestId: RequestId, error: SerializedProviderError): Promise<void>;
  /** Backs wallet_getPendingRequest so the approval window can render itself. */
  read(requestId: RequestId): Promise<PendingRequest | null>;
}

interface Waiter {
  resolve: (decision: ApprovedDecision) => void;
  reject: (cause: unknown) => void;
}

export function createApprovalCoordinator({
  storage,
  windows,
  now = () => Date.now(),
  timeouts = {},
}: ApprovalDeps): ApprovalCoordinator {
  /** requestId -> everyone waiting on it. See the file header. */
  const waiters = new Map<RequestId, Waiter[]>();
  const timers = new Map<RequestId, ReturnType<typeof setTimeout>>();

  function timeoutFor(kind: PendingKind): number {
    return timeouts[kind] ?? APPROVAL_TIMEOUT_MS[kind];
  }

  async function readAll(): Promise<Record<RequestId, PendingRequest>> {
    return (await storage.get("cc:pendingRequests")) ?? {};
  }

  /**
   * ------------------------------------------------------------------------
   * EVERY WRITE TO cc:pendingRequests GOES THROUGH HERE
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: `cc:pendingRequests` es un Record entero en una sola clave, así que
   * añadir o quitar una solicitud es un read-modify-write. `chrome.storage.local`
   * no tiene transacciones, y los handlers de `chrome.runtime.onMessage` corren
   * CONCURRENTES: dos `eth_sendTransaction` a la vez leen el mismo mapa vacío y
   * la segunda escritura se lleva por delante a la primera.
   *
   * El síntoma no es un error. Es que una de las dos solicitudes desaparece de
   * storage mientras su ventana sigue abierta: la ventana dice "esta solicitud
   * ya no está esperando" y la dApp se queda 120 s hasta el timeout. Lo encontró
   * un test, no el navegador.
   *
   * Con conexiones no aparecía porque la deduplicación hace que la segunda
   * llamada no escriba nada. Al quitar la deduplicación para firmas —que hay que
   * quitarla— la carrera queda expuesta.
   *
   * La cadena vive en el closure, como todo lo demás aquí. Si el worker muere no
   * hay escrituras en vuelo contra las que serializar.
   */
  let writes: Promise<unknown> = Promise.resolve();

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    // Both branches run the task: a previous failure must not stall the chain.
    const next = writes.then(task, task);
    writes = next.catch(() => undefined);
    return next;
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
  function forget(requestId: RequestId): Promise<PendingRequest | null> {
    return serialize(async () => {
      const all = await readAll();
      const pending = all[requestId];
      if (pending === undefined) return null;

      const next = { ...all };
      delete next[requestId];
      await storage.set("cc:pendingRequests", next);

      return pending;
    });
  }

  /** Records the window id, but only if the request is still there to record it on. */
  function attachWindow(requestId: RequestId, windowId: number): Promise<void> {
    return serialize(async () => {
      const all = await readAll();
      const stored = all[requestId];
      // Already gone: the user was fast, or it timed out.
      if (stored === undefined) return;

      await storage.set("cc:pendingRequests", { ...all, [requestId]: { ...stored, windowId } });
    });
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

  async function settle(requestId: RequestId, decision: ApprovedDecision): Promise<void> {
    clearTimer(requestId);
    const pending = await forget(requestId);
    const list = takeWaiters(requestId);

    // Idempotent: nothing pending and nobody waiting means this already settled.
    if (pending === null && list.length === 0) return;

    for (const waiter of list) waiter.resolve(decision);
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
  function attach(requestId: RequestId, timeoutMs: number): Promise<ApprovedDecision> {
    return new Promise<ApprovedDecision>((resolve, rejectPromise) => {
      waiters.set(requestId, [...(waiters.get(requestId) ?? []), { resolve, reject: rejectPromise }]);

      if (timers.has(requestId)) return;

      timers.set(
        requestId,
        setTimeout(() => {
          /**
           * 🇪🇸 NOTA: 4001 y no un código nuevo. Para la dApp la reacción
           * correcta es idéntica a un rechazo — no hay conexión ni firma, no es
           * un fallo, no merece un banner rojo. Un código propio haría que las
           * dApps que ya ramifican por 4001 enseñaran un error donde debería
           * haber silencio. El motivo real va en el mensaje y en `cc:logs`.
           */
          void reject(
            requestId,
            ProviderErrors.userRejected(
              `The request timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
            ),
          );
        }, timeoutMs),
      );
    });
  }

  /**
   * Either joins a live duplicate or persists the new request. Serialized.
   *
   * 🇪🇸 NOTA: la búsqueda del duplicado y la escritura tienen que ir en el MISMO
   * turno serializado. Separadas, dos peticiones concurrentes del mismo origen
   * leen ambas un mapa sin duplicado, ambas deciden crear, y se abren dos
   * ventanas — que es exactamente lo que la deduplicación existe para evitar.
   * El test de la Fase 5 no lo veía porque intercalaba un `flush()` entre las
   * dos llamadas; sin él, la carrera es real.
   */
  function claim(pending: PendingRequest, dedupe: boolean): Promise<RequestId> {
    return serialize(async () => {
      const all = await readAll();

      if (dedupe) {
        const existing = Object.values(all).find(
          (candidate) =>
            candidate.kind === pending.kind &&
            candidate.origin === pending.origin &&
            isLive(candidate, pending.createdAt),
        );
        if (existing !== undefined) return existing.id;
      }

      // Persisted BEFORE the window exists: if opening it fails, or the worker
      // dies between the two, the request is still recoverable and cancellable.
      await storage.set("cc:pendingRequests", { ...all, [pending.id]: pending });
      return pending.id;
    });
  }

  /** Claims the request, shows it if it is new, and waits. Shared by every kind. */
  async function present(pending: PendingRequest, dedupe: boolean): Promise<ApprovedDecision> {
    const id = await claim(pending, dedupe);
    const decision = attach(id, pending.expiresAt - pending.createdAt);

    // Joined an existing request: its window is already on screen.
    if (id !== pending.id) return decision;

    let windowId: number | undefined;
    try {
      windowId = await windows.open(pending.id, pending.kind);
    } catch (cause) {
      console.error("[codecrypto] could not open the approval window:", cause);
      await reject(
        pending.id,
        ProviderErrors.internal("The wallet could not open its approval window."),
      );
      return decision;
    }

    if (windowId !== undefined) await attachWindow(pending.id, windowId);

    return decision;
  }

  async function requestConnect({
    origin,
    accounts,
    suggestedAccountIndex,
    tabId,
  }: ConnectRequestInput): Promise<number> {
    const at = now();
    const timeoutMs = timeoutFor("connect");

    const pending: PendingConnectRequest = {
      id: crypto.randomUUID(),
      kind: "connect",
      origin,
      createdAt: at,
      expiresAt: at + timeoutMs,
      accounts,
      suggestedAccountIndex,
      ...(tabId === undefined ? {} : { tabId }),
    };

    /**
     * ------------------------------------------------------------------------
     * DEDUPLICATION IS FOR CONNECT ONLY. READ THIS BEFORE MOVING IT
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: una dApp que pide conectar dos veces seguidas es lo normal —
     * React en StrictMode monta dos veces en desarrollo. Abrir dos ventanas para
     * la MISMA pregunta obliga al usuario a decidir dos veces y deja una
     * huérfana. Se engancha a la primera y las dos promesas comparten destino.
     *
     * Con firmas esto sería un agujero de seguridad, no una comodidad. Dos
     * `eth_sendTransaction` del mismo origen son dos transacciones DISTINTAS —
     * otro destino, otra cantidad — y compartir una sola aprobación enviaría la
     * segunda sin que el usuario la haya visto jamás. Cada firma abre su ventana
     * y se aprueba por separado. Hay un test que lo fija.
     */
    return toAccountIndex(await present(pending, true));
  }

  async function requestSignature({
    origin,
    method,
    params,
    chainId,
    accountIndex,
    tabId,
  }: SignatureRequestInput): Promise<void> {
    const at = now();
    const timeoutMs = timeoutFor("signature");

    const pending: PendingSignatureRequest = {
      id: crypto.randomUUID(),
      kind: "signature",
      origin,
      createdAt: at,
      expiresAt: at + timeoutMs,
      method,
      params,
      chainId,
      accountIndex,
      ...(tabId === undefined ? {} : { tabId }),
    };

    await present(pending, false);
  }

  async function read(requestId: RequestId): Promise<PendingRequest | null> {
    const pending = (await readAll())[requestId];
    if (pending === undefined) return null;

    // An expired request is not rendered: the window would let the user approve
    // something that already answered the dApp with a rejection.
    return isLive(pending, now()) ? pending : null;
  }

  return { requestConnect, requestSignature, settle, reject, read };
}

/**
 * 🇪🇸 NOTA: el `kind` de la decisión se comprueba en vez de darse por bueno. Una
 * decisión de firma resolviendo una solicitud de conexión significaría que los
 * ids se cruzaron, y devolver `0` ahí conectaría al usuario a una cuenta que no
 * eligió. Es más barato reventar.
 */
function toAccountIndex(decision: ApprovedDecision): number {
  if (decision.kind !== "connect") {
    throw new ProviderError(
      ProviderErrors.internal("A connection request was answered by the wrong decision."),
    );
  }
  return decision.accountIndex;
}
