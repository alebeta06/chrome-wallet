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
  type Hex,
  type NetworkConfig,
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
import { DEFAULT_CHAIN_ID, defaultNetworks } from "./networks";
import type { WalletStorage } from "./storage";

export interface DispatcherDeps {
  storage: WalletStorage;
  /**
   * Injected so the RPC handlers can be tested without a node running — the
   * same reason StorageArea is injected.
   */
  fetchBalances?: BalanceReader;
  fetchBalanceAt?: BalanceAtReader;
}

/** Everything the handlers are allowed to reach. Nothing is a module global. */
interface HandlerContext {
  storage: WalletStorage;
  fetchBalances: BalanceReader;
  fetchBalanceAt: BalanceAtReader;
}

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
}: DispatcherDeps): Dispatcher {
  const deps: HandlerContext = { storage, fetchBalances, fetchBalanceAt };

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
    const result = await handle(deps, message.method, message.params);
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

async function handle(
  { storage, fetchBalances, fetchBalanceAt }: HandlerContext,
  method: string,
  params: unknown[],
): Promise<unknown> {
  switch (method) {
    // ---- Public surface: callable by any web page, no permission needed ----
    case "eth_chainId":
      return handleChainId(storage);
    case "eth_accounts":
      return handleAccounts();
    case "eth_getBalance":
      return handleGetBalance(storage, fetchBalanceAt, params);

    // ---- Internal surface: extension UI only ----
    case "wallet_createMnemonic":
      return handleCreateMnemonic();
    case "wallet_importMnemonic":
      return handleImportMnemonic(storage, params);
    case "wallet_getState":
      return handleGetState(storage);
    case "wallet_getBalances":
      return handleGetBalances(storage, fetchBalances, params);
    case "wallet_setDefaultAccount":
      return handleSetDefaultAccount(storage, params);
    case "wallet_reset":
      return handleReset(storage);
    default:
      // Covers the public methods still to come — eth_requestAccounts (phase 5),
      // eth_sendTransaction and eth_signTypedData_v4 (phase 6),
      // wallet_switchEthereumChain (phase 8) — and genuine typos.
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
 * Always the empty array, in this phase and for any unconnected origin.
 *
 * ---------------------------------------------------------------------------
 * THIS FUNCTION READS NOTHING, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: el error clásico es que `eth_accounts` devuelva la cuenta activa.
 * Eso convierte la wallet en un FINGERPRINT: cualquier web que visites sabe tu
 * dirección sin haber pedido permiso, sin abrir una ventana y sin que te enteres
 * — y una dirección de Ethereum es un identificador permanente con todo tu
 * historial de transacciones colgando de él. Devolver `[]` para un origen no
 * conectado es el comportamiento correcto (ver `resolveAccountForOrigin` en el
 * contrato) y es un ítem de la rúbrica.
 *
 * Hasta la Fase 5 no existe `cc:connectedSites`, así que NINGÚN origen está
 * conectado y la respuesta correcta es `[]` siempre. No se lee `cc:accounts` ni
 * `cc:mnemonic`: sin esa lectura, filtrar una dirección desde aquí es
 * imposible de escribir sin que se note. Hay un test que lo comprueba.
 */
function handleAccounts(): Address[] {
  return [];
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

async function handleGetState(storage: WalletStorage): Promise<WalletSnapshot> {
  const [mnemonic, accounts, storedIndex, chainId, networks] = await Promise.all([
    storage.get("cc:mnemonic"),
    storage.get("cc:accounts"),
    storage.get("cc:defaultAccountIndex"),
    storage.get("cc:chainId"),
    storage.get("cc:networks"),
  ]);

  const list = accounts ?? [];

  return {
    isLoaded: typeof mnemonic === "string" && mnemonic.length > 0,
    accounts: list,
    defaultAccountIndex: clampAccountIndex(storedIndex, list.length),
    chainId: chainId ?? DEFAULT_CHAIN_ID,
    networks: networks ?? defaultNetworks(),
    // Connected sites arrive in phase 5; until then no origin has an account.
    activeSite: null,
  };
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

async function handleReset(storage: WalletStorage): Promise<null> {
  await storage.resetWallet();
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
