/**
 * @file types/messages.ts
 * @description Message protocol contract for the CodeCrypto Wallet extension.
 *
 * This file is the ABI of the project. Every boundary crossing in the extension
 * is typed here, and nothing outside this file should invent a message shape.
 *
 * There are four boundaries:
 *
 *   1. page  <-> content-script     via window.postMessage   (untrusted)
 *   2. content-script <-> background via chrome.runtime      (semi-trusted)
 *   3. extension UI <-> background   via chrome.runtime      (trusted)
 *   4. extension UI  -> background   via chrome.runtime.Port (keep-alive)
 *
 * 🇪🇸 NOTA: la regla de oro de la arquitectura es que el mnemonic y las claves
 * privadas viven SOLO en el service worker. Este archivo es lo que hace que esa
 * regla sea verificable: los métodos públicos (los que puede llamar una dApp) y
 * los internos (los que solo puede llamar la UI de la extensión) están separados
 * a nivel de tipos, y el background rechaza los internos si el emisor es una
 * pestaña web. La seguridad no se confía a la disciplina: se compila.
 *
 * ---------------------------------------------------------------------------
 * ACCOUNT MODEL: per-origin ("Model B")
 * ---------------------------------------------------------------------------
 * Each connected origin pins its own account. Two dApps can be connected to two
 * different accounts at the same time. There is also a wallet-wide default
 * account, used for internal transfers and as the pre-selection in connect.html.
 *
 * Consequence, and the reason this file has an event-targeting section:
 *
 *   accountsChanged -> PER ORIGIN. Only the tabs of the affected origin get it.
 *   chainChanged    -> GLOBAL.     The network is a wallet-wide setting, so
 *                                  every connected origin gets it.
 *
 * 🇪🇸 NOTA: esta asimetría es deliberada y es la parte que hay que explicar en
 * el video. La red es una propiedad de la wallet; la cuenta es una propiedad de
 * la relación entre la wallet y ese sitio. Emitir accountsChanged a todos los
 * orígenes filtraría a la dApp A qué cuenta usa el usuario en la dApp B.
 */

// ============================================================================
// 1. Primitives
// ============================================================================

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** Web origin as reported by chrome.runtime.MessageSender.origin, e.g. "https://app.vercel.app". */
export type Origin = string;

/** UUIDv4 generated with crypto.randomUUID(). */
export type RequestId = string;

export type BlockTag = "latest" | "pending" | "earliest" | Hex;

export const PROTOCOL = "codecrypto" as const;
export const PROTOCOL_VERSION = 1 as const;

// ============================================================================
// 2. EIP-1193 errors
// ============================================================================

/**
 * Errors must cross process boundaries. Neither structured clone (postMessage)
 * nor chrome.runtime messaging preserve Error subclasses or custom properties,
 * so errors travel as plain objects and are rebuilt into a real Error in inject.ts.
 *
 * 🇪🇸 NOTA: este es el equivalente a los custom errors de Solidity. Un
 * `new Error("algo falló")` que cruza el puente llega como `{}` y la dApp no
 * puede distinguir "el usuario canceló" de "el nodo está caído". Los códigos
 * numéricos son el contrato.
 */
export interface SerializedProviderError {
  code: number;
  message: string;
  data?: unknown;
}

export const ErrorCode = {
  USER_REJECTED: 4001,
  UNAUTHORIZED: 4100,
  UNSUPPORTED_METHOD: 4200,
  DISCONNECTED: 4900,
  CHAIN_DISCONNECTED: 4901,
  UNRECOGNIZED_CHAIN: 4902,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ProviderErrors = {
  userRejected: (message = "User rejected the request."): SerializedProviderError => ({
    code: ErrorCode.USER_REJECTED,
    message,
  }),
  unauthorized: (message = "The requested account has not been authorized by the user."): SerializedProviderError => ({
    code: ErrorCode.UNAUTHORIZED,
    message,
  }),
  unsupportedMethod: (method: string): SerializedProviderError => ({
    code: ErrorCode.UNSUPPORTED_METHOD,
    message: `The method "${method}" is not supported by CodeCrypto Wallet.`,
  }),
  disconnected: (message = "The provider is disconnected from all chains."): SerializedProviderError => ({
    code: ErrorCode.DISCONNECTED,
    message,
  }),
  unrecognizedChain: (chainId: Hex): SerializedProviderError => ({
    code: ErrorCode.UNRECOGNIZED_CHAIN,
    message: `Unrecognized chain ID "${chainId}". Try adding it with wallet_addEthereumChain first.`,
  }),
  invalidParams: (message: string): SerializedProviderError => ({
    code: ErrorCode.INVALID_PARAMS,
    message,
  }),
  internal: (message = "Internal wallet error."): SerializedProviderError => ({
    code: ErrorCode.INTERNAL,
    message,
  }),
} as const;

// ============================================================================
// 3. Domain shapes
// ============================================================================

/** EIP-1559 transaction request as received from a dApp. Gas fields are optional: the wallet fills them. */
export interface TransactionRequest {
  from?: Address;
  to?: Address;
  value?: Hex;
  data?: Hex;
  gas?: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
  nonce?: Hex;
}

/** EIP-712 payload. Arrives from the dApp as a JSON string and is parsed into this. */
export interface TypedDataPayload {
  domain: {
    name?: string;
    version?: string;
    chainId?: number | Hex;
    verifyingContract?: Address;
    salt?: Hex;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** EIP-3085 shape, used by wallet_addEthereumChain. */
export interface AddEthereumChainParameter {
  chainId: Hex;
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrls?: string[];
}

export interface NetworkConfig {
  chainId: Hex;
  name: string;
  rpcUrl: string;
  /** Always mirrors nativeCurrency.symbol. Nothing may write one without the other. */
  symbol: string;
  explorerUrl: string | null;
  /** Built-in networks cannot be removed by the user. */
  builtIn: boolean;
  /** 0 for the built-ins: they were seeded, not added. */
  addedAt?: number;
  /** EIP-3085 shape. Optional so entries stored before phase 8 stay valid. */
  nativeCurrency?: { name: string; symbol: string; decimals: number };
}

export interface ConnectedSite {
  origin: Origin;
  /** The account this origin sees. Independent from every other origin. */
  accountIndex: number;
  connectedAt: number;
  lastUsedAt: number;
}

/**
 * What the popup renders. `activeSite` is resolved from the currently focused
 * tab, so the popup can show "cuenta para este sitio" next to the wallet-wide
 * default and make the distinction visible instead of surprising.
 */
export interface WalletSnapshot {
  isLoaded: boolean;
  accounts: Address[];
  /** Wallet-wide default: internal transfers, and pre-selection in connect.html. */
  defaultAccountIndex: number;
  chainId: Hex;
  networks: NetworkConfig[];
  /**
   * Networks whose RPC host permission is not currently granted.
   *
   * 🇪🇸 NOTA: se calcula en vivo con `chrome.permissions.contains()`, nunca se
   * persiste. Un flag guardado se queda obsoleto en cuanto el usuario vuelve a
   * conceder el permiso desde `chrome://extensions`, y entonces la wallet
   * enseñaría como rota una red que funciona.
   */
  unusableChainIds: Hex[];
  /** null when the focused tab is not a connected dApp (or is an extension page). */
  activeSite: ConnectedSite | null;
}

// ============================================================================
// 4. RPC surface — public vs internal
// ============================================================================

/**
 * PUBLIC methods: callable by any web page through window.codecrypto.
 * Everything here is permission-gated and, where it moves value or produces a
 * signature, requires explicit user approval in a separate window.
 */
export interface PublicRpcMap {
  eth_requestAccounts: { params: []; result: Address[] };
  eth_accounts: { params: []; result: Address[] };
  eth_chainId: { params: []; result: Hex };
  eth_getBalance: { params: [Address, BlockTag?]; result: Hex };
  eth_sendTransaction: { params: [TransactionRequest]; result: Hex };
  eth_signTypedData_v4: { params: [Address, string]; result: Hex };
  wallet_switchEthereumChain: { params: [{ chainId: Hex }]; result: null };
  wallet_addEthereumChain: { params: [AddEthereumChainParameter]; result: null };
  /** EIP-2255-flavoured: lets a dApp drop its own permission. */
  wallet_revokePermissions: { params: []; result: null };
}

/**
 * INTERNAL methods: callable ONLY from the extension's own UI
 * (popup, connect.html, notification.html).
 *
 * 🇪🇸 NOTA: si una página web pudiera invocar `wallet_importMnemonic` o
 * `wallet_internalTransfer`, cualquier sitio te vaciaría la wallet sin abrir
 * una sola ventana de confirmación. El background DEBE comprobar el emisor
 * antes de despachar (ver isPublicMethod / assertSenderMayCall más abajo).
 */
export interface InternalRpcMap {
  wallet_getState: { params: []; result: WalletSnapshot };
  wallet_createMnemonic: { params: []; result: string };
  wallet_importMnemonic: { params: [{ phrase: string; accountCount: number }]; result: Address[] };
  /**
   * Changes the wallet-wide default account. Emits NOTHING to dApps: the default
   * is an internal preference, not a per-site binding.
   */
  wallet_setDefaultAccount: { params: [{ accountIndex: number }]; result: null };
  /**
   * Changes the account a single origin sees, and emits accountsChanged to the
   * tabs of that origin only. This is what the popup's account switcher calls
   * when the focused tab is a connected dApp.
   */
  wallet_setSiteAccount: { params: [{ origin: Origin; accountIndex: number }]; result: null };
  /** Wallet-wide. Emits chainChanged to every connected origin. */
  wallet_setActiveNetwork: { params: [{ chainId: Hex }]; result: null };
  wallet_addNetwork: { params: [AddEthereumChainParameter]; result: NetworkConfig[] };
  /**
   * Removes a user-added network. Refuses a built-in and refuses the active one,
   * and says which of the two it was.
   */
  wallet_removeNetwork: { params: [{ chainId: Hex }]; result: NetworkConfig[] };
  wallet_getBalances: { params: [{ addresses: Address[] }]; result: Record<Address, Hex> };
  wallet_internalTransfer: {
    params: [{ fromIndex: number; toIndex: number; valueWei: Hex }];
    result: Hex;
  };
  wallet_getConnectedSites: { params: []; result: ConnectedSite[] };
  wallet_disconnectSite: { params: [{ origin: Origin }]; result: null };
  wallet_reset: { params: []; result: null };
  /** Reads a pending request so connect.html / notification.html can render it. */
  wallet_getPendingRequest: { params: [{ requestId: RequestId }]; result: PendingRequest | null };
}

export type RpcMap = PublicRpcMap & InternalRpcMap;
export type PublicRpcMethod = keyof PublicRpcMap;
export type InternalRpcMethod = keyof InternalRpcMap;
export type RpcMethod = keyof RpcMap;

export type RpcParams<M extends RpcMethod> = RpcMap[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcMap[M]["result"];

const PUBLIC_METHODS: ReadonlySet<string> = new Set<PublicRpcMethod>([
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "eth_getBalance",
  "eth_sendTransaction",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "wallet_revokePermissions",
]);

/** Single source of truth for the trust boundary. */
export function isPublicMethod(method: string): method is PublicRpcMethod {
  return PUBLIC_METHODS.has(method);
}

/** Methods that always require an approval window before executing. */
export const APPROVAL_REQUIRED_METHODS: ReadonlySet<string> = new Set([
  "eth_requestAccounts",
  "eth_sendTransaction",
  "eth_signTypedData_v4",
  "wallet_addEthereumChain",
]);

// ============================================================================
// 5. Provider events
// ============================================================================

export interface ProviderEventMap {
  accountsChanged: Address[];
  chainChanged: Hex;
  connect: { chainId: Hex };
  disconnect: SerializedProviderError;
}

export type ProviderEventName = keyof ProviderEventMap;

/** Which origins an event reaches. See the account-model note at the top. */
export const EVENT_SCOPE = {
  accountsChanged: "origin",
  chainChanged: "global",
  connect: "origin",
  disconnect: "origin",
} as const satisfies Record<ProviderEventName, "origin" | "global">;

/**
 * Background -> content-script event delivery.
 *
 * `expectedOrigin` is a second lock: the content script drops the message if it
 * does not match its own location.origin.
 *
 * 🇪🇸 NOTA: los tabId se reciclan. Si una pestaña navega de la dApp A a la dApp
 * B justo entre el chrome.tabs.query y el chrome.tabs.sendMessage, el evento
 * aterriza en el sitio equivocado y le filtras a B la cuenta de A. La ventana es
 * de milisegundos, pero es una fuga real y la comprobación es de una línea.
 */
export interface TabEventMessage<E extends ProviderEventName = ProviderEventName> {
  type: "CODECRYPTO_TAB_EVENT";
  eventName: E;
  data: ProviderEventMap[E];
  /**
   * The origin this message was addressed to. The type allows null, and the
   * emitter NEVER uses it — not even for a global event like chainChanged.
   *
   * 🇪🇸 NOTA: esto se aclaró en la Fase 8 porque el tipo permite las dos cosas y
   * el comentario anterior sugería `null` para los eventos globales, que es lo
   * contrario de lo que hace `events.ts`. La cerradura se pone SIEMPRE, y el
   * alcance —a cuántos orígenes se emite— lo decide `eventTargets`, que es otra
   * cosa y va por separado.
   *
   * El motivo es el mismo párrafo de arriba visto desde el otro lado: si una
   * pestaña navega entre el `query` y el `sendMessage`, con `null` el evento
   * aterriza donde sea que esté ahora — incluido un sitio NO conectado, que se
   * enteraría de que existe una wallet y en qué red está sin haber pedido nada.
   * Es la misma fuga que `eth_accounts` evita devolviendo `[]`, en pequeño.
   *
   * El precio es un falso negativo de milisegundos: una pestaña que navegue
   * entre dos dApps conectadas justo en ese hueco puede perderse un
   * `chainChanged` y quedarse con la red vieja hasta que recargue. Se prefiere
   * eso a contarle algo a un desconocido.
   */
  expectedOrigin: Origin | null;
}

// ============================================================================
// 6. Boundary 1 — page <-> content-script (window.postMessage)
// ============================================================================

/**
 * Every page-facing message carries a protocol marker. The listener must check
 * BOTH `event.source === window` and this marker.
 *
 * 🇪🇸 NOTA: window.postMessage es un bus público. Otras extensiones, otros
 * scripts y la propia página escriben en él. Sin el marcador y sin comprobar el
 * source, un iframe hostil puede inyectar una CODECRYPTO_RESPONSE falsa y
 * hacerle creer a la dApp que una transacción se firmó.
 */
interface PageMessageBase {
  __codecrypto: typeof PROTOCOL;
  v: typeof PROTOCOL_VERSION;
}

export interface PageRequestMessage extends PageMessageBase {
  type: "CODECRYPTO_REQUEST";
  id: RequestId;
  method: string; // validated against isPublicMethod in the background, never trusted here
  params: unknown[];
}

export type PageResponseMessage = PageMessageBase &
  ({
    type: "CODECRYPTO_RESPONSE";
    id: RequestId;
    ok: true;
    result: unknown;
  } | {
    type: "CODECRYPTO_RESPONSE";
    id: RequestId;
    ok: false;
    error: SerializedProviderError;
  });

export interface PageEventMessage<E extends ProviderEventName = ProviderEventName> extends PageMessageBase {
  type: "CODECRYPTO_EVENT";
  eventName: E;
  data: ProviderEventMap[E];
}

export type PageInboundMessage = PageResponseMessage | PageEventMessage;
export type PageOutboundMessage = PageRequestMessage;

export function isPageMessage(data: unknown): data is PageMessageBase & { type: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as PageMessageBase).__codecrypto === PROTOCOL &&
    (data as PageMessageBase).v === PROTOCOL_VERSION
  );
}

// ============================================================================
// 7. Boundary 2 & 3 — runtime messaging
// ============================================================================

/**
 * One RPC envelope for both the content-script and the extension UI.
 * The background distinguishes them by MessageSender, not by the payload:
 * a page-originated message always has `sender.tab` defined.
 */
export interface RpcRequestMessage {
  type: "CODECRYPTO_RPC";
  id: RequestId;
  method: string;
  params: unknown[];
}

export type RpcResponseMessage =
  | { type: "CODECRYPTO_RPC_RESULT"; id: RequestId; ok: true; result: unknown }
  | { type: "CODECRYPTO_RPC_RESULT"; id: RequestId; ok: false; error: SerializedProviderError };

/**
 * The user's verdict on a pending request.
 *
 * 🇪🇸 NOTA: el README oficial define CONNECT_RESPONSE y SIGN_RESPONSE por
 * separado. Aquí se unifican en DECISION porque la lógica del background es
 * idéntica (buscar la solicitud, limpiarla, resolver la promesa) y duplicarla
 * es la vía rápida a que una de las dos ramas se quede sin limpiar el badge.
 */
export type DecisionMessage =
  | {
      type: "CODECRYPTO_DECISION";
      requestId: RequestId;
      kind: "connect";
      approved: true;
      /** Which account the user chose to expose to this origin. */
      accountIndex: number;
    }
  | {
      type: "CODECRYPTO_DECISION";
      requestId: RequestId;
      kind: "signature" | "add-chain";
      approved: true;
    }
  | {
      type: "CODECRYPTO_DECISION";
      requestId: RequestId;
      kind: PendingKind;
      approved: false;
      error: SerializedProviderError;
    };

/** Emitted by the background so open UI surfaces can refresh without polling. */
export interface StateChangedMessage {
  type: "CODECRYPTO_STATE_CHANGED";
  snapshot: WalletSnapshot;
}

/** Structured log entry (specs 13-16). */
export interface LogMessage {
  type: "CODECRYPTO_LOG";
  entry: LogEntry;
}

export type LogLevel = "call" | "event" | "operation" | "error";

export interface LogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  label: string;
  origin?: Origin;
  detail?: unknown;
}

export type RuntimeMessage =
  | RpcRequestMessage
  | RpcResponseMessage
  | DecisionMessage
  | StateChangedMessage
  | TabEventMessage
  | LogMessage;

// ============================================================================
// 8. Pending requests — the anti-sleep contract
// ============================================================================

/**
 * Pending requests are persisted in chrome.storage.local, NOT held only in a Map.
 *
 * 🇪🇸 NOTA: este es el bug número uno de MV3. Chrome suspende el service worker
 * a los ~30 s de inactividad y se lleva por delante cualquier Map en memoria.
 * El flujo "abro ventana -> el usuario piensa -> firmo" es exactamente el caso
 * que lo dispara. Al persistir la solicitud, el worker puede resucitar y
 * reconstruir el estado. La promesa en memoria es una caché, no la verdad.
 *
 * Se guarda un Record, no una sola clave: dos dApps pueden pedir firma a la vez
 * y el `codecrypto_pending_request` en singular del README oficial pierde una.
 */
export type PendingKind = "connect" | "signature" | "add-chain";

interface PendingRequestBase {
  id: RequestId;
  kind: PendingKind;
  origin: Origin;
  createdAt: number;
  expiresAt: number;
  /** Set once the approval window exists, so windows.onRemoved can map back. */
  windowId?: number;
  /** Tab that originated the request, for focus-back after the decision. */
  tabId?: number;
}

export interface PendingConnectRequest extends PendingRequestBase {
  kind: "connect";
  accounts: Address[];
  suggestedAccountIndex: number;
}

export interface PendingSignatureRequest extends PendingRequestBase {
  kind: "signature";
  method: "eth_sendTransaction" | "eth_signTypedData_v4";
  params: unknown[];
  chainId: Hex;
  /** Account that will sign — resolved from connectedSites, not from the dApp. */
  accountIndex: number;
}

export interface PendingAddChainRequest extends PendingRequestBase {
  kind: "add-chain";
  chain: AddEthereumChainParameter;
}

export type PendingRequest =
  | PendingConnectRequest
  | PendingSignatureRequest
  | PendingAddChainRequest;

export const APPROVAL_TIMEOUT_MS = {
  connect: 60_000,
  signature: 120_000,
  "add-chain": 60_000,
} as const satisfies Record<PendingKind, number>;

/** Guard used by inject.ts; must be longer than the longest approval timeout. */
export const PAGE_REQUEST_TIMEOUT_MS = 150_000;

// ============================================================================
// 9. Boundary 4 — keep-alive port
// ============================================================================

/**
 * Approval windows open a Port to the background and hold it until the user
 * decides. This does two jobs at once:
 *
 *   1. A connected port keeps the service worker alive, so it cannot be
 *      suspended mid-approval.
 *   2. port.onDisconnect fires when the window is closed with the X, which is
 *      more reliable than chrome.windows.onRemoved (it also covers a crashed
 *      or navigated-away approval page) and gives us the implicit 4001 reject.
 *
 * 🇪🇸 NOTA: el nombre del puerto lleva el requestId dentro, así que el
 * background sabe exactamente qué solicitud rechazar cuando el puerto cae.
 */
export const APPROVAL_PORT_PREFIX = "codecrypto:approval:" as const;

export function approvalPortName(requestId: RequestId): string {
  return `${APPROVAL_PORT_PREFIX}${requestId}`;
}

export function parseApprovalPortName(name: string): RequestId | null {
  return name.startsWith(APPROVAL_PORT_PREFIX)
    ? name.slice(APPROVAL_PORT_PREFIX.length)
    : null;
}

// ============================================================================
// 10. Storage schema
// ============================================================================

/**
 * Everything persisted in chrome.storage.local, typed in one place.
 * Keys are namespaced to avoid collisions and to make `wallet_reset` explicit
 * about what it wipes and what it keeps.
 */
export interface StorageSchema {
  "cc:mnemonic": string;
  "cc:accounts": Address[];
  /** Wallet-wide default. Per-origin accounts live inside cc:connectedSites. */
  "cc:defaultAccountIndex": number;
  "cc:chainId": Hex;
  "cc:networks": NetworkConfig[];
  "cc:connectedSites": Record<Origin, ConnectedSite>;
  "cc:pendingRequests": Record<RequestId, PendingRequest>;
  /** EIP-6963 identity, generated once and stable for the install. */
  "cc:providerUuid": string;
  /** Survives wallet_reset by design (spec 24). */
  "cc:logs": LogEntry[];
}

export type StorageKey = keyof StorageSchema;

/** Keys cleared by wallet_reset. Everything else survives. */
export const RESET_CLEARED_KEYS: readonly StorageKey[] = [
  "cc:mnemonic",
  "cc:accounts",
  "cc:defaultAccountIndex",
  "cc:connectedSites",
  "cc:pendingRequests",
] as const;

export const MAX_LOG_ENTRIES = 500;

// ============================================================================
// 10b. Account resolution
// ============================================================================

/**
 * The single place that answers "which account does this origin see?".
 *
 * Returning null means the origin is not connected, and every public method
 * that needs an account must then fail with 4100 (or open connect.html, in the
 * case of eth_requestAccounts). eth_accounts returns [] instead of throwing.
 *
 * 🇪🇸 NOTA: el error clásico es que eth_accounts devuelva siempre la cuenta
 * activa. Eso convierte a la wallet en un fingerprint: cualquier web que
 * visites sabe tu dirección sin pedir permiso. Devolver [] para orígenes no
 * conectados es el comportamiento correcto y es un ítem de la rúbrica.
 */
export function resolveAccountForOrigin(
  connectedSites: Record<Origin, ConnectedSite>,
  origin: Origin,
): number | null {
  const site = connectedSites[origin];
  return site ? site.accountIndex : null;
}

/** Origins that must receive an event, given its scope. */
export function eventTargets(
  eventName: ProviderEventName,
  connectedSites: Record<Origin, ConnectedSite>,
  changedOrigin: Origin | null,
): Origin[] {
  if (EVENT_SCOPE[eventName] === "global") return Object.keys(connectedSites);
  if (changedOrigin === null) return [];
  return connectedSites[changedOrigin] ? [changedOrigin] : [];
}

// ============================================================================
// 11. EIP-6963
// ============================================================================

export interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string; // data URI
  rdns: string;
}

export const PROVIDER_RDNS = "academy.codecrypto.wallet" as const;
export const PROVIDER_NAME = "CodeCrypto Wallet" as const;

// ============================================================================
// 12. Sender validation
// ============================================================================

/**
 * The trust boundary in one function. Call it first in the background's
 * onMessage handler, before dispatching anything.
 *
 * 🇪🇸 NOTA: `sender.tab` solo está definido cuando el mensaje viene de un
 * content script, es decir, de una página web. La UI de la extensión no tiene
 * tab. Comprobar `sender.id === chrome.runtime.id` evita además que otra
 * extensión instalada nos hable por externally_connectable.
 */
export interface SenderContext {
  fromPage: boolean;
  origin: Origin;
  tabId?: number;
}

export function classifySender(
  sender: chrome.runtime.MessageSender,
  runtimeId: string,
): SenderContext | null {
  if (sender.id !== runtimeId) return null;
  const origin = sender.origin ?? sender.url ?? "unknown";
  // 🇪🇸 NOTA: `sender.tab` NO basta para distinguir una web de nuestra propia UI.
  // connect.html y notification.html se abren con chrome.windows.create, así que
  // también traen `tab`. Lo que las separa es el origin: nuestras páginas
  // reportan chrome-extension://<runtimeId>, una web reporta su propio dominio.
  const isOwnExtensionPage = origin === `chrome-extension://${runtimeId}`;
  const fromPage = sender.tab !== undefined && !isOwnExtensionPage;
  return { fromPage, origin, tabId: sender.tab?.id };
}

export function assertSenderMayCall(ctx: SenderContext, method: string): SerializedProviderError | null {
  if (!ctx.fromPage) return null; // extension UI may call anything
  if (!isPublicMethod(method)) return ProviderErrors.unauthorized(`Method "${method}" is not exposed to web pages.`);
  return null;
}