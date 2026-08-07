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
  fetchChainId as defaultFetchChainId,
  type BalanceAtReader,
  type BalanceReader,
  type ChainIdReader,
} from "./chain";
import { ProviderError, invalidParams, toSerializedError } from "./errors";
import { MAX_ACCOUNTS, createMnemonic, deriveAddresses } from "./hd-wallet";
import { appendLog, createLogEntry, redactParams } from "./logs";
import type { ApprovalCoordinator } from "./approvals";
import type { EventEmitter } from "./events";
import type { TransactionSender } from "./signer";
import { addChain, addNetworkFromWallet, removeNetworkRpc, switchChain } from "./network-rpc";
import { createNetworkStore, type NetworkStore } from "./network-store";
import { DEFAULT_CHAIN_ID } from "./networks";
import { hasPermissionFor, type PermissionsPort } from "./permissions";
import {
  connectSite,
  disconnectSite,
  resolveSiteAccount,
  usableSites,
  type ConnectedSites,
} from "./sites";
import type { WalletStorage } from "./storage";
import { parseTransactionRequest } from "./tx";
import { domainChainId, parseTypedDataParams } from "./typed-data";

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
  /** Phase 6. Injected so the signing path is testable without a node. */
  sender?: TransactionSender;
  /**
   * The origin of the tab the user is looking at, for WalletSnapshot.activeSite.
   * Returns null when that is an extension page or nothing at all.
   */
  activeOrigin?: () => Promise<Origin | null>;
  /**
   * Phase 8. The persisted network catalogue.
   *
   * 🇪🇸 NOTA: el worker tiene que pasar SU instancia, no dejar que se cree aquí
   * la de por defecto. El store lleva dentro la cadena que serializa las
   * escrituras de `cc:networks`, y dos instancias son dos cadenas que no se ven
   * entre sí — o sea, no tener cadena. El valor por defecto existe para los
   * tests, donde el despachador es el único que escribe.
   */
  networks?: NetworkStore;
  /** Phase 8. Injected so the snapshot can be built without chrome.permissions. */
  permissions?: PermissionsPort;
  /** Phase 8. Injected so adding a network is testable without a node. */
  readChainId?: ChainIdReader;
}

/** Everything the handlers are allowed to reach. Nothing is a module global. */
interface HandlerContext {
  storage: WalletStorage;
  fetchBalances: BalanceReader;
  fetchBalanceAt: BalanceAtReader;
  approvals: ApprovalCoordinator;
  emit: EventEmitter;
  sender: TransactionSender;
  activeOrigin: () => Promise<Origin | null>;
  networks: NetworkStore;
  permissions: PermissionsPort;
  readChainId: ChainIdReader;
}

/**
 * 🇪🇸 NOTA: los tres valores por defecto son inertes a propósito. Un test que
 * solo mira `eth_chainId` no debería tener que construir un coordinador de
 * aprobaciones; y si un handler acabara usando uno de éstos por accidente, lo
 * que hace es nada — no abre ventanas, no manda eventos y no inventa un origen
 * activo. Fallar en silencio es mejor que fallar abriendo una ventana.
 */
const noApprovalWindows = (): Promise<never> =>
  Promise.reject(
    new ProviderError(ProviderErrors.internal("This wallet build cannot open approval windows.")),
  );

const NO_APPROVALS: ApprovalCoordinator = {
  requestConnect: noApprovalWindows,
  requestSignature: noApprovalWindows,
  requestAddChain: noApprovalWindows,
  settle: () => Promise.resolve(),
  reject: () => Promise.resolve(),
  read: () => Promise.resolve(null),
};

const NO_EMIT: EventEmitter = () => Promise.resolve();

/**
 * 🇪🇸 NOTA: el inerte dice que SÍ, y esa dirección está elegida. Si se
 * equivoca por optimista, la red aparece usable y falla con un 4901 que la UI
 * ya sabe explicar — "no se puede alcanzar el nodo". Si se equivocara por
 * pesimista, escondería redes que funcionan perfectamente y no habría nada en
 * pantalla que dijera por qué. El primer fallo se ve y se entiende; el segundo
 * parece que la wallet perdió la red.
 */
const ALL_GRANTED: PermissionsPort = {
  contains: () => Promise.resolve(true),
  remove: () => Promise.resolve(false),
};

const NO_SENDER: TransactionSender = {
  send: () =>
    Promise.reject(
      new ProviderError(ProviderErrors.internal("This wallet build cannot send transactions.")),
    ),
  // Null is the "could not estimate" answer the approval window already handles.
  estimate: () => Promise.resolve(null),
  signTypedData: () =>
    Promise.reject(
      new ProviderError(ProviderErrors.internal("This wallet build cannot sign messages.")),
    ),
};

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
  sender = NO_SENDER,
  activeOrigin = () => Promise.resolve(null),
  networks = createNetworkStore(storage),
  permissions = ALL_GRANTED,
  readChainId = defaultFetchChainId,
}: DispatcherDeps): Dispatcher {
  const deps: HandlerContext = {
    storage,
    fetchBalances,
    fetchBalanceAt,
    approvals,
    emit,
    sender,
    activeOrigin,
    networks,
    permissions,
    readChainId,
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
  const { storage } = deps;

  switch (method) {
    // ---- Public surface: callable by any web page ----
    case "eth_chainId":
      return handleChainId(deps);
    case "eth_accounts":
      return handleAccounts(storage, context.origin);
    case "eth_getBalance":
      return handleGetBalance(deps, params);
    case "eth_requestAccounts":
      return handleRequestAccounts(deps, context);
    case "wallet_revokePermissions":
      return handleDisconnect(deps, context.origin);
    case "eth_sendTransaction":
      return handleSendTransaction(deps, context, params);
    case "eth_signTypedData_v4":
      return handleSignTypedData(deps, context, params);
    case "wallet_switchEthereumChain":
      return switchChain(deps, params, "wallet_switchEthereumChain");
    case "wallet_addEthereumChain":
      return addChain(deps, params, {
        origin: context.origin,
        ...(context.tabId === undefined ? {} : { tabId: context.tabId }),
      });

    // ---- Internal surface: extension UI only ----
    case "wallet_createMnemonic":
      return handleCreateMnemonic();
    case "wallet_importMnemonic":
      return handleImportMnemonic(storage, params);
    case "wallet_getState":
      return handleGetState(deps);
    case "wallet_getBalances":
      return handleGetBalances(deps, params);
    case "wallet_setDefaultAccount":
      return handleSetDefaultAccount(storage, params);
    case "wallet_setSiteAccount":
      return handleSetSiteAccount(deps, params);
    case "wallet_setActiveNetwork":
      return switchChain(deps, params, "wallet_setActiveNetwork");
    case "wallet_addNetwork":
      return addNetworkFromWallet(deps, params);
    case "wallet_removeNetwork":
      return removeNetworkRpc(deps, params);
    case "wallet_getConnectedSites":
      return handleGetConnectedSites(storage);
    case "wallet_disconnectSite":
      return handleDisconnect(deps, parseOriginParam(params, "wallet_disconnectSite"));
    case "wallet_getPendingRequest":
      return handleGetPendingRequest(deps, params);
    case "wallet_reset":
      return handleReset(deps);
    default:
      // Every method in the contract is implemented now. This is typos, and
      // anything a page invents.
      throw new ProviderError(ProviderErrors.unsupportedMethod(method));
  }
}

// ============================================================================
// Public methods
// ============================================================================

async function handleChainId({ networks }: HandlerContext): Promise<Hex> {
  return (await networks.read()).chainId;
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
  { fetchBalanceAt, networks }: HandlerContext,
  params: unknown[],
): Promise<Hex> {
  const { address, blockTag } = parseGetBalanceParams(params);
  const network = await resolveActiveNetwork(networks);

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
 * ---------------------------------------------------------------------------
 * THE NETWORK CAN MOVE WHILE THE USER IS DECIDING
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: la solicitud captura el chainId al crearse, y entre eso y la
 * aprobación pueden pasar hasta 120 s. En ese hueco caben tres cosas: el usuario
 * cambia de red en el popup, otra dApp llama a `wallet_switchEthereumChain`, o
 * se revoca un permiso y la wallet cae a Anvil sola.
 *
 * La ventana enseñó una red. Firmar contra otra sería firmar algo que el usuario
 * no aprobó — con otro nonce, otras fees y, en el caso de una firma EIP-712, una
 * firma criptográficamente válida en una cadena que él no eligió. Es la misma
 * política que el desalineamiento de `domain.chainId`: se rechaza, no se avisa.
 *
 * Se comprueba ANTES de leer el mnemonic. No cambia nada de seguridad —el
 * background podría leerlo cuando quisiera— pero mantiene la frase fuera de
 * memoria para una firma que ya sabemos que no va a salir. Hay un test que
 * afirma que `cc:mnemonic` no se llegó a leer.
 */
async function assertChainDidNotDrift(
  networks: NetworkStore,
  approved: NetworkConfig,
): Promise<void> {
  const { chainId } = await networks.read();
  if (chainId === approved.chainId) return;

  throw invalidParams(
    `The wallet moved to another network while you were deciding. This request was approved ` +
      `for ${approved.name} and was not signed.`,
  );
}

/**
 * Signs and sends a transaction, after the user says so.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF THE CHECKS IS THE DESIGN
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: todo lo que puede rechazarse SIN molestar al usuario se rechaza
 * antes de abrir nada — no conectado, params malformados, `from` de otra cuenta,
 * red desconocida. Una ventana de firma que aparece para algo que la wallet ya
 * sabe que va a rechazar enseña a la gente a cerrar ventanas sin leerlas, y esa
 * costumbre es lo que hace que el phishing funcione.
 */
async function handleSendTransaction(
  deps: HandlerContext,
  context: SenderContext,
  params: unknown[],
): Promise<Hex> {
  const { storage, approvals, sender, networks } = deps;
  const origin = context.origin;

  const [sites, accounts] = await Promise.all([
    storage.get("cc:connectedSites"),
    storage.get("cc:accounts"),
  ]);

  const list = accounts ?? [];
  const accountIndex = resolveSiteAccount(sites, origin, list.length);

  if (accountIndex === null) {
    throw new ProviderError(
      ProviderErrors.unauthorized("Connect to this wallet before sending a transaction."),
    );
  }

  // Throws -32602 for a malformed request, or 4100 for someone else's account.
  const transaction = parseTransactionRequest(params, list[accountIndex]);
  const network = await resolveActiveNetwork(networks);

  /**
   * 🇪🇸 NOTA: se estima ANTES de abrir la ventana y el resultado se mete en la
   * propia transacción. Así lo que la ventana enseña es exactamente lo que se va
   * a firmar —mismo gas, mismas fees— y no una estimación que podría diferir de
   * la definitiva. Si falla, los campos se quedan sin poner y la ventana dice
   * que no pudo estimar en vez de inventarse un número.
   */
  const estimate = await sender.estimate({ network, transaction });
  const prepared = estimate === null ? transaction : { ...transaction, ...estimate };

  await approvals.requestSignature({
    origin,
    method: "eth_sendTransaction",
    // The PARSED transaction, not what the dApp sent: the window must render the
    // authorised `from`, never the one the page claimed.
    params: [prepared],
    chainId: network.chainId,
    accountIndex,
    ...(context.tabId === undefined ? {} : { tabId: context.tabId }),
  });

  await assertChainDidNotDrift(networks, network);

  /**
   * 🇪🇸 NOTA: el mnemonic se lee DESPUÉS de la aprobación y no antes. No cambia
   * nada de seguridad —el background podría leerlo cuando quisiera— pero
   * mantiene la frase fuera de memoria durante los hasta 120 s que el usuario
   * puede tardar en decidir, que es la ventana en la que un volcado de memoria
   * del worker sería más probable.
   */
  const phrase = await storage.get("cc:mnemonic");
  if (phrase === undefined || phrase.length === 0) {
    throw new ProviderError(ProviderErrors.internal("The wallet has no key to sign with."));
  }

  return sender.send({ network, phrase, accountIndex, transaction: prepared });
}

/**
 * Signs an EIP-712 payload, after the user says so.
 *
 * 🇪🇸 NOTA: mismo orden que `eth_sendTransaction` — todo lo que se puede
 * rechazar sin molestar al usuario se rechaza antes de abrir nada. Y una
 * diferencia que no se ve: firmar NO necesita red, así que esto funciona con el
 * nodo apagado. Lo único que se consulta de la red es su chainId, y sale de
 * storage.
 */
async function handleSignTypedData(
  deps: HandlerContext,
  context: SenderContext,
  params: unknown[],
): Promise<Hex> {
  const { storage, approvals, sender, networks } = deps;
  const origin = context.origin;

  const [sites, accounts] = await Promise.all([
    storage.get("cc:connectedSites"),
    storage.get("cc:accounts"),
  ]);

  const list = accounts ?? [];
  const accountIndex = resolveSiteAccount(sites, origin, list.length);

  if (accountIndex === null) {
    throw new ProviderError(
      ProviderErrors.unauthorized("Connect to this wallet before signing a message."),
    );
  }

  // Throws -32602 for a malformed payload, or 4100 for someone else's account.
  const { address, payload } = parseTypedDataParams(params, list[accountIndex]);
  const network = await resolveActiveNetwork(networks);

  /**
   * ------------------------------------------------------------------------
   * A SIGNATURE FOR ANOTHER CHAIN IS REFUSED, NOT WARNED ABOUT
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: éste es el caso que de verdad importa de EIP-712. Estás en Anvil,
   * jugando con dinero de mentira, y la dApp te pide firmar algo cuyo dominio
   * dice `chainId: 1`. La firma es criptográficamente válida en MAINNET: si era
   * un `Permit`, alguien acaba de recibir permiso para mover tus tokens de
   * verdad — sin transacción, sin gas y sin nada en el explorador.
   *
   * La sensación de "estoy en una testnet, no puede pasar nada" es justo lo que
   * hace que se firme sin mirar. Por eso se rechaza en vez de avisar: un aviso
   * en una ventana de firma —que no cuesta gas y se percibe inofensiva— se lee
   * todavía menos que un aviso normal. Es además lo que hace MetaMask.
   *
   * Un dominio SIN chainId es legal (un login que vale en cualquier red) y no
   * hay nada que comparar.
   */
  const target = domainChainId(payload);
  if (target !== null && BigInt(target) !== BigInt(network.chainId)) {
    throw invalidParams(
      `This message is for chain ${BigInt(target)}, but the wallet is on ${BigInt(network.chainId)} (${network.name}).`,
    );
  }

  await approvals.requestSignature({
    origin,
    method: "eth_signTypedData_v4",
    // The parsed payload, so the window renders exactly what will be signed —
    // EIP712Domain included if the dApp sent it.
    params: [address, payload],
    chainId: network.chainId,
    accountIndex,
    ...(context.tabId === undefined ? {} : { tabId: context.tabId }),
  });

  /**
   * 🇪🇸 NOTA: también aquí, y no solo en el envío. Una firma EIP-712 no toca la
   * red, así que podría parecer que la red da igual — pero el `domain.chainId`
   * se validó contra la que estaba activa al empezar. Si la wallet se movió, esa
   * validación ya no dice nada y la firma valdría en una cadena que el usuario
   * no eligió, que es justo lo que la comprobación de dominio existe para
   * impedir.
   */
  await assertChainDidNotDrift(networks, network);

  const phrase = await storage.get("cc:mnemonic");
  if (phrase === undefined || phrase.length === 0) {
    throw new ProviderError(ProviderErrors.internal("The wallet has no key to sign with."));
  }

  return sender.signTypedData({ phrase, accountIndex, address, payload });
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
  networks,
  permissions,
}: HandlerContext): Promise<WalletSnapshot> {
  const [mnemonic, accounts, storedIndex, sites, catalogue] = await Promise.all([
    storage.get("cc:mnemonic"),
    storage.get("cc:accounts"),
    storage.get("cc:defaultAccountIndex"),
    storage.get("cc:connectedSites"),
    networks.read(),
  ]);

  const list = accounts ?? [];

  return {
    isLoaded: typeof mnemonic === "string" && mnemonic.length > 0,
    accounts: list,
    defaultAccountIndex: clampAccountIndex(storedIndex, list.length),
    chainId: catalogue.chainId,
    networks: catalogue.networks,
    unusableChainIds: await unusableChains(permissions, catalogue.networks),
    activeSite: await resolveActiveSite(activeOrigin, sites, list.length),
  };
}

/**
 * Which catalogue entries the wallet may not actually reach.
 *
 * ---------------------------------------------------------------------------
 * DERIVED ON EVERY READ, NEVER STORED
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: un flag persistido se queda obsoleto en cuanto el usuario vuelve a
 * conceder el permiso desde `chrome://extensions`, y ahí no hay ningún evento
 * que nos avise justo cuando el popup se abre. Preguntar siempre no puede
 * mentir.
 *
 * El coste es N `contains()` en paralelo, uno por red del catálogo, y está
 * MEDIDO, no supuesto: **0.409 ms de media** por llamada en Chrome con un
 * perfil limpio (comprobación manual 56). Con las dos redes de serie son ~0.8 ms
 * al abrir el popup. Y esto no está en el bucle caliente: el sondeo de saldos
 * cada 5 s llama a `wallet_getBalances`, no a `wallet_getState`, que solo se
 * pide al abrir el popup y después de una acción.
 *
 * Por eso NO hay caché. El umbral que lo haría revisable es 1 ms de media: por
 * encima, habría que cachear mientras el popup está abierto e invalidar con
 * `permissions.onAdded`/`onRemoved`. Estamos a menos de la mitad, y no cachear
 * es una pieza menos de estado mutable en un worker que muere. Si alguien
 * vuelve a plantearlo, que sea corriendo el snippet y comparando con 0.409, no
 * por intuición.
 *
 * Las builtin se comprueban igual que las demás. Están en `host_permissions`,
 * así que deberían salir siempre concedidas — pero si el usuario restringe el
 * acceso a sitios de la extensión dejan de estarlo, y eso es justo lo que hay
 * que poder enseñar. Saltárselas por "seguro que están" escondería el caso.
 */
async function unusableChains(
  permissions: PermissionsPort,
  catalogue: NetworkConfig[],
): Promise<Hex[]> {
  const answers = await Promise.all(
    catalogue.map(async (entry) => ({
      chainId: entry.chainId,
      usable: await hasPermissionFor(permissions, entry.rpcUrl),
    })),
  );

  return answers.filter((entry) => !entry.usable).map((entry) => entry.chainId);
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
  { fetchBalances, networks }: HandlerContext,
  params: unknown[],
): Promise<Record<Address, Hex>> {
  const { addresses } = parseGetBalancesParams(params);
  const network = await resolveActiveNetwork(networks);

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
async function resolveActiveNetwork(networks: NetworkStore): Promise<NetworkConfig> {
  const { networks: catalogue, chainId } = await networks.read();
  const network = catalogue.find((candidate) => candidate.chainId === chainId);

  /**
   * 🇪🇸 NOTA: en la práctica no se alcanza, porque `read()` pasa por la
   * migración y ésa garantiza que el activo existe. Se deja porque el
   * invariante lo sostiene otro módulo: el día que alguien escriba `cc:chainId`
   * sin pasar por el store, esto responde 4902 en vez de reventar con un
   * `undefined.rpcUrl` a mitad de una firma.
   */
  if (network === undefined) {
    throw new ProviderError(ProviderErrors.unrecognizedChain(chainId));
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
