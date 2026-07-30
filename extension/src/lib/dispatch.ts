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
  type RpcRequestMessage,
  type RpcResponseMessage,
  type WalletSnapshot,
} from "@/types/messages";

import { ProviderError, invalidParams, toSerializedError } from "./errors";
import { createMnemonic, deriveAddresses } from "./hd-wallet";
import { DEFAULT_CHAIN_ID, defaultNetworks } from "./networks";
import type { WalletStorage } from "./storage";

export interface DispatcherDeps {
  storage: WalletStorage;
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
export function createDispatcher({ storage }: DispatcherDeps): Dispatcher {
  return async function dispatch(message, sender, runtimeId) {
    // 1. Who is asking? A null answer means the message did not even come from
    //    this extension.
    const context = classifySender(sender, runtimeId);
    if (context === null) {
      return failure(message.id, ProviderErrors.unauthorized("Unrecognised message sender."));
    }

    try {
      // 2. May they call this? Checked BEFORE anything is read or executed.
      const denied = assertSenderMayCall(context, message.method);
      if (denied !== null) return failure(message.id, denied);

      // 3. Only now does any work happen.
      const result = await handle(storage, message.method, message.params);
      return { type: "CODECRYPTO_RPC_RESULT", id: message.id, ok: true, result };
    } catch (cause) {
      return failure(message.id, toSerializedError(cause, context.fromPage));
    }
  };
}

function failure(id: string, error: ReturnType<typeof ProviderErrors.internal>): RpcResponseMessage {
  return { type: "CODECRYPTO_RPC_RESULT", id, ok: false, error };
}

async function handle(
  storage: WalletStorage,
  method: string,
  params: unknown[],
): Promise<unknown> {
  switch (method) {
    case "wallet_createMnemonic":
      return handleCreateMnemonic();
    case "wallet_importMnemonic":
      return handleImportMnemonic(storage, params);
    case "wallet_getState":
      return handleGetState(storage);
    case "wallet_reset":
      return handleReset(storage);
    default:
      // Covers both the eth_* surface (phase 3+) and genuine typos.
      throw new ProviderError(ProviderErrors.unsupportedMethod(method));
  }
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

async function handleReset(storage: WalletStorage): Promise<null> {
  await storage.resetWallet();
  return null;
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
