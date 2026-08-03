/**
 * @file lib/dispatch.ts
 * @description The RPC dispatcher. Pure with respect to chrome.*: it receives a
 * MessageSender, it never touches the API.
 *
 * Keeping this out of background.ts is what makes the trust boundary testable.
 * A test can hand it a fake sender with `tab` defined — a web page, as far as
 * classifySender is concerned — and assert the 4100, with no browser involved.
 *
 * ---------------------------------------------------------------------------
 * NO MODULE-LEVEL STATE
 * ---------------------------------------------------------------------------
 * Every handler reads what it needs from storage on every call.
 *
 * 🇪🇸 NOTA: Chrome suspende el service worker a los ~30 s de inactividad y se
 * lleva por delante cualquier variable de módulo. Una caché "por eficiencia"
 * aquí no es una optimización: es un bug que aparece solo cuando el usuario
 * tarda en decidirse, que es siempre.
 */

import {
  ProviderErrors,
  assertSenderMayCall,
  classifySender,
  type Address,
  type BlockTag,
  type ConnectedSite,
  type Hex,
  type NetworkConfig,
  type Origin,
  type PendingRequest,
  type RpcRequestMessage,
  type RpcResponseMessage,
  type SenderContext,
  type WalletSnapshot,
} from "@/types/messages";

import {
  fetchBalanceAt as defaultFetchBalanceAt,
  fetchBalances as defaultFetchBalances,
  type BalanceAtReader,
  type BalanceReader,
} from "./chain";
import { ProviderError, invalidParams, toSerializedError } from "./errors";
import { MAX_ACCOUNTS, createMnemonic, deriveAddresses } from "./hd-wallet";
import { appendLog, createLogEntry, redactParams } from "./logs";
import type { ApprovalCoordinator } from "./approvals";
import type { EventEmitter } from "./events";
import { DEFAULT_CHAIN_ID, defaultNetworks } from "./networks";
import {
  connectSite,
  disconnectSite,
  resolveSiteAccount,
  usableSites,
  type ConnectedSites,
} from "./sites";
import type { WalletStorage } from "./storage";

export interface DispatcherDeps {
  storage: WalletStorage;
  /**
   * Injected so the RPC handlers can be tested without a node running — the
   * same reason StorageArea is injected.
   */
  fetchBalances?: BalanceReader;
  fetchBalanceAt?: BalanceAtReader;
  /**
   * Phase 5. Injected for the same reason as everything else here: a test can
   * approve or reject a connection without a browser ever opening a window.
   */
  approvals?: ApprovalCoordinator;
  emit?: EventEmitter;
  /**
   * The origin of the tab the user is looking at, for WalletSnapshot.activeSite.
   * Returns null when that is an extension page or nothing at all.
   */
  activeOrigin?: () => Promise<Origin | null>;
}

/** Everything the handlers are allowed to reach. Nothing is a module global. */
interface HandlerContext {
  storage: WalletStorage;
  fetchBalances: BalanceReader;
  fetchBalanceAt: BalanceAtReader;
  approvals: ApprovalCoordinator;
  emit: EventEmitter;
  activeOrigin: () => Promise<Origin | null>;
}

/**
 * 🇪🇸 NOTA: los tres valores por defecto son inertes a propósito. Un test que
 * solo mira `eth_chainId` no debería tener que construir un coordinador de
 * aprobaciones; y si un handler acabara usando uno de éstos por accidente, lo
 * que hace es nada — no abre ventanas, no manda eventos y no inventa un origen
 * activo. Fallar en silencio es mejor que fallar abriendo una ventana.
 */
const NO_APPROVALS: ApprovalCoordinator = {
  requestConnect: () => Promise.reject(new ProviderError(ProviderErrors.internal(
    "This wallet build cannot open approval windows.",
  ))),
  settle: () => Promise.resolve(),
  reject: () => Promise.resolve(),
  read: () => Promise.resolve(null),
};

const NO_EMIT: EventEmitter = () => Promise.resolve();

export type Dispatcher = (
  message: RpcRequestMessage,
  sender: chrome.runtime.MessageSender,
  runtimeId: string,
) => Promise<RpcResponseMessage>;

/**
 * Builds a dispatcher that NEVER throws and NEVER rejects. Every outcome is an
 * `RpcResponseMessage`, because the caller on the other side of the bridge has
 * no way to observe a rejection.
 */
export function createDispatcher({
  storage,
  fetchBalances = defaultFetchBalances,
  fetchBalanceAt = defaultFetchBalanceAt,
  approvals = NO_APPROVALS,
  emit = NO_EMIT,
  activeOrigin = () => Promise.resolve(null),
}: DispatcherDeps): Dispatcher {
  const deps: HandlerContext = {
    storage,
    fetchBalances,
    fetchBalanceAt,
    approvals,
    emit,
    activeOrigin,
  };

  return async function dispatch(message, sender, runtimeId) {
    // 1. Who is asking? A null answer means the message did not even come from
    //    this extension.
    const context = classifySender(sender, runtimeId);
    if (context === null) {
      return failure(message.id, ProviderErrors.unauthorized("Unrecognised message sender."));
    }

    // 2. The log goes in BEFORE the work, so a call that never comes back still
    //    leaves a trace of having been made.
    await record(storage, context, "call", message.method, redactParams(message.method, message.params));

    const response = await run(deps, context, message);

    if (!response.ok) {
      await record(storage, context, "error", message.method, {
        code: response.error.code,
        message: response.error.message,
      });
    }

    return response;
  };
}

async function run(
  deps: HandlerContext,
  context: SenderContext,
  message: RpcRequestMessage,
): Promise<RpcResponseMessage> {
  try {
    // May they call this? Checked BEFORE anything is read or executed.
    const denied = assertSenderMayCall(context, message.method);
    if (denied !== null) return failure(message.id, denied);

    // Only now does any work happen.
    const result = await handle(deps, context, message.method, message.params);
    return { type: "CODECRYPTO_RPC_RESULT", id: message.id, ok: true, result };
  } catch (cause) {
    return failure(message.id, toSerializedError(cause, context.fromPage));
  }
}

/**
 * Writes one activity-log entry, but only for calls that came from a web page.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EXTENSION'S OWN UI IS NOT LOGGED
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: el popup consulta saldos cada 5 s mientras está abierto. Con
 * `MAX_LOG_ENTRIES = 500` —y ese número está en el contrato inmutable— cuarenta
 * minutos de popup abierto barren el registro entero. Lo que las specs 13-16
 * quieren ver es qué le ha pedido cada dApp a la wallet; ahogarlo en el propio
 * polling de la wallet convierte el registro en ruido y en una función de
 * auditoría que no audita nada.
 *
 * El try/catch no es opcional: un fallo escribiendo el registro NO puede
 * convertir una llamada correcta en un error para la dApp.
 */
async function record(
  storage: WalletStorage,
  context: SenderContext,
  level: "call" | "error",
  method: string,
  detail: unknown,
): Promise<void> {
  if (!context.fromPage) return;

  try {
    await appendLog(storage, createLogEntry(level, method, context.origin, detail));
  } catch (cause) {
    console.error("[codecrypto] could not write to the activity log:", cause);
  }
}

function failure(id: string, error: ReturnType<typeof ProviderErrors.internal>): RpcResponseMessage {
  return { type: "CODECRYPTO_RPC_RESULT", id, ok: false, error };
}

/**
 * 🇪🇸 NOTA: el `context` llega hasta aquí desde la Fase 5 y no antes. En la Fase
 * 3 se dejó fuera a propósito: ningún handler necesitaba el origen, y un
 * parámetro que nadie lee es ruido que `noUnusedParameters` habría convertido en
 * un `_context` decorativo. Ahora `eth_accounts` sí lo necesita —la respuesta
 * depende de QUIÉN pregunta— así que el hilo se pasa cuando hay algo al otro
 * extremo tirando de él.
 */
async function handle(
  deps: HandlerContext,
  context: SenderContext,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const { storage, fetchBalances, fetchBalanceAt } = deps;

  switch (method) {
    // ---- Public surface: callable by any web page ----
    case "eth_chainId":
      return handleChainId(storage);
    case "eth_accounts":
      return handleAccounts(storage, context.origin);
    case "eth_getBalance":
      return handleGetBalance(storage, fetchBalanceAt, params);
    case "eth_requestAccounts":
      return handleRequestAccounts(deps, context);
    case "wallet_revokePermissions":
      return handleDisconnect(deps, context.origin);

    // ---- Internal surface: extension UI only ----
    case "wallet_createMnemonic":
      return handleCreateMnemonic();
    case "wallet_importMnemonic":
      return handleImportMnemonic(storage, params);
    case "wallet_getState":
      return handleGetState(deps);
    case "wallet_getBalances":
      return handleGetBalances(storage, fetchBalances, params);
    case "wallet_setDefaultAccount":
      return handleSetDefaultAccount(storage, params);
    case "wallet_setSiteAccount":
      return handleSetSiteAccount(deps, params);
    case "wallet_getConnectedSites":
      return handleGetConnectedSites(storage);
    case "wallet_disconnectSite":
      return handleDisconnect(deps, parseOriginParam(params, "wallet_disconnectSite"));
    case "wallet_getPendingRequest":
      return handleGetPendingRequest(deps, params);
    case "wallet_reset":
      return handleReset(deps);
    default:
      // Covers the public methods still to come — eth_sendTransaction and
      // eth_signTypedData_v4 (phase 6), wallet_switchEthereumChain and
      // wallet_addEthereumChain (phase 8) — and genuine typos.
      throw new ProviderError(ProviderErrors.unsupportedMethod(method));
  }
}

// ============================================================================
// Public methods
// ============================================================================

async function handleChainId(storage: WalletStorage): Promise<Hex> {
  return (await storage.get("cc:chainId")) ?? DEFAULT_CHAIN_ID;
}

/**
 * The accounts THIS origin is allowed to see. Empty for anyone unconnected.
 *
 * ---------------------------------------------------------------------------
 * THE ANSWER DEPENDS ON WHO IS ASKING, AND ON NOTHING ELSE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: el error clásico es que `eth_accounts` devuelva la cuenta activa a
 * cualquiera. Eso convierte la wallet en un FINGERPRINT: cualquier web que
 * visites sabe tu dirección sin haber pedido permiso, sin abrir una ventana y
 * sin que te enteres — y una dirección de Ethereum es un identificador
 * permanente con todo tu historial de transacciones colgando de él.
 *
 * Se devuelve UNA sola cuenta, no la lista entera, y ésa es la otra mitad del
 * modelo por origen: el sitio conectado ve su cuenta y no se entera siquiera de
 * cuántas más tienes. Enviar el array completo filtraría el tamaño de tu wallet
 * y todas las direcciones a la vez, que es lo que hace la mayoría de las wallets
 * y no hay ninguna razón para copiar.
 */
async function handleAccounts(storage: WalletStorage, origin: Origin): Promise<Address[]> {
  const [sites, accounts] = await Promise.all([
    storage.get("cc:connectedSites"),
    storage.get("cc:accounts"),
  ]);

  const list = accounts ?? [];
  const index = resolveSiteAccount(sites, origin, list.length);

  return index === null ? [] : [list[index]];
}

async function handleGetBalance(
  storage: WalletStorage,
  fetchBalanceAt: BalanceAtReader,
  params: unknown[],
): Promise<Hex> {
  const { address, blockTag } = parseGetBalanceParams(params);
  const network = await resolveActiveNetwork(storage);

  return fetchBalanceAt(network, address, blockTag);
}

/**
 * The permission flow. The only public method that can open a window.
 *
 * 🇪🇸 NOTA: el orden de las comprobaciones importa y es el que se ve abajo.
 * Un origen ya conectado NO abre nada — devolver su cuenta directamente es lo
 * que hace que recargar una dApp conectada sea instantáneo y silencioso, en vez
 * de una ventana de aprobación en cada F5.
 */
async function handleRequestAccounts(
  { storage, approvals, emit }: HandlerContext,
  context: SenderContext,
): Promise<Address[]> {
  const origin = context.origin;
  const [sites, accounts, defaultIndex] = await Promise.all([
    storage.get("cc:connectedSites"),
    storage.get("cc:accounts"),
    storage.get("cc:defaultAccountIndex"),
  ]);

  const list = accounts ?? [];

  // 1. Already connected, and the stored index still fits.
  const known = resolveSiteAccount(sites, origin, list.length);
  if (known !== null) return [list[known]];

  /**
   * 2. No wallet at all.
   *
   * 🇪🇸 NOTA: 4100 y no 4001. La dApp TIENE que poder distinguir "este usuario
   * no tiene wallet configurada" de "este usuario ha dicho que no", porque la
   * reacción correcta es distinta: en un caso se enseña "configura tu wallet",
   * en el otro no se enseña nada y se deja el botón como estaba. Devolver 4001
   * aquí sería mentir sobre lo que ha pasado, y no se abre ninguna ventana
   * porque no habría nada que enseñar en ella.
   */
  if (list.length === 0) {
    throw new ProviderError(
      ProviderErrors.unauthorized("No wallet has been set up in CodeCrypto Wallet yet."),
    );
  }

  // 3. Ask the user. Rejects with 4001 if they say no, close the window or wait
  //    too long — the coordinator owns all three.
  const accountIndex = await approvals.requestConnect({
    origin,
    accounts: list,
    suggestedAccountIndex: clampAccountIndex(defaultIndex, list.length),
    ...(context.tabId === undefined ? {} : { tabId: context.tabId }),
  });

  if (accountIndex < 0 || accountIndex >= list.length) {
    throw new ProviderError(ProviderErrors.internal("The approved account no longer exists."));
  }

  const nextSites = connectSite(sites, origin, accountIndex, Date.now());
  await storage.set("cc:connectedSites", nextSites);

  /**
   * 🇪🇸 NOTA: se emite `connect` y no `accountsChanged`. La dApp que acaba de
   * llamar recibe las cuentas por el `return` de su propia promesa; lo que el
   * evento aporta es avisar a las OTRAS pestañas del mismo origen, que no
   * llamaron a nada y estarían mostrando "desconectado".
   */
  await emit("accountsChanged", [list[accountIndex]], {
    changedOrigin: origin,
    connectedSites: nextSites,
  });

  return [list[accountIndex]];
}

/**
 * Drops an origin's permission. Backs both wallet_disconnectSite (from the
 * popup) and wallet_revokePermissions (from the dApp itself, EIP-2255 style).
 *
 * 🇪🇸 NOTA: el mismo handler para los dos porque el efecto es idéntico y la
 * diferencia está en QUIÉN puede pedirlo, que ya la resuelve
 * `assertSenderMayCall` una capa más arriba. Duplicarlo sería la vía rápida a
 * que uno de los dos se olvide de emitir el evento.
 */
async function handleDisconnect(
  { storage, emit }: HandlerContext,
  origin: Origin,
): Promise<null> {
  const sites = await storage.get("cc:connectedSites");
  if (sites === undefined || !(origin in sites)) return null;

  const nextSites = disconnectSite(sites, origin);
  await storage.set("cc:connectedSites", nextSites);

  /**
   * 🇪🇸 NOTA: el evento se emite con el mapa DE ANTES de borrar. `eventTargets`
   * resuelve los destinatarios consultando `connectedSites`, así que con el mapa
   * ya limpio el origen recién desconectado no estaría en la lista y nadie
   * recibiría el aviso — la dApp seguiría creyéndose conectada hasta recargar.
   */
  await emit("accountsChanged", [], { changedOrigin: origin, connectedSites: sites });

  return null;
}

/**
 * Generates a phrase and returns it. Persists NOTHING.
 *
 * 🇪🇸 NOTA: la wallet no existe hasta que el usuario confirma que ha apuntado
 * la frase, y esa confirmación es un `wallet_importMnemonic` posterior (Fase 2).
 * Si esto guardara el mnemonic, una wallet a medio crear quedaría en storage
 * con una frase que el usuario nunca llegó a ver entera.
 */
function handleCreateMnemonic(): string {
  return createMnemonic();
}

async function handleImportMnemonic(
  storage: WalletStorage,
  params: unknown[],
): Promise<Address[]> {
  const { phrase, accountCount } = parseImportParams(params);

  // Derivation validates the phrase and throws a typed error if it is bad, so
  // nothing is written when the import is invalid.
  const accounts = deriveAddresses(phrase, accountCount);

  const existingChainId = await storage.get("cc:chainId");

  await storage.setMany({
    "cc:mnemonic": phrase,
    "cc:accounts": accounts,
    "cc:defaultAccountIndex": 0,
    // Only seeded on a first import: re-importing must not silently move the
    // user back to Anvil.
    ...(existingChainId === undefined ? { "cc:chainId": DEFAULT_CHAIN_ID } : {}),
  });

  return accounts;
}

async function handleGetState({
  storage,
  activeOrigin,
}: HandlerContext): Promise<WalletSnapshot> {
  const [mnemonic, accounts, storedIndex, chainId, networks, sites] = await Promise.all([
    storage.get("cc:mnemonic"),
    storage.get("cc:accounts"),
    storage.get("cc:defaultAccountIndex"),
    storage.get("cc:chainId"),
    storage.get("cc:networks"),
    storage.get("cc:connectedSites"),
  ]);

  const list = accounts ?? [];

  return {
    isLoaded: typeof mnemonic === "string" && mnemonic.length > 0,
    accounts: list,
    defaultAccountIndex: clampAccountIndex(storedIndex, list.length),
    chainId: chainId ?? DEFAULT_CHAIN_ID,
    networks: networks ?? defaultNetworks(),
    activeSite: await resolveActiveSite(activeOrigin, sites, list.length),
  };
}

/**
 * The connected site behind the popup, if the focused tab is one.
 *
 * 🇪🇸 NOTA: esto es lo que permite que el popup enseñe LAS DOS cuentas — la
 * predeterminada de la wallet y la de este sitio — y deje claro cuál cambia cada
 * control. Sin esa distinción visible, el usuario cambia la cuenta por defecto
 * esperando que la dApp lo note, no pasa nada, y el modelo por origen parece un
 * bug en vez de una decisión.
 *
 * Un fallo leyendo la pestaña activa devuelve null y ya está: el popup se
 * degrada a su versión de siempre, que sigue siendo perfectamente usable.
 */
async function resolveActiveSite(
  activeOrigin: () => Promise<Origin | null>,
  sites: ConnectedSites | undefined,
  accountCount: number,
): Promise<ConnectedSite | null> {
  let origin: Origin | null;

  try {
    origin = await activeOrigin();
  } catch (cause) {
    console.error("[codecrypto] could not resolve the active tab:", cause);
    return null;
  }

  if (origin === null) return null;
  if (resolveSiteAccount(sites, origin, accountCount) === null) return null;

  return sites?.[origin] ?? null;
}

async function handleGetBalances(
  storage: WalletStorage,
  fetchBalances: BalanceReader,
  params: unknown[],
): Promise<Record<Address, Hex>> {
  const { addresses } = parseGetBalancesParams(params);
  const network = await resolveActiveNetwork(storage);

  return fetchBalances(network, addresses);
}

/**
 * Changes the wallet-wide default account.
 *
 * ---------------------------------------------------------------------------
 * THIS METHOD EMITS NOTHING
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: aquí está la mitad fácil de la asimetría que define el modelo de
 * cuenta por origen. La cuenta por defecto es una preferencia INTERNA de la
 * wallet: se usa para transferencias internas y como preselección en
 * connect.html. Ninguna dApp tiene por qué enterarse de que ha cambiado.
 *
 * La otra mitad llega en la Fase 8: `wallet_setSiteAccount` SÍ emite
 * accountsChanged, y solo a las pestañas del origen afectado. Si alguien
 * añadiera emisión a ESTE método, la dApp A se enteraría de qué cuenta usas en
 * la dApp B — que es exactamente la fuga que el modelo por origen existe para
 * evitar.
 *
 * Fíjate en que esta función no lee `cc:connectedSites` en ningún momento: no
 * puede dirigirse a un origen ni aunque quisiera. Hay un test que lo comprueba.
 */
async function handleSetDefaultAccount(
  storage: WalletStorage,
  params: unknown[],
): Promise<null> {
  const { accountIndex } = parseSetDefaultAccountParams(params);
  const accounts = (await storage.get("cc:accounts")) ?? [];

  if (accounts.length === 0) {
    throw invalidParams("There is no wallet loaded, so no account can be selected.");
  }
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= accounts.length) {
    throw invalidParams(
      `Account index must be an integer between 0 and ${accounts.length - 1}.`,
    );
  }

  await storage.set("cc:defaultAccountIndex", accountIndex);
  return null;
}

/**
 * Changes the account ONE origin sees, and tells only that origin.
 *
 * ---------------------------------------------------------------------------
 * THE OTHER HALF OF THE ASYMMETRY
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: éste es el gemelo de `wallet_setDefaultAccount`, y la diferencia
 * entre los dos ES el modelo por origen:
 *
 *   wallet_setDefaultAccount → preferencia interna de la wallet. NO emite nada,
 *                              y ni siquiera lee `cc:connectedSites`. Hay un
 *                              test estructural desde la Fase 1 que lo fija.
 *   wallet_setSiteAccount    → vínculo con un sitio concreto. SÍ emite, y solo
 *                              a las pestañas de ese origen.
 *
 * Si la emisión acabara en el método equivocado, la dApp A se enteraría de qué
 * cuenta usas en la dApp B — que es exactamente la fuga que el modelo existe
 * para evitar.
 */
async function handleSetSiteAccount(
  { storage, emit }: HandlerContext,
  params: unknown[],
): Promise<null> {
  const { origin, accountIndex } = parseSetSiteAccountParams(params);
  const [sites, accounts] = await Promise.all([
    storage.get("cc:connectedSites"),
    storage.get("cc:accounts"),
  ]);

  const list = accounts ?? [];

  if (!(origin in (sites ?? {}))) {
    throw invalidParams(`"${origin}" is not a connected site.`);
  }
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= list.length) {
    throw invalidParams(`Account index must be an integer between 0 and ${list.length - 1}.`);
  }

  const nextSites = connectSite(sites, origin, accountIndex, Date.now());
  await storage.set("cc:connectedSites", nextSites);

  await emit("accountsChanged", [list[accountIndex]], {
    changedOrigin: origin,
    connectedSites: nextSites,
  });

  return null;
}

async function handleGetConnectedSites(storage: WalletStorage): Promise<ConnectedSite[]> {
  const [sites, accounts] = await Promise.all([
    storage.get("cc:connectedSites"),
    storage.get("cc:accounts"),
  ]);

  // Sites whose index no longer fits are not connected as far as any dApp is
  // concerned, so the popup must not list them as if they were.
  return Object.values(usableSites(sites, (accounts ?? []).length)).sort(
    (a, b) => b.lastUsedAt - a.lastUsedAt,
  );
}

async function handleGetPendingRequest(
  { approvals }: HandlerContext,
  params: unknown[],
): Promise<PendingRequest | null> {
  const [raw] = params;
  if (typeof raw !== "object" || raw === null) {
    throw invalidParams("wallet_getPendingRequest expects a single object parameter.");
  }

  const { requestId } = raw as { requestId?: unknown };
  if (typeof requestId !== "string" || requestId.length === 0) {
    throw invalidParams('wallet_getPendingRequest requires a "requestId" string.');
  }

  return approvals.read(requestId);
}

/**
 * 🇪🇸 NOTA: el reset avisa a todos los sitios que estuvieran conectados ANTES de
 * borrar nada. Sin eso, cada dApp abierta seguiría enseñando una cuenta que ya
 * no existe hasta que alguien recargara — y la wallet estaría vacía mientras la
 * web dice que tienes fondos.
 */
async function handleReset({ storage, emit }: HandlerContext): Promise<null> {
  const sites = (await storage.get("cc:connectedSites")) ?? {};

  await storage.resetWallet();

  for (const origin of Object.keys(sites)) {
    await emit("accountsChanged", [], { changedOrigin: origin, connectedSites: sites });
  }

  return null;
}

/** The NetworkConfig matching cc:chainId, or 4902 if it is not in the catalogue. */
async function resolveActiveNetwork(storage: WalletStorage): Promise<NetworkConfig> {
  const [chainId, networks] = await Promise.all([
    storage.get("cc:chainId"),
    storage.get("cc:networks"),
  ]);

  const activeChainId = chainId ?? DEFAULT_CHAIN_ID;
  const network = (networks ?? defaultNetworks()).find(
    (candidate) => candidate.chainId === activeChainId,
  );

  if (network === undefined) {
    throw new ProviderError(ProviderErrors.unrecognizedChain(activeChainId));
  }
  return network;
}

/**
 * 🇪🇸 NOTA: `noUncheckedIndexedAccess` está desactivado, así que TypeScript
 * daría por bueno `accounts[storedIndex]` aunque el índice se salga del array.
 * El caso real no es hipotético: importas 5 cuentas, eliges la 4 como
 * predeterminada, haces reset, reimportas con 2 — el índice guardado apunta a
 * `undefined` y la UI muestra una cuenta vacía sin decir por qué.
 */
function clampAccountIndex(storedIndex: number | undefined, accountCount: number): number {
  if (storedIndex === undefined || !Number.isInteger(storedIndex)) return 0;
  if (storedIndex < 0 || storedIndex >= accountCount) return 0;
  return storedIndex;
}

function parseImportParams(params: unknown[]): { phrase: string; accountCount: number } {
  const [raw] = params;
  if (typeof raw !== "object" || raw === null) {
    throw invalidParams("wallet_importMnemonic expects a single object parameter.");
  }

  const { phrase, accountCount } = raw as { phrase?: unknown; accountCount?: unknown };

  if (typeof phrase !== "string") {
    throw invalidParams('wallet_importMnemonic requires a "phrase" string.');
  }
  if (typeof accountCount !== "number") {
    throw invalidParams('wallet_importMnemonic requires an "accountCount" number.');
  }

  return { phrase, accountCount };
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function parseGetBalancesParams(params: unknown[]): { addresses: Address[] } {
  const [raw] = params;
  if (typeof raw !== "object" || raw === null) {
    throw invalidParams("wallet_getBalances expects a single object parameter.");
  }

  const { addresses } = raw as { addresses?: unknown };

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw invalidParams('wallet_getBalances requires a non-empty "addresses" array.');
  }
  if (addresses.length > MAX_ACCOUNTS) {
    throw invalidParams(`wallet_getBalances accepts at most ${MAX_ACCOUNTS} addresses.`);
  }
  if (!addresses.every((entry) => typeof entry === "string" && ADDRESS_PATTERN.test(entry))) {
    throw invalidParams("wallet_getBalances received a malformed address.");
  }

  return { addresses: addresses as Address[] };
}

const BLOCK_TAG_KEYWORDS: ReadonlySet<string> = new Set(["latest", "pending", "earliest"]);
const BLOCK_NUMBER_PATTERN = /^0x[0-9a-fA-F]+$/;

/**
 * 🇪🇸 NOTA: `eth_getBalance` es PÚBLICO — lo llama una dApp, no nuestra UI — así
 * que los params son entrada hostil y se validan uno a uno antes de tocar la
 * red. Lo importante no es solo devolver -32602: es que una petición malformada
 * NO llegue a abrir una conexión JSON-RPC. Hay un test que comprueba que el
 * lector no se llamó.
 */
function parseGetBalanceParams(params: unknown[]): { address: Address; blockTag: BlockTag } {
  if (!Array.isArray(params) || params.length === 0) {
    throw invalidParams("eth_getBalance expects [address, blockTag?].");
  }

  const [address, blockTag] = params;

  if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) {
    throw invalidParams("eth_getBalance received a malformed address.");
  }

  // Both are seen in the wild for "no block given"; ethers omits it, some dApps
  // send an explicit null.
  if (blockTag === undefined || blockTag === null) {
    return { address: address as Address, blockTag: "latest" };
  }

  if (typeof blockTag === "string") {
    if (BLOCK_TAG_KEYWORDS.has(blockTag) || BLOCK_NUMBER_PATTERN.test(blockTag)) {
      return { address: address as Address, blockTag: blockTag as BlockTag };
    }
  }

  throw invalidParams(
    'eth_getBalance expects a block tag of "latest", "pending", "earliest" or a hex block number.',
  );
}

/** Shared by wallet_disconnectSite. Origins are opaque strings; only the shape is checked. */
function parseOriginParam(params: unknown[], method: string): Origin {
  const [raw] = params;
  if (typeof raw !== "object" || raw === null) {
    throw invalidParams(`${method} expects a single object parameter.`);
  }

  const { origin } = raw as { origin?: unknown };
  if (typeof origin !== "string" || origin.length === 0) {
    throw invalidParams(`${method} requires an "origin" string.`);
  }

  return origin;
}

function parseSetSiteAccountParams(params: unknown[]): { origin: Origin; accountIndex: number } {
  const origin = parseOriginParam(params, "wallet_setSiteAccount");
  const { accountIndex } = params[0] as { accountIndex?: unknown };

  if (typeof accountIndex !== "number") {
    throw invalidParams('wallet_setSiteAccount requires an "accountIndex" number.');
  }

  return { origin, accountIndex };
}

function parseSetDefaultAccountParams(params: unknown[]): { accountIndex: number } {
  const [raw] = params;
  if (typeof raw !== "object" || raw === null) {
    throw invalidParams("wallet_setDefaultAccount expects a single object parameter.");
  }

  const { accountIndex } = raw as { accountIndex?: unknown };
  if (typeof accountIndex !== "number") {
    throw invalidParams('wallet_setDefaultAccount requires an "accountIndex" number.');
  }

  return { accountIndex };
}
