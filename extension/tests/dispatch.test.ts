import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ErrorCode,
  MAX_LOG_ENTRIES,
  type ConnectedSite,
  type LogEntry,
  type Origin,
  type RpcRequestMessage,
  type RpcResponseMessage,
  type SerializedProviderError,
  type WalletSnapshot,
} from "@/types/messages";
import type {
  AddChainRequestInput,
  ApprovalCoordinator,
  ConnectRequestInput,
  SignatureRequestInput,
} from "@/lib/approvals";
import type {
  FeeEstimate,
  SendInput,
  SignTypedDataInput,
  TransactionSender,
} from "@/lib/signer";
import type { EventEmitter } from "@/lib/events";
import { createDispatcher, type DispatcherDeps } from "@/lib/dispatch";
import { createWalletStorage, type StorageArea } from "@/lib/storage";
import type { NetworkStore } from "@/lib/network-store";
import type { PermissionsPort } from "@/lib/permissions";
import { ANVIL_CHAIN_ID, SEPOLIA_CHAIN_ID, defaultNetworks } from "@/lib/networks";
import { ProviderError } from "@/lib/errors";
import type { BalanceAtReader, BalanceReader } from "@/lib/chain";
import { createMemoryStorageArea, type MemoryStorageArea } from "./helpers/memory-storage-area";

const RUNTIME_ID = "codecryptowalletextensionidaaaa";
const ANVIL_PHRASE = "test test test test test test test test test test test junk";
const ANVIL_FIRST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/**
 * The popup. Opened from the toolbar, so Chrome reports no tab at all.
 *
 * 🇪🇸 NOTA: éste es el caso fácil de la UI de la extensión. El difícil —una
 * página de la extensión que SÍ trae tab— es `extensionWindowSender`, abajo.
 */
function uiSender(): chrome.runtime.MessageSender {
  return {
    id: RUNTIME_ID,
    origin: `chrome-extension://${RUNTIME_ID}`,
    url: `chrome-extension://${RUNTIME_ID}/index.html`,
  };
}

/**
 * connect.html or notification.html, opened with chrome.windows.create.
 *
 * 🇪🇸 NOTA: éste es el sender que rompía la suposición original. Una ventana de
 * aprobación vive en su propia pestaña, así que Chrome rellena `sender.tab`
 * exactamente igual que para una web. Si la frontera se decidiera solo con
 * `tab !== undefined`, nuestras propias ventanas de firma cobrarían un 4100 y la
 * wallet no podría aprobar nada. Lo que las separa es el origin.
 */
function extensionWindowSender(): chrome.runtime.MessageSender {
  return {
    id: RUNTIME_ID,
    origin: `chrome-extension://${RUNTIME_ID}`,
    url: `chrome-extension://${RUNTIME_ID}/connect.html`,
    tab: { id: 99 } as chrome.tabs.Tab,
  };
}

/**
 * A web page talking through its content script.
 *
 * `origin` is what makes it a page: `tab` alone is not enough, because our own
 * approval windows have one too. Chrome fills both in, and neither is
 * forgeable from the page.
 */
function pageSender(origin = "https://dapp.example"): chrome.runtime.MessageSender {
  return { id: RUNTIME_ID, origin, url: `${origin}/`, tab: { id: 42 } as chrome.tabs.Tab };
}

function request(method: string, params: unknown[] = []): RpcRequestMessage {
  return { type: "CODECRYPTO_RPC", id: "req-1", method, params };
}

function setup(
  seed: Record<string, unknown> = {},
  fetchBalances?: BalanceReader,
  fetchBalanceAt?: BalanceAtReader,
  extra: Partial<DispatcherDeps> = {},
) {
  const area = createMemoryStorageArea(seed);

  /**
   * Records which storage keys were READ. Used by the no-emission test below:
   * a method that never asks for cc:connectedSites structurally cannot target
   * a dApp origin.
   */
  const readKeys: string[] = [];
  const observedArea: StorageArea = {
    get(keys) {
      readKeys.push(...keys);
      return area.get(keys);
    },
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };

  return {
    area,
    readKeys,
    dispatch: createDispatcher({
      storage: createWalletStorage(observedArea),
      ...(fetchBalances === undefined ? {} : { fetchBalances }),
      ...(fetchBalanceAt === undefined ? {} : { fetchBalanceAt }),
      ...extra,
    }),
  };
}

/** Records every provider event the dispatcher tried to emit. */
function recordingEmitter() {
  const emitted: Array<{ eventName: string; data: unknown; changedOrigin: Origin | null }> = [];

  const emit: EventEmitter = async (eventName, data, options) => {
    emitted.push({ eventName, data, changedOrigin: options.changedOrigin });
  };

  return { emit, emitted };
}

/** An approval coordinator whose answer the test decides up front. */
function fakeApprovals(outcome: { approve: number } | { reject: SerializedProviderError }) {
  const asked: ConnectRequestInput[] = [];
  const signed: SignatureRequestInput[] = [];
  const chains: AddChainRequestInput[] = [];

  const approvals: ApprovalCoordinator = {
    requestConnect: async (input) => {
      asked.push(input);
      if ("approve" in outcome) return outcome.approve;
      throw new ProviderError(outcome.reject);
    },
    requestSignature: async (input) => {
      signed.push(input);
      if (!("approve" in outcome)) throw new ProviderError(outcome.reject);
    },
    requestAddChain: async (input) => {
      chains.push(input);
      if (!("approve" in outcome)) throw new ProviderError(outcome.reject);
    },
    settle: async () => {},
    reject: async () => {},
    read: async () => null,
  };

  return { approvals, asked, signed, chains };
}

/**
 * A store whose active chain is not in its own catalogue.
 *
 * 🇪🇸 NOTA: ese estado no se puede producir por storage, porque la migración lo
 * corrige al leer. Existe para cubrir la rama defensiva de
 * `resolveActiveNetwork`, que protege contra que alguien escriba `cc:chainId`
 * sin pasar por el store.
 */
function brokenNetworkStore(): NetworkStore {
  return {
    read: async () => ({ networks: defaultNetworks(), chainId: "0xdead" }),
    migrate: async () => ({ networks: defaultNetworks(), chainId: "0xdead" }),
    active: async () => undefined,
    setActive: async () => false,
    upsert: async () => defaultNetworks(),
    remove: async () => ({ ok: false, reason: "not-found" }),
    fallbackIfUnusable: async () => null,
  };
}

/** The activity log as it currently stands in storage. */
function logsIn(area: MemoryStorageArea): LogEntry[] {
  return (area.snapshot()["cc:logs"] as LogEntry[] | undefined) ?? [];
}

function expectError(response: RpcResponseMessage, code: number): void {
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error("expected a failure response");
  expect(response.error.code).toBe(code);
}

function expectResult<T>(response: RpcResponseMessage): T {
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(`expected a success response, got ${response.error.message}`);
  return response.result as T;
}

describe("the trust boundary", () => {
  /**
   * 🇪🇸 NOTA: éste es EL test de la fase. Si un día alguien reordena el
   * despachador y ejecuta el handler antes de comprobar el emisor, cualquier web
   * que visites podrá llamar a wallet_importMnemonic. El test no comprueba solo
   * el código de error: comprueba además que no se escribió nada, porque un
   * 4100 devuelto DESPUÉS de haber persistido el mnemonic no sirve de nada.
   */
  it("rejects an internal method coming from a web page with 4100", async () => {
    const { area, dispatch } = setup();

    const response = await dispatch(
      request("wallet_importMnemonic", [{ phrase: ANVIL_PHRASE, accountCount: 5 }]),
      pageSender(),
      RUNTIME_ID,
    );

    expectError(response, ErrorCode.UNAUTHORIZED);

    /**
     * 🇪🇸 NOTA: desde la Fase 3 este intento SÍ deja rastro — un intento de una
     * web de llamar a un método interno es exactamente lo que un registro de
     * actividad tiene que recoger. Lo que no puede pasar es que la frase que
     * venía en los params acabe escrita: por eso la aserción no es "no se
     * escribió nada" sino "no se escribió nada de la wallet, y lo que sí se
     * escribió no lleva el mnemonic dentro".
     */
    expect(area.keys()).toEqual(["cc:logs"]);
    expect(JSON.stringify(area.snapshot())).not.toContain("junk");
  });

  it.each([
    "wallet_getState",
    "wallet_createMnemonic",
    "wallet_importMnemonic",
    "wallet_reset",
  ])("rejects %s from a web page", async (method) => {
    const { dispatch } = setup();
    expectError(await dispatch(request(method), pageSender(), RUNTIME_ID), ErrorCode.UNAUTHORIZED);
  });

  it("rejects a sender that is not this extension", async () => {
    const { dispatch } = setup();
    const foreign: chrome.runtime.MessageSender = {
      id: "someotherextensionidbbbbbbbbbbbb",
      origin: "chrome-extension://someotherextensionidbbbbbbbbbbbb",
      url: "chrome-extension://someotherextensionidbbbbbbbbbbbb/popup.html",
    };

    expectError(await dispatch(request("wallet_getState"), foreign, RUNTIME_ID), ErrorCode.UNAUTHORIZED);
  });

  /**
   * ------------------------------------------------------------------------
   * NINGÚN MÉTODO PÚBLICO RESPONDE 4100 A UNA PÁGINA
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: este test se ha mudado cada dos fases. Empezó en `eth_accounts`,
   * pasó por `eth_requestAccounts`, `eth_sendTransaction`,
   * `eth_signTypedData_v4` y `wallet_switchEthereumChain`, siempre apuntando al
   * método público que todavía no estaba implementado y afirmando que daba 4200
   * y no 4100. Con `wallet_addEthereumChain` en su sitio ya no queda ninguno, así
   * que en vez de borrarlo se escribe la propiedad que perseguía y que no
   * caduca: la puerta deja pasar la superficie pública ENTERA.
   *
   * Se llama a cada método público con params vacíos desde un origen conectado.
   * Da igual con qué fallen —casi todos con -32602— porque lo que se afirma es
   * lo que NO pueden contestar: un 4100 aquí significaría que la frontera está
   * rechazando métodos públicos, y ninguna dApp podría hablar con la wallet.
   *
   * El origen va conectado a propósito: sin conexión, un 4100 de
   * `eth_sendTransaction` sería correcto y taparía el caso que importa.
   */
  it.each([
    "eth_requestAccounts",
    "eth_accounts",
    "eth_chainId",
    "eth_getBalance",
    "eth_sendTransaction",
    "eth_signTypedData_v4",
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "wallet_revokePermissions",
  ])("never answers 4100 to a connected page for %s", async (method) => {
    const { dispatch } = setup(CONNECTED);

    const response = await dispatch(request(method), pageSender(LOCAL), RUNTIME_ID);

    if (!response.ok) expect(response.error.code).not.toBe(ErrorCode.UNAUTHORIZED);
  });

  it("answers an unknown method with 4200", async () => {
    const { dispatch } = setup();
    expectError(await dispatch(request("wallet_doesNotExist"), uiSender(), RUNTIME_ID), ErrorCode.UNSUPPORTED_METHOD);
  });
});

/**
 * Regression tests for the sender classification fix.
 *
 * 🇪🇸 NOTA: la suite anterior tenía 68 tests en verde ANTES y DESPUÉS del
 * arreglo del contrato, o sea que ninguno cubría el caso. El motivo es que
 * todos los senders con `tab` que se usaban eran webs, y todos los senders de la
 * UI no tenían `tab`. La combinación peligrosa —tab definido Y origin propio—
 * no aparecía en ninguna parte, así que el bug era invisible para los tests.
 *
 * Lo que decide la frontera es el origin, no la presencia de `tab`:
 *
 *   tab + origin propio        -> UI de la extensión, puede llamar a todo
 *   tab + origin de una web    -> página, solo métodos públicos
 *   tab + origin de otra ext.  -> página, solo métodos públicos
 */
describe("sender classification", () => {
  const INTERNAL_METHOD = "wallet_getState";

  it("allows an internal method from an extension page that has a tab", async () => {
    const { dispatch } = setup();

    const response = await dispatch(request(INTERNAL_METHOD), extensionWindowSender(), RUNTIME_ID);

    // connect.html and notification.html live in their own window, so they carry
    // a tab. Rejecting them would make every approval flow impossible.
    const snapshot = expectResult<WalletSnapshot>(response);
    expect(snapshot.isLoaded).toBe(false);
  });

  it.each([
    "wallet_getState",
    "wallet_createMnemonic",
    "wallet_importMnemonic",
    "wallet_reset",
  ])("allows %s from an extension page that has a tab", async (method) => {
    const { dispatch } = setup();

    const response = await dispatch(
      request(method, method === "wallet_importMnemonic" ? [{ phrase: ANVIL_PHRASE, accountCount: 1 }] : []),
      extensionWindowSender(),
      RUNTIME_ID,
    );

    expect(response.ok).toBe(true);
  });

  it("still rejects an internal method from a web page that has a tab", async () => {
    const { dispatch } = setup();

    const response = await dispatch(request(INTERNAL_METHOD), pageSender("https://dapp.example"), RUNTIME_ID);

    expectError(response, ErrorCode.UNAUTHORIZED);
  });

  /**
   * 🇪🇸 NOTA: el caso que hace que la comprobación tenga que ser contra el
   * runtimeId concreto y no contra el prefijo "chrome-extension://". Otra
   * extensión instalada en el mismo navegador puede inyectar su propio content
   * script y hablarnos; su origin también empieza por chrome-extension://. Si la
   * regla fuera "empieza por chrome-extension:// = de confianza", cualquier otra
   * extensión del navegador podría vaciarte la wallet.
   */
  it("treats another extension's page as a web page", async () => {
    const { dispatch } = setup();
    const otherExtension: chrome.runtime.MessageSender = {
      // Same id: this is OUR content script reporting a page whose origin
      // happens to belong to a different extension.
      id: RUNTIME_ID,
      origin: "chrome-extension://someotherextensionidbbbbbbbbbbbb",
      url: "chrome-extension://someotherextensionidbbbbbbbbbbbb/page.html",
      tab: { id: 13 } as chrome.tabs.Tab,
    };

    expectError(await dispatch(request(INTERNAL_METHOD), otherExtension, RUNTIME_ID), ErrorCode.UNAUTHORIZED);
  });

  it("does not let an origin that merely contains the runtime id through", async () => {
    const { dispatch } = setup();
    const lookalike: chrome.runtime.MessageSender = {
      id: RUNTIME_ID,
      origin: `https://chrome-extension.${RUNTIME_ID}.example`,
      url: `https://chrome-extension.${RUNTIME_ID}.example/`,
      tab: { id: 14 } as chrome.tabs.Tab,
    };

    expectError(await dispatch(request(INTERNAL_METHOD), lookalike, RUNTIME_ID), ErrorCode.UNAUTHORIZED);
  });

  it("keeps letting the tabless popup through", async () => {
    const { dispatch } = setup();

    expect((await dispatch(request(INTERNAL_METHOD), uiSender(), RUNTIME_ID)).ok).toBe(true);
  });
});

describe("wallet_createMnemonic", () => {
  it("returns a 12-word phrase", async () => {
    const { dispatch } = setup();
    const phrase = expectResult<string>(await dispatch(request("wallet_createMnemonic"), uiSender(), RUNTIME_ID));

    expect(phrase.split(" ")).toHaveLength(12);
  });

  /**
   * 🇪🇸 NOTA: la wallet no existe hasta que el usuario confirma que apuntó la
   * frase. Si esto persistiera, quedaría en storage una wallet con un mnemonic
   * que el usuario nunca vio entero y que no puede recuperar.
   */
  it("persists nothing", async () => {
    const { area, dispatch } = setup();

    await dispatch(request("wallet_createMnemonic"), uiSender(), RUNTIME_ID);

    expect(area.keys()).toEqual([]);
  });
});

describe("wallet_importMnemonic", () => {
  it("derives, persists and returns only the addresses", async () => {
    const { area, dispatch } = setup();

    const accounts = expectResult<string[]>(
      await dispatch(
        request("wallet_importMnemonic", [{ phrase: ANVIL_PHRASE, accountCount: 5 }]),
        uiSender(),
        RUNTIME_ID,
      ),
    );

    expect(accounts).toHaveLength(5);
    expect(accounts[0]).toBe(ANVIL_FIRST);

    const stored = area.snapshot();
    expect(stored["cc:mnemonic"]).toBe(ANVIL_PHRASE);
    expect(stored["cc:accounts"]).toEqual(accounts);
    expect(stored["cc:defaultAccountIndex"]).toBe(0);
    expect(stored["cc:chainId"]).toBe(ANVIL_CHAIN_ID);
  });

  it("seeds cc:chainId only when it is missing", async () => {
    const { area, dispatch } = setup({ "cc:chainId": SEPOLIA_CHAIN_ID });

    await dispatch(
      request("wallet_importMnemonic", [{ phrase: ANVIL_PHRASE, accountCount: 1 }]),
      uiSender(),
      RUNTIME_ID,
    );

    // Re-importing must not silently drag the user back to Anvil.
    expect(area.snapshot()["cc:chainId"]).toBe(SEPOLIA_CHAIN_ID);
  });

  it("writes nothing when the phrase is invalid", async () => {
    const { area, dispatch } = setup();

    const response = await dispatch(
      request("wallet_importMnemonic", [{ phrase: "not a real mnemonic at all", accountCount: 1 }]),
      uiSender(),
      RUNTIME_ID,
    );

    expectError(response, ErrorCode.INVALID_PARAMS);
    expect(area.keys()).toEqual([]);
  });

  it.each([
    ["no parameters", [] as unknown[]],
    ["a string instead of an object", ["phrase"]],
    ["a missing phrase", [{ accountCount: 1 }]],
    ["a non-numeric accountCount", [{ phrase: ANVIL_PHRASE, accountCount: "5" }]],
  ])("rejects %s with -32602", async (_label, params) => {
    const { dispatch } = setup();
    expectError(
      await dispatch(request("wallet_importMnemonic", params), uiSender(), RUNTIME_ID),
      ErrorCode.INVALID_PARAMS,
    );
  });
});

describe("wallet_getState", () => {
  it("reports an empty wallet before any import", async () => {
    const { dispatch } = setup();

    const snapshot = expectResult<WalletSnapshot>(
      await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID),
    );

    expect(snapshot.isLoaded).toBe(false);
    expect(snapshot.accounts).toEqual([]);
    expect(snapshot.defaultAccountIndex).toBe(0);
    expect(snapshot.chainId).toBe(ANVIL_CHAIN_ID);
    expect(snapshot.networks.map((network) => network.chainId)).toEqual([
      ANVIL_CHAIN_ID,
      SEPOLIA_CHAIN_ID,
    ]);
    // Connected sites arrive in phase 5.
    expect(snapshot.activeSite).toBeNull();
  });

  it("reports a loaded wallet without leaking the mnemonic", async () => {
    const { dispatch } = setup();
    await dispatch(
      request("wallet_importMnemonic", [{ phrase: ANVIL_PHRASE, accountCount: 3 }]),
      uiSender(),
      RUNTIME_ID,
    );

    const response = await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID);
    const snapshot = expectResult<WalletSnapshot>(response);

    expect(snapshot.isLoaded).toBe(true);
    expect(snapshot.accounts).toHaveLength(3);
    expect(JSON.stringify(response)).not.toContain("junk");
  });

  /**
   * 🇪🇸 NOTA: el caso concreto que obliga a acotar el índice — importas 5
   * cuentas, eliges la 4, reseteas, reimportas con 2. El índice guardado
   * apuntaría a undefined y la UI mostraría una cuenta en blanco sin explicar
   * por qué. TypeScript no ayuda aquí: noUncheckedIndexedAccess está apagado.
   */
  it.each([
    ["an index past the end of accounts", 4],
    ["a negative index", -1],
    ["a non-integer index", 1.5],
  ])("falls back to 0 given %s", async (_label, storedIndex) => {
    const { dispatch } = setup({
      "cc:mnemonic": ANVIL_PHRASE,
      "cc:accounts": [ANVIL_FIRST, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
      "cc:defaultAccountIndex": storedIndex,
    });

    const snapshot = expectResult<WalletSnapshot>(
      await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID),
    );

    expect(snapshot.defaultAccountIndex).toBe(0);
  });

  it("keeps a valid stored index", async () => {
    const { dispatch } = setup({
      "cc:mnemonic": ANVIL_PHRASE,
      "cc:accounts": [ANVIL_FIRST, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
      "cc:defaultAccountIndex": 1,
    });

    const snapshot = expectResult<WalletSnapshot>(
      await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID),
    );

    expect(snapshot.defaultAccountIndex).toBe(1);
  });
});

describe("wallet_reset", () => {
  it("empties the wallet and leaves getState reporting an empty one", async () => {
    const { area, dispatch } = setup({ "cc:logs": [{ id: "1", ts: 0, level: "operation", label: "kept" }] });

    await dispatch(
      request("wallet_importMnemonic", [{ phrase: ANVIL_PHRASE, accountCount: 2 }]),
      uiSender(),
      RUNTIME_ID,
    );

    const reset = await dispatch(request("wallet_reset"), uiSender(), RUNTIME_ID);
    expect(expectResult<null>(reset)).toBeNull();

    const snapshot = expectResult<WalletSnapshot>(
      await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID),
    );
    expect(snapshot.isLoaded).toBe(false);
    expect(snapshot.accounts).toEqual([]);

    // Logs survive a reset by design (spec 24).
    expect(area.keys()).toContain("cc:logs");
  });
});

describe("unexpected failures", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /** A storage layer that blows up, standing in for any dependency going wrong. */
  function brokenStorage() {
    return createDispatcher({
      storage: {
        get: () => Promise.reject(new Error("storage exploded")),
        set: () => Promise.resolve(),
        setMany: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        resetWallet: () => Promise.resolve(),
      },
    });
  }

  it("never rejects — a thrown dependency becomes a failure response", async () => {
    const dispatch = brokenStorage();

    const response = await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID);

    expectError(response, ErrorCode.INTERNAL);
  });

  it("gives the extension UI the real message and detail", async () => {
    const dispatch = brokenStorage();

    const response = await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID);

    if (response.ok) throw new Error("expected a failure response");
    expect(response.error.message).toBe("storage exploded");
    expect(response.error.data).toMatchObject({ name: "Error", message: "storage exploded" });
  });
});

const ANVIL_SECOND = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ONE_ETH = "0xde0b6b3a7640000";

/** A wallet mid-life: imported, with a non-zero default account selected. */
const LOADED_WALLET = {
  "cc:mnemonic": ANVIL_PHRASE,
  "cc:accounts": [ANVIL_FIRST, ANVIL_SECOND],
  "cc:defaultAccountIndex": 0,
  "cc:chainId": ANVIL_CHAIN_ID,
};

describe("wallet_getBalances", () => {
  it("asks the reader for the active network and returns what it says", async () => {
    const reader = vi.fn<BalanceReader>(async () => ({ [ANVIL_FIRST]: ONE_ETH }));
    const { dispatch } = setup(LOADED_WALLET, reader);

    const response = await dispatch(
      request("wallet_getBalances", [{ addresses: [ANVIL_FIRST] }]),
      uiSender(),
      RUNTIME_ID,
    );

    expect(expectResult<Record<string, string>>(response)).toEqual({ [ANVIL_FIRST]: ONE_ETH });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0][0].chainId).toBe(ANVIL_CHAIN_ID);
    expect(reader.mock.calls[0][1]).toEqual([ANVIL_FIRST]);
  });

  it("follows cc:chainId to a different network", async () => {
    const reader = vi.fn<BalanceReader>(async () => ({}));
    const { dispatch } = setup({ ...LOADED_WALLET, "cc:chainId": SEPOLIA_CHAIN_ID }, reader);

    await dispatch(request("wallet_getBalances", [{ addresses: [ANVIL_FIRST] }]), uiSender(), RUNTIME_ID);

    expect(reader.mock.calls[0][0].chainId).toBe(SEPOLIA_CHAIN_ID);
    expect(reader.mock.calls[0][0].rpcUrl).toBe("https://sepolia.drpc.org");
  });

  /**
   * 🇪🇸 NOTA: 4901 y no -32603, y la diferencia es lo que hace que el popup
   * pueda seguir siendo útil con Anvil apagado. -32603 significa "hay un bug";
   * 4901 significa "tu wallet está bien, el nodo no contesta". La UI muestra las
   * cuentas igual y solo avisa de los saldos.
   */
  it("surfaces an unreachable node as 4901, not as an opaque internal error", async () => {
    const reader = vi.fn<BalanceReader>(async () => {
      throw new ProviderError({
        code: ErrorCode.CHAIN_DISCONNECTED,
        message: "Cannot reach the RPC endpoint for Anvil Local.",
      });
    });
    const { dispatch } = setup(LOADED_WALLET, reader);

    const response = await dispatch(
      request("wallet_getBalances", [{ addresses: [ANVIL_FIRST] }]),
      uiSender(),
      RUNTIME_ID,
    );

    expectError(response, ErrorCode.CHAIN_DISCONNECTED);
    expect(response.ok).toBe(false);
  });

  /**
   * ------------------------------------------------------------------------
   * A DANGLING ACTIVE CHAIN HEALS. IT DOES NOT BRICK THE WALLET
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: hasta la Fase 8 esto respondía 4902 y era lo mejor que se podía
   * hacer, porque el catálogo vivía en el código y un `cc:chainId` colgando no
   * tenía arreglo posible. Con el catálogo en storage sí lo tiene: la migración
   * clampa el activo al DEFAULT cuando no existe.
   *
   * El cambio importa porque el caso deja de ser hipotético. Borrar una red o
   * que se revoque un permiso puede dejar el activo apuntando a nada, y una
   * wallet que responde 4902 a CADA lectura de saldo por eso está inutilizable
   * sin que el usuario tenga forma de saber por qué. Caer a Anvil es visible en
   * el selector y reversible en un clic.
   */
  it("falls back to Anvil when cc:chainId points at a network that is gone", async () => {
    const reader = vi.fn<BalanceReader>(async () => ({}));
    const { dispatch } = setup({ ...LOADED_WALLET, "cc:chainId": "0xdead" }, reader);

    const response = await dispatch(
      request("wallet_getBalances", [{ addresses: [ANVIL_FIRST] }]),
      uiSender(),
      RUNTIME_ID,
    );

    expect(response.ok).toBe(true);
    expect(reader).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: ANVIL_CHAIN_ID }),
      [ANVIL_FIRST],
    );
  });

  /**
   * 🇪🇸 NOTA: la rama del 4902 sigue existiendo y ya no se puede alcanzar por
   * storage — la migración lo impide. Se cubre inyectando un store roto, que es
   * lo que sería el día que alguien escriba `cc:chainId` sin pasar por él. Sin
   * este test, la rama quedaría muerta y nadie se enteraría de que dejó de
   * funcionar.
   */
  it("still answers 4902 if the catalogue and the active chain disagree", async () => {
    const reader = vi.fn<BalanceReader>(async () => ({}));
    const { dispatch } = setup(LOADED_WALLET, reader, undefined, {
      networks: brokenNetworkStore(),
    });

    expectError(
      await dispatch(
        request("wallet_getBalances", [{ addresses: [ANVIL_FIRST] }]),
        uiSender(),
        RUNTIME_ID,
      ),
      ErrorCode.UNRECOGNIZED_CHAIN,
    );
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([
    ["no parameters", [] as unknown[]],
    ["an empty address list", [{ addresses: [] }]],
    ["a missing address list", [{}]],
    ["a malformed address", [{ addresses: ["0xnothex"] }]],
    ["an address of the wrong length", [{ addresses: ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb922"] }]],
    ["a non-string entry", [{ addresses: [42] }]],
  ])("rejects %s with -32602 and never reaches the network", async (_label, params) => {
    const reader = vi.fn<BalanceReader>(async () => ({}));
    const { dispatch } = setup(LOADED_WALLET, reader);

    expectError(
      await dispatch(request("wallet_getBalances", params), uiSender(), RUNTIME_ID),
      ErrorCode.INVALID_PARAMS,
    );
    expect(reader).not.toHaveBeenCalled();
  });

  it("is not reachable from a web page", async () => {
    const reader = vi.fn<BalanceReader>(async () => ({}));
    const { dispatch } = setup(LOADED_WALLET, reader);

    expectError(
      await dispatch(request("wallet_getBalances", [{ addresses: [ANVIL_FIRST] }]), pageSender(), RUNTIME_ID),
      ErrorCode.UNAUTHORIZED,
    );
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("wallet_setDefaultAccount", () => {
  it("stores a valid index", async () => {
    const { area, dispatch } = setup(LOADED_WALLET);

    const response = await dispatch(
      request("wallet_setDefaultAccount", [{ accountIndex: 1 }]),
      uiSender(),
      RUNTIME_ID,
    );

    expect(expectResult<null>(response)).toBeNull();
    expect(area.snapshot()["cc:defaultAccountIndex"]).toBe(1);
  });

  it.each([
    ["an index past the end", 2],
    ["a negative index", -1],
    ["a non-integer index", 1.5],
  ])("rejects %s with -32602 and leaves the stored index alone", async (_label, accountIndex) => {
    const { area, dispatch } = setup(LOADED_WALLET);

    expectError(
      await dispatch(request("wallet_setDefaultAccount", [{ accountIndex }]), uiSender(), RUNTIME_ID),
      ErrorCode.INVALID_PARAMS,
    );
    expect(area.snapshot()["cc:defaultAccountIndex"]).toBe(0);
  });

  it("rejects when no wallet is loaded", async () => {
    const { dispatch } = setup();

    expectError(
      await dispatch(request("wallet_setDefaultAccount", [{ accountIndex: 0 }]), uiSender(), RUNTIME_ID),
      ErrorCode.INVALID_PARAMS,
    );
  });

  it("is not reachable from a web page", async () => {
    const { area, dispatch } = setup(LOADED_WALLET);

    expectError(
      await dispatch(request("wallet_setDefaultAccount", [{ accountIndex: 1 }]), pageSender(), RUNTIME_ID),
      ErrorCode.UNAUTHORIZED,
    );
    expect(area.snapshot()["cc:defaultAccountIndex"]).toBe(0);
  });

  /**
   * ------------------------------------------------------------------------
   * THE ASYMMETRY THAT DEFINES THE PER-ORIGIN ACCOUNT MODEL
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: el contrato define dos métodos que cambian una cuenta, y solo uno
   * emite:
   *
   *   wallet_setDefaultAccount -> preferencia interna. NO emite nada.
   *   wallet_setSiteAccount    -> vínculo con un origen. Emite accountsChanged,
   *                               y SOLO a las pestañas de ese origen (Fase 8).
   *
   * Si en la Fase 8 alguien añade la emisión al método equivocado, la dApp A se
   * entera de qué cuenta usas en la dApp B. La ventana para ese error es dentro
   * de seis fases; el test que lo impide cuesta escribirlo hoy.
   *
   * La comprobación es ESTRUCTURAL, no un espía sobre chrome.tabs: se afirma que
   * este método no lee `cc:connectedSites` en ningún momento. Sin esa lectura no
   * hay forma de saber a qué origen dirigirse, así que la emisión por origen es
   * imposible de añadir aquí sin que el test se entere.
   */
  it("emits nothing: it never even reads the connected sites", async () => {
    const { readKeys, dispatch } = setup({
      ...LOADED_WALLET,
      "cc:connectedSites": { "https://dapp.example": { origin: "https://dapp.example", accountIndex: 1, connectedAt: 0, lastUsedAt: 0 } },
    });

    await dispatch(request("wallet_setDefaultAccount", [{ accountIndex: 1 }]), uiSender(), RUNTIME_ID);

    expect(readKeys).not.toContain("cc:connectedSites");
  });

  it("writes only cc:defaultAccountIndex", async () => {
    const { area, dispatch } = setup(LOADED_WALLET);
    const before = area.snapshot();

    await dispatch(request("wallet_setDefaultAccount", [{ accountIndex: 1 }]), uiSender(), RUNTIME_ID);

    const after = area.snapshot();
    const changed = Object.keys(after).filter(
      (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
    );
    expect(changed).toEqual(["cc:defaultAccountIndex"]);
  });

  /**
   * The control for the two assertions above. A negative test is worthless if
   * the mechanism behind it can never fire, so this proves the recorder really
   * does capture the reads a handler makes.
   */
  it("(control) the read recorder captures every key a handler reads", async () => {
    const { readKeys, dispatch } = setup(LOADED_WALLET);

    await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID);

    expect(readKeys).toEqual(
      expect.arrayContaining([
        "cc:mnemonic",
        "cc:accounts",
        "cc:defaultAccountIndex",
        "cc:chainId",
        "cc:networks",
      ]),
    );
  });
});

describe("the default network catalogue", () => {
  it("hands out a fresh copy so a handler cannot mutate it", () => {
    const first = defaultNetworks();
    first[0].name = "tampered";

    expect(defaultNetworks()[0].name).toBe("Anvil Local");
  });
});

// ============================================================================
// Phase 3 — the public surface a dApp can reach without any permission
// ============================================================================

describe("eth_chainId", () => {
  it("answers a web page with the stored chain id", async () => {
    const { dispatch } = setup({ ...LOADED_WALLET, "cc:chainId": SEPOLIA_CHAIN_ID });

    const chainId = expectResult<string>(
      await dispatch(request("eth_chainId"), pageSender(), RUNTIME_ID),
    );

    expect(chainId).toBe(SEPOLIA_CHAIN_ID);
  });

  it("falls back to Anvil when nothing is stored", async () => {
    const { dispatch } = setup();

    expect(expectResult<string>(await dispatch(request("eth_chainId"), pageSender(), RUNTIME_ID))).toBe(
      ANVIL_CHAIN_ID,
    );
  });

  /** No wallet needed: the network is a wallet-wide setting, not an account one. */
  it("works before any wallet exists", async () => {
    const { dispatch } = setup();

    expect((await dispatch(request("eth_chainId"), pageSender(), RUNTIME_ID)).ok).toBe(true);
  });
});

describe("eth_accounts", () => {
  /**
   * 🇪🇸 NOTA: éste es el ítem de la rúbrica. La wallet está CARGADA, con dos
   * cuentas en storage, y la respuesta sigue siendo `[]` porque el origen no
   * está conectado (en la Fase 3 no hay ningún origen conectado). Devolver la
   * cuenta activa convertiría la wallet en un fingerprint: cualquier web sabría
   * tu dirección sin pedir permiso ni abrir una ventana.
   */
  it("returns [] even with a loaded wallet", async () => {
    const { dispatch } = setup(LOADED_WALLET);

    const accounts = expectResult<string[]>(
      await dispatch(request("eth_accounts"), pageSender(), RUNTIME_ID),
    );

    expect(accounts).toEqual([]);
  });

  it("returns [] for every origin, not just one", async () => {
    const { dispatch } = setup(LOADED_WALLET);

    for (const origin of ["https://a.example", "https://b.example", "http://localhost:8080"]) {
      const accounts = expectResult<string[]>(
        await dispatch(request("eth_accounts"), pageSender(origin), RUNTIME_ID),
      );
      expect(accounts).toEqual([]);
    }
  });

  /**
   * The structural assertion, INVERTED in phase 5.
   *
   * 🇪🇸 NOTA: hasta la Fase 4 esto afirmaba que el handler NO leía `cc:accounts`
   * — con la respuesta fija en `[]`, no leer nada demostraba que no podía
   * filtrar una dirección. Desde la Fase 5 la respuesta depende de quién
   * pregunta, así que leer las cuentas es obligatorio y aquella aserción ya no
   * describe nada.
   *
   * El invariante equivalente hoy es el contrario: el handler TIENE que leer
   * `cc:connectedSites`. Sin esa lectura no hay forma de saber si el origen
   * tiene permiso, y devolver una dirección sería devolverla incondicionalmente
   * — que es exactamente el fingerprint que se quiere evitar. La aserción se da
   * la vuelta porque el invariante se dio la vuelta, no para poner el test en
   * verde.
   *
   * `cc:mnemonic` sigue sin leerse, y eso no cambia en ninguna fase.
   */
  it("decides from the connected sites, not from the wallet alone", async () => {
    const { readKeys, dispatch } = setup(LOADED_WALLET);

    await dispatch(request("eth_accounts"), pageSender(), RUNTIME_ID);

    expect(readKeys).toContain("cc:connectedSites");
    expect(readKeys).not.toContain("cc:mnemonic");
  });

  /**
   * ------------------------------------------------------------------------
   * THE PER-ORIGIN MODEL, END TO END THROUGH THE DISPATCHER
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: dos dApps conectadas a la vez, a cuentas distintas, preguntando lo
   * mismo y recibiendo respuestas distintas. Ésta es la fase entera en un test.
   */
  it("answers each connected origin with its own account", async () => {
    const { dispatch } = setup({
      ...LOADED_WALLET,
      "cc:connectedSites": {
        "https://vercel.example": {
          origin: "https://vercel.example",
          accountIndex: 1,
          connectedAt: 0,
          lastUsedAt: 0,
        },
        "http://localhost:3000": {
          origin: "http://localhost:3000",
          accountIndex: 0,
          connectedAt: 0,
          lastUsedAt: 0,
        },
      },
    });

    const fromVercel = expectResult<string[]>(
      await dispatch(request("eth_accounts"), pageSender("https://vercel.example"), RUNTIME_ID),
    );
    const fromLocal = expectResult<string[]>(
      await dispatch(request("eth_accounts"), pageSender("http://localhost:3000"), RUNTIME_ID),
    );

    expect(fromVercel).toEqual([ANVIL_SECOND]);
    expect(fromLocal).toEqual([ANVIL_FIRST]);
    // And neither learns anything about the other.
    expect(fromVercel).not.toContain(ANVIL_FIRST);
    expect(fromLocal).not.toContain(ANVIL_SECOND);
  });

  it("still answers [] to a third origin that never connected", async () => {
    const { dispatch } = setup({
      ...LOADED_WALLET,
      "cc:connectedSites": {
        "https://vercel.example": {
          origin: "https://vercel.example",
          accountIndex: 1,
          connectedAt: 0,
          lastUsedAt: 0,
        },
      },
    });

    expect(
      expectResult<string[]>(
        await dispatch(request("eth_accounts"), pageSender("https://evil.example"), RUNTIME_ID),
      ),
    ).toEqual([]);
  });

  /**
   * 🇪🇸 NOTA: se devuelve UNA cuenta, no la lista entera. El sitio conectado no
   * tiene por qué enterarse de cuántas cuentas tienes ni de cuáles son las
   * demás; mandar el array completo filtraría el tamaño de la wallet y todas las
   * direcciones de golpe.
   */
  it("exposes one account, never the whole wallet", async () => {
    const { dispatch } = setup({
      ...LOADED_WALLET,
      "cc:connectedSites": {
        "https://dapp.example": {
          origin: "https://dapp.example",
          accountIndex: 0,
          connectedAt: 0,
          lastUsedAt: 0,
        },
      },
    });

    const accounts = expectResult<string[]>(
      await dispatch(request("eth_accounts"), pageSender("https://dapp.example"), RUNTIME_ID),
    );

    expect(accounts).toHaveLength(1);
    expect(accounts).not.toContain(ANVIL_SECOND);
  });

  /** Connected to account 1, then re-imported with fewer accounts. */
  it("answers [] when the stored index no longer fits", async () => {
    const { dispatch } = setup({
      "cc:mnemonic": ANVIL_PHRASE,
      "cc:accounts": [ANVIL_FIRST],
      "cc:chainId": ANVIL_CHAIN_ID,
      "cc:connectedSites": {
        "https://dapp.example": {
          origin: "https://dapp.example",
          accountIndex: 1,
          connectedAt: 0,
          lastUsedAt: 0,
        },
      },
    });

    expect(
      expectResult<string[]>(
        await dispatch(request("eth_accounts"), pageSender("https://dapp.example"), RUNTIME_ID),
      ),
    ).toEqual([]);
  });

  it("does not leak the mnemonic through the response", async () => {
    const { dispatch } = setup(LOADED_WALLET);

    const response = await dispatch(request("eth_accounts"), pageSender(), RUNTIME_ID);

    expect(JSON.stringify(response)).not.toContain("junk");
  });
});

describe("eth_getBalance", () => {
  const AT_LATEST = "0x8ac7230489e80000";

  function balanceSetup(seed: Record<string, unknown> = LOADED_WALLET) {
    const reader = vi.fn<BalanceAtReader>(async () => AT_LATEST as `0x${string}`);
    return { reader, ...setup(seed, undefined, reader) };
  }

  it("reads the address on the active network and returns what the node says", async () => {
    const { reader, dispatch } = balanceSetup();

    const balance = expectResult<string>(
      await dispatch(request("eth_getBalance", [ANVIL_FIRST]), pageSender(), RUNTIME_ID),
    );

    expect(balance).toBe(AT_LATEST);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0][0].chainId).toBe(ANVIL_CHAIN_ID);
    expect(reader.mock.calls[0][1]).toBe(ANVIL_FIRST);
  });

  it("defaults the block tag to latest", async () => {
    const { reader, dispatch } = balanceSetup();

    await dispatch(request("eth_getBalance", [ANVIL_FIRST]), pageSender(), RUNTIME_ID);

    expect(reader.mock.calls[0][2]).toBe("latest");
  });

  it.each(["latest", "pending", "earliest", "0x1", "0xA4B1"])(
    "passes the %s block tag through",
    async (blockTag) => {
      const { reader, dispatch } = balanceSetup();

      await dispatch(request("eth_getBalance", [ANVIL_FIRST, blockTag]), pageSender(), RUNTIME_ID);

      expect(reader.mock.calls[0][2]).toBe(blockTag);
    },
  );

  /** Some dApps send an explicit null instead of omitting the argument. */
  it("treats a null block tag as latest", async () => {
    const { reader, dispatch } = balanceSetup();

    await dispatch(request("eth_getBalance", [ANVIL_FIRST, null]), pageSender(), RUNTIME_ID);

    expect(reader.mock.calls[0][2]).toBe("latest");
  });

  it("follows cc:chainId to a different network", async () => {
    const { reader, dispatch } = balanceSetup({ ...LOADED_WALLET, "cc:chainId": SEPOLIA_CHAIN_ID });

    await dispatch(request("eth_getBalance", [ANVIL_FIRST]), pageSender(), RUNTIME_ID);

    expect(reader.mock.calls[0][0].rpcUrl).toBe("https://sepolia.drpc.org");
  });

  /**
   * 🇪🇸 NOTA: `eth_getBalance` es público, así que sus params son entrada
   * hostil. Lo que se afirma aquí no es solo el -32602: es que el lector NUNCA
   * se llamó. Validar después de abrir la conexión sería validar tarde.
   */
  it.each([
    ["no parameters", [] as unknown[]],
    ["a non-hex address", ["0xnothex"]],
    ["an address of the wrong length", ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb922"]],
    ["a numeric address", [42]],
    ["an invented block tag", [ANVIL_FIRST, "yesterday"]],
    ["a numeric block tag", [ANVIL_FIRST, 12]],
    ["a hex block tag with no digits", [ANVIL_FIRST, "0x"]],
  ])("rejects %s with -32602 and never reaches the network", async (_label, params) => {
    const { reader, dispatch } = balanceSetup();

    expectError(
      await dispatch(request("eth_getBalance", params), pageSender(), RUNTIME_ID),
      ErrorCode.INVALID_PARAMS,
    );
    expect(reader).not.toHaveBeenCalled();
  });

  /** Same healing as wallet_getBalances; see the note there. */
  it("falls back to Anvil when cc:chainId points at a network that is gone", async () => {
    const { reader, dispatch } = balanceSetup({ ...LOADED_WALLET, "cc:chainId": "0xdead" });

    await dispatch(request("eth_getBalance", [ANVIL_FIRST]), pageSender(), RUNTIME_ID);

    expect(reader).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: ANVIL_CHAIN_ID }),
      ANVIL_FIRST,
      "latest",
    );
  });

  it("surfaces an unreachable node as 4901", async () => {
    const reader = vi.fn<BalanceAtReader>(async () => {
      throw new ProviderError({
        code: ErrorCode.CHAIN_DISCONNECTED,
        message: "Cannot reach the RPC endpoint for Anvil Local.",
      });
    });
    const { dispatch } = setup(LOADED_WALLET, undefined, reader);

    expectError(
      await dispatch(request("eth_getBalance", [ANVIL_FIRST]), pageSender(), RUNTIME_ID),
      ErrorCode.CHAIN_DISCONNECTED,
    );
  });

  /** No wallet loaded: the balance of an arbitrary address is public chain data. */
  it("works before any wallet exists", async () => {
    const { dispatch } = balanceSetup({});

    expect(
      (await dispatch(request("eth_getBalance", [ANVIL_FIRST]), pageSender(), RUNTIME_ID)).ok,
    ).toBe(true);
  });
});

// ============================================================================
// Phase 3 — the activity log (specs 13-16)
// ============================================================================

describe("the activity log", () => {
  it("records a call from a web page, with its origin", async () => {
    const { area, dispatch } = setup(LOADED_WALLET);

    await dispatch(request("eth_chainId"), pageSender("https://dapp.example"), RUNTIME_ID);

    const entries = logsIn(area);
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("call");
    expect(entries[0].label).toBe("eth_chainId");
    expect(entries[0].origin).toBe("https://dapp.example");
  });

  /**
   * 🇪🇸 NOTA: el popup consulta saldos cada 5 s. Con MAX_LOG_ENTRIES = 500 —y
   * ese número vive en el contrato inmutable— eso barre el registro entero en
   * cuarenta minutos y entierra toda la actividad real de dApps, que es
   * justamente lo que las specs 13-16 quieren ver.
   */
  it("records nothing when the extension's own UI calls", async () => {
    const { area, dispatch } = setup(LOADED_WALLET);

    await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID);
    await dispatch(request("wallet_setDefaultAccount", [{ accountIndex: 1 }]), uiSender(), RUNTIME_ID);

    expect(logsIn(area)).toEqual([]);
  });

  /**
   * 🇪🇸 NOTA: se usa una llamada malformada y no un método sin implementar. Lo
   * que se prueba aquí es el REGISTRO —que una llamada fallida deja las dos
   * entradas—, y colgarlo de "un método que todavía no existe" ataba el test al
   * calendario de las fases: cada vez que se implementaba uno, este test se caía
   * por un motivo que no tiene nada que ver con lo que comprueba. Un param
   * inválido falla igual hoy y dentro de tres fases.
   */
  it("records the call and then the error when a call fails", async () => {
    const { area, dispatch } = setup(LOADED_WALLET);

    await dispatch(request("eth_getBalance", ["0xnothex"]), pageSender(), RUNTIME_ID);

    const entries = logsIn(area);
    expect(entries.map((entry) => entry.level)).toEqual(["call", "error"]);
    expect(entries[1].detail).toMatchObject({ code: ErrorCode.INVALID_PARAMS });
  });

  it("keeps the params of a harmless public call", async () => {
    const { area, dispatch } = setup(LOADED_WALLET, undefined, vi.fn<BalanceAtReader>(async () => "0x0"));

    await dispatch(request("eth_getBalance", [ANVIL_FIRST]), pageSender(), RUNTIME_ID);

    expect(logsIn(area)[0].detail).toEqual([ANVIL_FIRST]);
  });

  /**
   * ------------------------------------------------------------------------
   * THE RULE ESTABLISHED BEFORE THERE IS ANYTHING TO BREAK
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: en la Fase 3 no existe la firma, así que este test no protege
   * ningún secreto todavía. Ése es el motivo de escribirlo hoy: cuando la Fase 6
   * implemente `eth_sendTransaction` y `eth_signTypedData_v4`, el test ya está
   * puesto y nadie tiene que acordarse de la regla. Un registro es el sitio más
   * fácil del mundo para filtrar algo, porque se escribe una vez y se lee seis
   * meses después.
   */
  it.each(["eth_sendTransaction", "eth_signTypedData_v4"])(
    "never writes the params of %s",
    async (method) => {
      const { area, dispatch } = setup(LOADED_WALLET);

      await dispatch(
        request(method, [{ from: ANVIL_FIRST, to: ANVIL_SECOND, value: "0xdeadbeef" }]),
        pageSender(),
        RUNTIME_ID,
      );

      expect(logsIn(area)[0].detail).toBe("[redacted]");
      expect(JSON.stringify(logsIn(area))).not.toContain("0xdeadbeef");
    },
  );

  it("never writes the params of an internal method a page tried to call", async () => {
    const { area, dispatch } = setup();

    await dispatch(
      request("wallet_importMnemonic", [{ phrase: ANVIL_PHRASE, accountCount: 5 }]),
      pageSender(),
      RUNTIME_ID,
    );

    expect(logsIn(area)[0].detail).toBe("[redacted]");
    expect(JSON.stringify(logsIn(area))).not.toContain("junk");
  });

  it("keeps at most MAX_LOG_ENTRIES, dropping the oldest", async () => {
    const seeded: LogEntry[] = Array.from({ length: MAX_LOG_ENTRIES }, (_unused, index) => ({
      id: `seed-${index}`,
      ts: index,
      level: "call",
      label: `seeded-${index}`,
    }));
    const { area, dispatch } = setup({ ...LOADED_WALLET, "cc:logs": seeded });

    await dispatch(request("eth_chainId"), pageSender(), RUNTIME_ID);

    const entries = logsIn(area);
    expect(entries).toHaveLength(MAX_LOG_ENTRIES);
    // The oldest is gone and the newest is ours.
    expect(entries[0].label).toBe("seeded-1");
    expect(entries[MAX_LOG_ENTRIES - 1].label).toBe("eth_chainId");
  });

  /**
   * A broken log must never turn a good call into an error for the dApp.
   */
  it("answers the dApp even if the log cannot be written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const dispatch = createDispatcher({
      storage: {
        // Only the log read explodes; everything else behaves like an empty wallet.
        get: (key: string) =>
          key === "cc:logs" ? Promise.reject(new Error("log exploded")) : Promise.resolve(undefined),
        set: () => Promise.resolve(),
        setMany: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        resetWallet: () => Promise.resolve(),
      },
    });

    const response = await dispatch(request("eth_chainId"), pageSender(), RUNTIME_ID);

    expect(response.ok).toBe(true);
  });
});

// ============================================================================
// Phase 5 — per-origin permissions
// ============================================================================

const VERCEL = "https://chrome-wallet.vercel.app";
const LOCAL = "http://localhost:3000";

function connected(origin: string, accountIndex: number): ConnectedSite {
  return { origin, accountIndex, connectedAt: 1_000, lastUsedAt: 1_000 };
}

const CONNECTED = {
  ...LOADED_WALLET,
  "cc:connectedSites": { [LOCAL]: connected(LOCAL, 0) },
};

/** A wallet with two origins already connected to two different accounts. */
const TWO_CONNECTED = {
  ...LOADED_WALLET,
  "cc:connectedSites": {
    [VERCEL]: connected(VERCEL, 1),
    [LOCAL]: connected(LOCAL, 0),
  },
};

describe("eth_requestAccounts", () => {
  /**
   * 🇪🇸 NOTA: un origen ya conectado NO abre ventana. Es lo que hace que
   * recargar una dApp conectada sea instantáneo y silencioso, en vez de una
   * ventana de aprobación en cada F5 — que es como se enseña a la gente a
   * aprobar sin leer.
   */
  it("answers a connected origin without opening anything", async () => {
    const { approvals, asked } = fakeApprovals({ approve: 0 });
    const { area, dispatch } = setup(TWO_CONNECTED, undefined, undefined, { approvals });
    const before = area.snapshot();

    const accounts = expectResult<string[]>(
      await dispatch(request("eth_requestAccounts"), pageSender(VERCEL), RUNTIME_ID),
    );

    expect(accounts).toEqual([ANVIL_SECOND]);
    expect(asked).toEqual([]);
    expect(area.snapshot()["cc:connectedSites"]).toEqual(before["cc:connectedSites"]);
  });

  it("asks the user when the origin is new, then stores the choice", async () => {
    const { approvals, asked } = fakeApprovals({ approve: 1 });
    const { emit, emitted } = recordingEmitter();
    const { area, dispatch } = setup(LOADED_WALLET, undefined, undefined, { approvals, emit });

    const accounts = expectResult<string[]>(
      await dispatch(request("eth_requestAccounts"), pageSender(VERCEL), RUNTIME_ID),
    );

    expect(accounts).toEqual([ANVIL_SECOND]);
    expect(asked).toHaveLength(1);
    expect(asked[0].origin).toBe(VERCEL);
    expect(asked[0].accounts).toEqual([ANVIL_FIRST, ANVIL_SECOND]);

    const sites = area.snapshot()["cc:connectedSites"] as Record<string, ConnectedSite>;
    expect(sites[VERCEL].accountIndex).toBe(1);

    // The other tabs of this origin need telling; the caller already knows.
    expect(emitted).toEqual([
      { eventName: "accountsChanged", data: [ANVIL_SECOND], changedOrigin: VERCEL },
    ]);
  });

  it("suggests the wallet-wide default account", async () => {
    const { approvals, asked } = fakeApprovals({ approve: 0 });
    const { dispatch } = setup(
      { ...LOADED_WALLET, "cc:defaultAccountIndex": 1 },
      undefined,
      undefined,
      { approvals },
    );

    await dispatch(request("eth_requestAccounts"), pageSender(VERCEL), RUNTIME_ID);

    expect(asked[0].suggestedAccountIndex).toBe(1);
  });

  it("passes the tab id through so the window can focus back", async () => {
    const { approvals, asked } = fakeApprovals({ approve: 0 });
    const { dispatch } = setup(LOADED_WALLET, undefined, undefined, { approvals });

    await dispatch(request("eth_requestAccounts"), pageSender(VERCEL), RUNTIME_ID);

    expect(asked[0].tabId).toBe(42);
  });

  it("answers 4001 when the user rejects", async () => {
    const { approvals } = fakeApprovals({
      reject: { code: ErrorCode.USER_REJECTED, message: "User rejected the request." },
    });
    const { area, dispatch } = setup(LOADED_WALLET, undefined, undefined, { approvals });

    expectError(
      await dispatch(request("eth_requestAccounts"), pageSender(VERCEL), RUNTIME_ID),
      ErrorCode.USER_REJECTED,
    );
    expect(area.snapshot()["cc:connectedSites"]).toBeUndefined();
  });

  /**
   * ------------------------------------------------------------------------
   * 4100 AND NOT 4001, AND THE DIFFERENCE IS THE POINT
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: la dApp tiene que poder distinguir "este usuario no tiene wallet
   * configurada" de "este usuario ha dicho que no", porque la reacción correcta
   * es distinta: en un caso enseñas "configura tu wallet", en el otro no
   * enseñas nada y dejas el botón como estaba. Devolver 4001 aquí sería mentir
   * sobre lo que ha pasado.
   */
  it("answers 4100 when there is no wallet, without opening a window", async () => {
    const { approvals, asked } = fakeApprovals({ approve: 0 });
    const { dispatch } = setup({}, undefined, undefined, { approvals });

    const response = await dispatch(
      request("eth_requestAccounts"),
      pageSender(VERCEL),
      RUNTIME_ID,
    );

    expectError(response, ErrorCode.UNAUTHORIZED);
    if (response.ok) throw new Error("expected a failure");
    expect(response.error.message).toContain("No wallet");
    expect(asked).toEqual([]);
  });

  /** Connected to account 1, then re-imported with one account: ask again. */
  it("asks again when the stored index no longer fits", async () => {
    const { approvals, asked } = fakeApprovals({ approve: 0 });
    const { dispatch } = setup(
      {
        "cc:mnemonic": ANVIL_PHRASE,
        "cc:accounts": [ANVIL_FIRST],
        "cc:connectedSites": { [VERCEL]: connected(VERCEL, 1) },
      },
      undefined,
      undefined,
      { approvals },
    );

    const accounts = expectResult<string[]>(
      await dispatch(request("eth_requestAccounts"), pageSender(VERCEL), RUNTIME_ID),
    );

    expect(asked).toHaveLength(1);
    expect(accounts).toEqual([ANVIL_FIRST]);
  });

  it("refuses an approved index that is out of range", async () => {
    const { approvals } = fakeApprovals({ approve: 99 });
    const { area, dispatch } = setup(LOADED_WALLET, undefined, undefined, { approvals });

    expectError(
      await dispatch(request("eth_requestAccounts"), pageSender(VERCEL), RUNTIME_ID),
      ErrorCode.INTERNAL,
    );
    expect(area.snapshot()["cc:connectedSites"]).toBeUndefined();
  });

  it("connects one origin without touching the other", async () => {
    const { approvals } = fakeApprovals({ approve: 0 });
    const { area, dispatch } = setup(
      { ...LOADED_WALLET, "cc:connectedSites": { [VERCEL]: connected(VERCEL, 1) } },
      undefined,
      undefined,
      { approvals },
    );

    await dispatch(request("eth_requestAccounts"), pageSender(LOCAL), RUNTIME_ID);

    const sites = area.snapshot()["cc:connectedSites"] as Record<string, ConnectedSite>;
    expect(sites[VERCEL].accountIndex).toBe(1);
    expect(sites[LOCAL].accountIndex).toBe(0);
  });
});

describe("wallet_setSiteAccount", () => {
  /**
   * ------------------------------------------------------------------------
   * THE ASYMMETRY, FROM THE OTHER SIDE
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: éste SÍ emite, y solo al origen afectado. Su gemelo
   * `wallet_setDefaultAccount` no emite nada y ni siquiera lee
   * `cc:connectedSites` — hay un test estructural desde la Fase 1 que lo fija y
   * sigue en verde. Si la emisión acabara en el método equivocado, la dApp A se
   * enteraría de qué cuenta usas en la dApp B.
   */
  it("emits to the affected origin and to nobody else", async () => {
    const { emit, emitted } = recordingEmitter();
    const { area, dispatch } = setup(TWO_CONNECTED, undefined, undefined, { emit });

    const response = await dispatch(
      request("wallet_setSiteAccount", [{ origin: VERCEL, accountIndex: 0 }]),
      uiSender(),
      RUNTIME_ID,
    );

    expect(expectResult<null>(response)).toBeNull();
    expect(emitted).toEqual([
      { eventName: "accountsChanged", data: [ANVIL_FIRST], changedOrigin: VERCEL },
    ]);

    const sites = area.snapshot()["cc:connectedSites"] as Record<string, ConnectedSite>;
    expect(sites[VERCEL].accountIndex).toBe(0);
    // The other origin is untouched.
    expect(sites[LOCAL].accountIndex).toBe(0);
  });

  it("keeps connectedAt and moves lastUsedAt", async () => {
    const { area, dispatch } = setup(TWO_CONNECTED);

    await dispatch(
      request("wallet_setSiteAccount", [{ origin: VERCEL, accountIndex: 0 }]),
      uiSender(),
      RUNTIME_ID,
    );

    const sites = area.snapshot()["cc:connectedSites"] as Record<string, ConnectedSite>;
    expect(sites[VERCEL].connectedAt).toBe(1_000);
    expect(sites[VERCEL].lastUsedAt).toBeGreaterThan(1_000);
  });

  it("rejects an origin that is not connected", async () => {
    const { emit, emitted } = recordingEmitter();
    const { dispatch } = setup(TWO_CONNECTED, undefined, undefined, { emit });

    expectError(
      await dispatch(
        request("wallet_setSiteAccount", [{ origin: "https://evil.example", accountIndex: 0 }]),
        uiSender(),
        RUNTIME_ID,
      ),
      ErrorCode.INVALID_PARAMS,
    );
    expect(emitted).toEqual([]);
  });

  it.each([
    ["an index past the end", 9],
    ["a negative index", -1],
    ["a non-integer index", 1.5],
  ])("rejects %s and emits nothing", async (_label, accountIndex) => {
    const { emit, emitted } = recordingEmitter();
    const { area, dispatch } = setup(TWO_CONNECTED, undefined, undefined, { emit });

    expectError(
      await dispatch(
        request("wallet_setSiteAccount", [{ origin: VERCEL, accountIndex }]),
        uiSender(),
        RUNTIME_ID,
      ),
      ErrorCode.INVALID_PARAMS,
    );
    expect(emitted).toEqual([]);
    expect((area.snapshot()["cc:connectedSites"] as Record<string, ConnectedSite>)[VERCEL].accountIndex).toBe(1);
  });

  it("is not reachable from a web page", async () => {
    const { dispatch } = setup(TWO_CONNECTED);

    expectError(
      await dispatch(
        request("wallet_setSiteAccount", [{ origin: VERCEL, accountIndex: 0 }]),
        pageSender(VERCEL),
        RUNTIME_ID,
      ),
      ErrorCode.UNAUTHORIZED,
    );
  });
});

describe("disconnecting", () => {
  it("removes the site and tells it with an empty account list", async () => {
    const { emit, emitted } = recordingEmitter();
    const { area, dispatch } = setup(TWO_CONNECTED, undefined, undefined, { emit });

    await dispatch(
      request("wallet_disconnectSite", [{ origin: VERCEL }]),
      uiSender(),
      RUNTIME_ID,
    );

    const sites = area.snapshot()["cc:connectedSites"] as Record<string, ConnectedSite>;
    expect(sites[VERCEL]).toBeUndefined();
    expect(sites[LOCAL]).toBeDefined();
    expect(emitted).toEqual([{ eventName: "accountsChanged", data: [], changedOrigin: VERCEL }]);
  });

  /**
   * 🇪🇸 NOTA: `wallet_revokePermissions` es PÚBLICO — deja que una dApp se
   * desconecte a sí misma, al estilo EIP-2255. Lo importante es que solo puede
   * desconectarse a SÍ MISMA: el origen sale del `SenderContext`, no de los
   * params, así que no hay forma de pedirlo para otro sitio.
   */
  it("lets a dApp revoke its own permission", async () => {
    const { emit, emitted } = recordingEmitter();
    const { area, dispatch } = setup(TWO_CONNECTED, undefined, undefined, { emit });

    const response = await dispatch(
      request("wallet_revokePermissions"),
      pageSender(VERCEL),
      RUNTIME_ID,
    );

    expect(expectResult<null>(response)).toBeNull();
    const sites = area.snapshot()["cc:connectedSites"] as Record<string, ConnectedSite>;
    expect(sites[VERCEL]).toBeUndefined();
    expect(sites[LOCAL]).toBeDefined();
    expect(emitted).toEqual([{ eventName: "accountsChanged", data: [], changedOrigin: VERCEL }]);
  });

  it("cannot revoke another origin's permission even with params", async () => {
    const { area, dispatch } = setup(TWO_CONNECTED);

    // The params are ignored entirely: the origin comes from the sender.
    await dispatch(
      request("wallet_revokePermissions", [{ origin: LOCAL }]),
      pageSender(VERCEL),
      RUNTIME_ID,
    );

    const sites = area.snapshot()["cc:connectedSites"] as Record<string, ConnectedSite>;
    expect(sites[LOCAL]).toBeDefined();
    expect(sites[VERCEL]).toBeUndefined();
  });

  it("is a silent no-op for an origin that was never connected", async () => {
    const { emit, emitted } = recordingEmitter();
    const { dispatch } = setup(TWO_CONNECTED, undefined, undefined, { emit });

    const response = await dispatch(
      request("wallet_revokePermissions"),
      pageSender("https://evil.example"),
      RUNTIME_ID,
    );

    expect(response.ok).toBe(true);
    expect(emitted).toEqual([]);
  });

  it("leaves eth_accounts answering [] afterwards", async () => {
    const { dispatch } = setup(TWO_CONNECTED);

    await dispatch(request("wallet_revokePermissions"), pageSender(VERCEL), RUNTIME_ID);

    expect(
      expectResult<string[]>(
        await dispatch(request("eth_accounts"), pageSender(VERCEL), RUNTIME_ID),
      ),
    ).toEqual([]);
  });
});

describe("wallet_getConnectedSites", () => {
  it("lists the connected origins, most recently used first", async () => {
    const { dispatch } = setup({
      ...LOADED_WALLET,
      "cc:connectedSites": {
        [VERCEL]: { origin: VERCEL, accountIndex: 1, connectedAt: 0, lastUsedAt: 100 },
        [LOCAL]: { origin: LOCAL, accountIndex: 0, connectedAt: 0, lastUsedAt: 900 },
      },
    });

    const sites = expectResult<ConnectedSite[]>(
      await dispatch(request("wallet_getConnectedSites"), uiSender(), RUNTIME_ID),
    );

    expect(sites.map((site) => site.origin)).toEqual([LOCAL, VERCEL]);
  });

  /** A site whose index no longer fits is not connected as far as any dApp is concerned. */
  it("hides a site whose stored index no longer fits", async () => {
    const { dispatch } = setup({
      "cc:mnemonic": ANVIL_PHRASE,
      "cc:accounts": [ANVIL_FIRST],
      "cc:connectedSites": { [VERCEL]: connected(VERCEL, 1), [LOCAL]: connected(LOCAL, 0) },
    });

    const sites = expectResult<ConnectedSite[]>(
      await dispatch(request("wallet_getConnectedSites"), uiSender(), RUNTIME_ID),
    );

    expect(sites.map((site) => site.origin)).toEqual([LOCAL]);
  });

  it("is not reachable from a web page", async () => {
    const { dispatch } = setup(TWO_CONNECTED);

    expectError(
      await dispatch(request("wallet_getConnectedSites"), pageSender(VERCEL), RUNTIME_ID),
      ErrorCode.UNAUTHORIZED,
    );
  });
});

describe("wallet_reset with connected sites", () => {
  /**
   * 🇪🇸 NOTA: sin este aviso, cada dApp abierta seguiría enseñando una cuenta
   * que ya no existe hasta que alguien recargase — la wallet vacía y la web
   * diciendo que tienes fondos.
   */
  it("tells every connected origin before wiping them", async () => {
    const { emit, emitted } = recordingEmitter();
    const { area, dispatch } = setup(TWO_CONNECTED, undefined, undefined, { emit });

    await dispatch(request("wallet_reset"), uiSender(), RUNTIME_ID);

    expect(emitted).toHaveLength(2);
    expect(emitted.map((entry) => entry.changedOrigin).sort()).toEqual([LOCAL, VERCEL].sort());
    expect(emitted.every((entry) => entry.eventName === "accountsChanged")).toBe(true);
    expect(emitted.every((entry) => Array.isArray(entry.data) && entry.data.length === 0)).toBe(true);

    expect(area.snapshot()["cc:connectedSites"]).toBeUndefined();
    // Logs still survive a reset.
    expect(area.keys()).not.toContain("cc:mnemonic");
  });

  it("emits nothing when no site was connected", async () => {
    const { emit, emitted } = recordingEmitter();
    const { dispatch } = setup(LOADED_WALLET, undefined, undefined, { emit });

    await dispatch(request("wallet_reset"), uiSender(), RUNTIME_ID);

    expect(emitted).toEqual([]);
  });
});

/**
 * ---------------------------------------------------------------------------
 * WHICH NETWORKS THE WALLET CAN ACTUALLY REACH
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: `unusableChainIds` se deriva en cada lectura y no se guarda nunca.
 * Un flag persistido se queda obsoleto en cuanto el usuario vuelve a conceder
 * el permiso desde `chrome://extensions`, y no hay ningún evento que nos avise
 * justo cuando el popup se abre.
 */
/**
 * ---------------------------------------------------------------------------
 * THE NETWORK CAN MOVE WHILE THE USER IS DECIDING
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: la ventana de firma puede estar abierta hasta 120 s. En ese hueco el
 * usuario puede cambiar de red en el popup, otra dApp puede llamar a
 * `wallet_switchEthereumChain`, o se puede revocar un permiso y la wallet caer a
 * Anvil sola. La ventana enseñó UNA red; firmar contra otra sería firmar algo
 * que nadie aprobó.
 */
describe("a pending approval whose chain moved", () => {
  /**
   * Approves, and switches the network in between — exactly what the browser
   * can do while the window is open.
   *
   * 🇪🇸 NOTA: el `holder` existe porque el área la crea `setup()` y el
   * coordinador tiene que escribir en ESA, no en otra. Con dos áreas el test
   * pasaría contando una historia falsa: el cambio de red iría a un storage y
   * el despachador leería el otro.
   */
  function switchingApprovals(to: string) {
    const holder: { area?: MemoryStorageArea } = {};

    const approvals: ApprovalCoordinator = {
      requestConnect: async () => 0,
      requestSignature: async () => {
        await holder.area?.set({ "cc:chainId": to });
      },
      requestAddChain: async () => {},
      settle: async () => {},
      reject: async () => {},
      read: async () => null,
    };

    return { approvals, holder };
  }

  function driftingSetup() {
    const { approvals, holder } = switchingApprovals(SEPOLIA_CHAIN_ID);
    const fake = fakeSender();
    const harness = setup(CONNECTED, undefined, undefined, {
      approvals,
      sender: fake.sender,
    });
    holder.area = harness.area;

    return { ...harness, ...fake };
  }

  it("refuses to send, naming the network that was approved", async () => {
    const { dispatch, sent } = driftingSetup();

    const response = await dispatch(
      request("eth_sendTransaction", SEND_PARAMS),
      pageSender(LOCAL),
      RUNTIME_ID,
    );

    expectError(response, ErrorCode.INVALID_PARAMS);
    if (!response.ok) expect(response.error.message).toContain("Anvil Local");
    expect(sent).toEqual([]);
  });

  /**
   * 🇪🇸 NOTA: también para EIP-712, que no toca la red. El `domain.chainId` se
   * validó contra la red que estaba activa al empezar; si la wallet se movió,
   * esa validación ya no dice nada y la firma valdría en una cadena que el
   * usuario no eligió — que es justo lo que la comprobación de dominio existe
   * para impedir.
   */
  it("refuses to sign typed data too", async () => {
    const { dispatch, typedData } = driftingSetup();

    expectError(
      await dispatch(request("eth_signTypedData_v4", signParams()), pageSender(LOCAL), RUNTIME_ID),
      ErrorCode.INVALID_PARAMS,
    );
    expect(typedData).toEqual([]);
  });

  /**
   * ------------------------------------------------------------------------
   * REFUSED BEFORE THE MNEMONIC IS EVEN READ
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: no es seguridad —el background puede leer la frase cuando quiera—
   * es higiene: no se saca el mnemonic a memoria para una firma que ya sabemos
   * que vamos a tirar. Y es una propiedad del ORDEN de las líneas, que es justo
   * lo que un refactor rompe sin darse cuenta y sin que nada más se ponga rojo.
   *
   * `readKeys` registra qué claves se pidieron a storage, así que el test lo
   * afirma en vez de confiar en que alguien lea el código.
   */
  it("never reads cc:mnemonic for a request it is going to refuse", async () => {
    const { dispatch, readKeys } = driftingSetup();

    await dispatch(request("eth_sendTransaction", SEND_PARAMS), pageSender(LOCAL), RUNTIME_ID);

    expect(readKeys).not.toContain("cc:mnemonic");
  });

  it("signs normally when the network did not move", async () => {
    const { sender, sent } = fakeSender();
    const { approvals } = fakeApprovals({ approve: 0 });
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    const response = await dispatch(
      request("eth_sendTransaction", SEND_PARAMS),
      pageSender(LOCAL),
      RUNTIME_ID,
    );

    expect(response.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe("switching the network", () => {
  /**
   * 🇪🇸 NOTA: los dos métodos comparten handler porque el efecto es idéntico, y
   * lo único que los separa —quién puede pedirlo— lo resuelve
   * `assertSenderMayCall` una capa antes. Estos dos tests fijan esa frontera:
   * una web puede pedir el cambio, pero solo por la puerta pública.
   */
  it("lets a dApp call wallet_switchEthereumChain", async () => {
    const { dispatch, area } = setup(LOADED_WALLET);

    const response = await dispatch(
      request("wallet_switchEthereumChain", [{ chainId: SEPOLIA_CHAIN_ID }]),
      pageSender(),
      RUNTIME_ID,
    );

    expect(response.ok).toBe(true);
    expect(area.snapshot()["cc:chainId"]).toBe(SEPOLIA_CHAIN_ID);
  });

  it("refuses wallet_setActiveNetwork from a web page with 4100", async () => {
    const { dispatch, area } = setup(LOADED_WALLET);

    expectError(
      await dispatch(
        request("wallet_setActiveNetwork", [{ chainId: SEPOLIA_CHAIN_ID }]),
        pageSender(),
        RUNTIME_ID,
      ),
      ErrorCode.UNAUTHORIZED,
    );
    expect(area.snapshot()["cc:chainId"]).not.toBe(SEPOLIA_CHAIN_ID);
  });

  it("lets the popup call wallet_setActiveNetwork", async () => {
    const { dispatch, area } = setup(LOADED_WALLET);

    const response = await dispatch(
      request("wallet_setActiveNetwork", [{ chainId: SEPOLIA_CHAIN_ID }]),
      uiSender(),
      RUNTIME_ID,
    );

    expect(response.ok).toBe(true);
    expect(area.snapshot()["cc:chainId"]).toBe(SEPOLIA_CHAIN_ID);
  });

  /**
   * 🇪🇸 NOTA: `eth_chainId` tiene que devolver lo nuevo inmediatamente después.
   * Una dApp que reacciona al `chainChanged` preguntando la red se encontraría
   * el valor viejo si la emisión saliera antes de persistir.
   */
  it("reports the new chain right after switching", async () => {
    const { dispatch } = setup(LOADED_WALLET);

    await dispatch(
      request("wallet_switchEthereumChain", [{ chainId: SEPOLIA_CHAIN_ID }]),
      pageSender(),
      RUNTIME_ID,
    );

    expect(
      expectResult<string>(await dispatch(request("eth_chainId"), pageSender(), RUNTIME_ID)),
    ).toBe(SEPOLIA_CHAIN_ID);
  });
});

describe("WalletSnapshot.unusableChainIds", () => {
  /** A port that grants everything except the patterns it is told to deny. */
  function denying(...denied: string[]): PermissionsPort {
    const blocked = new Set(denied);
    return {
      contains: (pattern) => Promise.resolve(!blocked.has(pattern)),
      remove: () => Promise.resolve(true),
    };
  }

  async function snapshotWith(
    permissions: PermissionsPort,
    seed: Record<string, unknown> = LOADED_WALLET,
  ) {
    const { dispatch } = setup(seed, undefined, undefined, { permissions });
    return expectResult<WalletSnapshot>(
      await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID),
    );
  }

  it("is empty when every host is granted", async () => {
    expect((await snapshotWith(denying())).unusableChainIds).toEqual([]);
  });

  it("lists the network whose host was revoked", async () => {
    const snapshot = await snapshotWith(denying("https://sepolia.drpc.org/*"));

    expect(snapshot.unusableChainIds).toEqual([SEPOLIA_CHAIN_ID]);
    // The network stays in the catalogue: it is unusable, not gone.
    expect(snapshot.networks.map((entry) => entry.chainId)).toContain(SEPOLIA_CHAIN_ID);
  });

  /**
   * 🇪🇸 NOTA: las builtin se comprueban igual que las demás. Están en
   * `host_permissions`, así que normalmente salen concedidas — pero si el
   * usuario restringe el acceso a sitios de la extensión dejan de estarlo, y
   * eso es exactamente lo que hay que poder enseñar. Saltárselas por "seguro
   * que están" escondería el caso.
   */
  it("does not exempt the built-ins", async () => {
    const snapshot = await snapshotWith(
      denying("http://localhost:8545/*", "https://sepolia.drpc.org/*"),
    );

    expect(snapshot.unusableChainIds).toEqual([ANVIL_CHAIN_ID, SEPOLIA_CHAIN_ID]);
  });

  /**
   * 🇪🇸 NOTA: la revocación es POR PATRÓN COMPLETO, puerto incluido — medido en
   * Chrome durante el spike de la Fase 8. Quitar el permiso de `localhost:8545`
   * no toca el de `localhost:8546`, así que una red no puede arrastrar a otra
   * del mismo host.
   */
  it("does not drag another network on the same host", async () => {
    const other = {
      chainId: "0x1a4",
      name: "Second Anvil",
      rpcUrl: "http://localhost:8546",
      symbol: "ETH",
      explorerUrl: null,
      builtIn: false,
    };
    const snapshot = await snapshotWith(denying("http://localhost:8545/*"), {
      ...LOADED_WALLET,
      "cc:networks": [other],
    });

    expect(snapshot.unusableChainIds).toEqual([ANVIL_CHAIN_ID]);
  });

  /** A stored network whose url the policy would now refuse can never be reached. */
  it("marks a network the rpc policy refuses", async () => {
    const insecure = {
      chainId: "0x1a4",
      name: "Insecure",
      rpcUrl: "http://rpc.example.com",
      symbol: "ETH",
      explorerUrl: null,
      builtIn: false,
    };
    const snapshot = await snapshotWith(denying(), {
      ...LOADED_WALLET,
      "cc:networks": [insecure],
    });

    expect(snapshot.unusableChainIds).toEqual(["0x1a4"]);
  });
});

describe("WalletSnapshot.activeSite", () => {
  it("reports the connected site behind the popup", async () => {
    const { dispatch } = setup(TWO_CONNECTED, undefined, undefined, {
      activeOrigin: async () => VERCEL,
    });

    const snapshot = expectResult<WalletSnapshot>(
      await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID),
    );

    expect(snapshot.activeSite?.origin).toBe(VERCEL);
    expect(snapshot.activeSite?.accountIndex).toBe(1);
    // The wallet-wide default is a separate thing and stays put.
    expect(snapshot.defaultAccountIndex).toBe(0);
  });

  it.each([
    ["the tab is not a connected site", "https://evil.example"],
    ["there is no focused tab", null],
  ])("is null when %s", async (_label, origin) => {
    const { dispatch } = setup(TWO_CONNECTED, undefined, undefined, {
      activeOrigin: async () => origin,
    });

    const snapshot = expectResult<WalletSnapshot>(
      await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID),
    );

    expect(snapshot.activeSite).toBeNull();
  });

  /** The popup must keep working when the tab lookup fails. */
  it("degrades to null when the active tab cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { dispatch } = setup(TWO_CONNECTED, undefined, undefined, {
      activeOrigin: async () => {
        throw new Error("tabs exploded");
      },
    });

    const snapshot = expectResult<WalletSnapshot>(
      await dispatch(request("wallet_getState"), uiSender(), RUNTIME_ID),
    );

    expect(snapshot.activeSite).toBeNull();
    expect(snapshot.accounts).toHaveLength(2);
  });
});

// ============================================================================
// Phase 6 — eth_sendTransaction
// ============================================================================

const TX_HASH = "0xabc123" as const;
const SIGNATURE = "0xdeadbeef" as const;

/** A transaction sender whose behaviour the test decides. */
function fakeSender(options: { fail?: SerializedProviderError; estimate?: FeeEstimate | null } = {}) {
  const sent: SendInput[] = [];
  const estimated: unknown[] = [];
  const typedData: SignTypedDataInput[] = [];

  const sender: TransactionSender = {
    send: async (input) => {
      sent.push(input);
      if (options.fail !== undefined) throw new ProviderError(options.fail);
      return TX_HASH;
    },
    estimate: async (input) => {
      estimated.push(input);
      return options.estimate === undefined
        ? {
            txType: 2 as const,
            maxFeePerGas: "0x77359400" as const,
            maxPriorityFeePerGas: "0x3b9aca00" as const,
            gas: "0x5208" as const,
          }
        : options.estimate;
    },
    signTypedData: async (input) => {
      typedData.push(input);
      if (options.fail !== undefined) throw new ProviderError(options.fail);
      return SIGNATURE;
    },
  };

  return { sender, sent, estimated, typedData };
}

const SEND_PARAMS = [{ to: ANVIL_SECOND, value: "0xde0b6b3a7640000" }];

/** localhost connected to account 0 (ANVIL_FIRST). */
describe("eth_sendTransaction", () => {
  it("signs and returns the hash after approval", async () => {
    const { approvals } = fakeApprovals({ approve: 0 });
    const { sender, sent } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    const hash = expectResult<string>(
      await dispatch(request("eth_sendTransaction", SEND_PARAMS), pageSender(LOCAL), RUNTIME_ID),
    );

    expect(hash).toBe(TX_HASH);
    expect(sent).toHaveLength(1);
    expect(sent[0].accountIndex).toBe(0);
    expect(sent[0].transaction.to).toBe(ANVIL_SECOND);
    expect(sent[0].phrase).toBe(ANVIL_PHRASE);
  });

  /**
   * 🇪🇸 NOTA: la ventana tiene que enseñar el `from` AUTORIZADO, nunca el que la
   * página dijo. Por eso lo que se guarda en la solicitud pendiente es la
   * transacción ya parseada y no los params crudos de la dApp.
   */
  it("hands the approval window the parsed transaction, not the dApp's params", async () => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    // The dApp sent no `from` at all, and a lowercased `to`.
    await dispatch(
      request("eth_sendTransaction", [{ to: ANVIL_SECOND.toLowerCase() }]),
      pageSender(LOCAL),
      RUNTIME_ID,
    );

    expect(signed).toHaveLength(1);
    expect(signed[0].method).toBe("eth_sendTransaction");

    const shown = signed[0].params[0] as Record<string, unknown>;
    // Resolved from the permission, not from the page.
    expect(shown.from).toBe(ANVIL_FIRST);
    // And the defaults are filled in, so the window has nothing to guess.
    expect(shown.value).toBe("0x0");
    expect(shown.data).toBe("0x");
  });

  it("puts the estimate into what gets signed, so the window shows the real numbers", async () => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender, sent } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    await dispatch(request("eth_sendTransaction", SEND_PARAMS), pageSender(LOCAL), RUNTIME_ID);

    const shown = signed[0].params[0] as Record<string, unknown>;
    expect(shown.from).toBe(ANVIL_FIRST);
    expect(shown.gas).toBe("0x5208");
    expect(shown.maxFeePerGas).toBe("0x77359400");
    // And exactly that is what was signed.
    expect(sent[0].transaction.gas).toBe("0x5208");
  });

  it("still asks for approval when the estimate fails", async () => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender, sent } = fakeSender({ estimate: null });
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    const hash = expectResult<string>(
      await dispatch(request("eth_sendTransaction", SEND_PARAMS), pageSender(LOCAL), RUNTIME_ID),
    );

    expect(hash).toBe(TX_HASH);
    expect(signed).toHaveLength(1);
    expect((signed[0].params[0] as Record<string, unknown>).gas).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("passes the active chain to the approval window", async () => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender();
    const { dispatch } = setup(
      { ...CONNECTED, "cc:chainId": SEPOLIA_CHAIN_ID },
      undefined,
      undefined,
      { approvals, sender },
    );

    await dispatch(request("eth_sendTransaction", SEND_PARAMS), pageSender(LOCAL), RUNTIME_ID);

    expect(signed[0].chainId).toBe(SEPOLIA_CHAIN_ID);
  });
});

describe("eth_sendTransaction refusals that never reach the user", () => {
  /**
   * 🇪🇸 NOTA: todo lo que la wallet ya sabe que va a rechazar se rechaza SIN
   * abrir ventana. Una ventana de firma que aparece para algo condenado enseña a
   * la gente a cerrar ventanas sin leerlas — y esa costumbre es exactamente lo
   * que hace que el phishing funcione.
   */
  it("answers 4100 to an origin that never connected, without opening a window", async () => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender, sent } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    expectError(
      await dispatch(request("eth_sendTransaction", SEND_PARAMS), pageSender(VERCEL), RUNTIME_ID),
      ErrorCode.UNAUTHORIZED,
    );

    expect(signed).toEqual([]);
    expect(sent).toEqual([]);
  });

  /**
   * ------------------------------------------------------------------------
   * THE from CHECK, END TO END
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: el sitio está conectado a la cuenta 0 y pide firmar desde la 1. Si
   * esto abriera ventana, la ventana enseñaría la cuenta 1 y el usuario la
   * aprobaría porque la ventana lo dice. El permiso era para UNA cuenta.
   */
  it("answers 4100 to a from that is not this origin's account", async () => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender, sent } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    expectError(
      await dispatch(
        request("eth_sendTransaction", [{ from: ANVIL_SECOND, to: ANVIL_FIRST }]),
        pageSender(LOCAL),
        RUNTIME_ID,
      ),
      ErrorCode.UNAUTHORIZED,
    );

    expect(signed).toEqual([]);
    expect(sent).toEqual([]);
  });

  it.each([
    ["no params", [] as unknown[]],
    ["a missing to", [{ value: "0x1" }]],
    ["a malformed to", [{ to: "0xnope" }]],
    ["a non-hex value", [{ to: ANVIL_SECOND, value: "1000" }]],
    ["an unknown field", [{ to: ANVIL_SECOND, accessList: [] }]],
    ["odd-length data", [{ to: ANVIL_SECOND, data: "0xabc" }]],
  ])("answers -32602 to %s, without opening a window", async (_label, params) => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender, sent } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    expectError(
      await dispatch(request("eth_sendTransaction", params), pageSender(LOCAL), RUNTIME_ID),
      ErrorCode.INVALID_PARAMS,
    );

    expect(signed).toEqual([]);
    expect(sent).toEqual([]);
  });

  /**
   * 🇪🇸 NOTA: lo que se fija aquí es que la ventana de firma enseña la red
   * REAL contra la que se va a firmar. Con el activo colgando, la migración cae
   * a Anvil, y la solicitud tiene que llevar el chainId de Anvil — no el
   * `0xdead` que había en storage. Enseñar una red y firmar contra otra es el
   * fallo que la comprobación de deriva de chainId existe para evitar.
   */
  it("signs against Anvil when the active chain is gone, and says so", async () => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender();
    const { dispatch } = setup({ ...CONNECTED, "cc:chainId": "0xdead" }, undefined, undefined, {
      approvals,
      sender,
    });

    await dispatch(request("eth_sendTransaction", SEND_PARAMS), pageSender(LOCAL), RUNTIME_ID);

    expect(signed).toHaveLength(1);
    expect(signed[0].chainId).toBe(ANVIL_CHAIN_ID);
  });

  it("answers 4902 if the catalogue and the active chain disagree", async () => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, {
      approvals,
      sender,
      networks: brokenNetworkStore(),
    });

    expectError(
      await dispatch(request("eth_sendTransaction", SEND_PARAMS), pageSender(LOCAL), RUNTIME_ID),
      ErrorCode.UNRECOGNIZED_CHAIN,
    );
    expect(signed).toEqual([]);
  });
});

describe("eth_sendTransaction after the user has decided", () => {
  it("answers 4001 when the user rejects, and signs nothing", async () => {
    const { approvals } = fakeApprovals({
      reject: { code: ErrorCode.USER_REJECTED, message: "User rejected the request." },
    });
    const { sender, sent } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    expectError(
      await dispatch(request("eth_sendTransaction", SEND_PARAMS), pageSender(LOCAL), RUNTIME_ID),
      ErrorCode.USER_REJECTED,
    );

    expect(sent).toEqual([]);
  });

  /**
   * ------------------------------------------------------------------------
   * A FAILED SEND IS DISTINGUISHABLE FROM A REJECTION
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: el usuario aprobó y el envío falló. Si llegara como 4001, la dApp
   * enseñaría "cancelaste" a alguien que no canceló — le culpa de algo que no
   * hizo y esconde la causa real.
   */
  it("keeps a post-approval failure out of the 4001 bucket", async () => {
    const { approvals } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender({
      fail: { code: ErrorCode.INTERNAL, message: "Not enough ETH in this account." },
    });
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    const response = await dispatch(
      request("eth_sendTransaction", SEND_PARAMS),
      pageSender(LOCAL),
      RUNTIME_ID,
    );

    expectError(response, ErrorCode.INTERNAL);
    if (response.ok) throw new Error("expected a failure");
    expect(response.error.code).not.toBe(ErrorCode.USER_REJECTED);
    expect(response.error.message).toContain("Not enough ETH");
  });

  it("surfaces an unreachable node as 4901", async () => {
    const { approvals } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender({
      fail: { code: ErrorCode.CHAIN_DISCONNECTED, message: "Cannot reach the RPC endpoint." },
    });
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    expectError(
      await dispatch(request("eth_sendTransaction", SEND_PARAMS), pageSender(LOCAL), RUNTIME_ID),
      ErrorCode.CHAIN_DISCONNECTED,
    );
  });
});

describe("the signing params never reach the log", () => {
  /**
   * ------------------------------------------------------------------------
   * THE RULE FROM PHASE 3, NOW THAT THE METHOD ACTUALLY EXISTS
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: `redactParams` se escribió en la Fase 3 con un test, cuando
   * `eth_sendTransaction` todavía respondía 4200. Ése era el motivo de
   * escribirlo entonces: que cuando el método existiera de verdad, la regla ya
   * estuviera puesta y nadie tuviera que acordarse de ella mientras escribía el
   * código de firmar. Esto lo comprueba con el método implementado.
   */
  it("logs the call but redacts what was being signed", async () => {
    const { approvals } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender();
    const { area, dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    await dispatch(
      request("eth_sendTransaction", [{ to: ANVIL_SECOND, value: "0xdeadbeef" }]),
      pageSender(LOCAL),
      RUNTIME_ID,
    );

    const entries = logsIn(area);
    expect(entries[0].label).toBe("eth_sendTransaction");
    expect(entries[0].detail).toBe("[redacted]");
    expect(JSON.stringify(entries)).not.toContain("0xdeadbeef");
    expect(JSON.stringify(entries)).not.toContain(ANVIL_SECOND);
  });

  it("never writes the mnemonic, even on a failed send", async () => {
    const { approvals } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender({
      fail: { code: ErrorCode.INTERNAL, message: "boom" },
    });
    const { area, dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    await dispatch(request("eth_sendTransaction", SEND_PARAMS), pageSender(LOCAL), RUNTIME_ID);

    expect(JSON.stringify(logsIn(area))).not.toContain("junk");
  });
});

// ============================================================================
// Phase 7 — eth_signTypedData_v4
// ============================================================================

const TYPED_DATA = {
  domain: {
    name: "Ether Mail",
    version: "1",
    chainId: 31337,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  types: {
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    contents: "Hello, Bob!",
  },
};

const signParams = (payload: unknown = TYPED_DATA, address = ANVIL_FIRST) => [
  address,
  JSON.stringify(payload),
];

describe("eth_signTypedData_v4", () => {
  it("signs and returns the signature after approval", async () => {
    const { approvals } = fakeApprovals({ approve: 0 });
    const { sender, typedData } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    const signature = expectResult<string>(
      await dispatch(request("eth_signTypedData_v4", signParams()), pageSender(LOCAL), RUNTIME_ID),
    );

    expect(signature).toBe(SIGNATURE);
    expect(typedData).toHaveLength(1);
    expect(typedData[0].address).toBe(ANVIL_FIRST);
    expect(typedData[0].payload.primaryType).toBe("Mail");
  });

  /**
   * 🇪🇸 NOTA: la ventana recibe el payload PARSEADO, con el `EIP712Domain` que la
   * dApp mandó si lo mandó. Se enseña lo que llegó, no una versión recortada
   * para ethers.
   */
  it("gives the window the payload as it arrived, EIP712Domain included", async () => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    const withDomainType = {
      ...TYPED_DATA,
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        ...TYPED_DATA.types,
      },
    };

    await dispatch(
      request("eth_signTypedData_v4", signParams(withDomainType)),
      pageSender(LOCAL),
      RUNTIME_ID,
    );

    expect(signed[0].method).toBe("eth_signTypedData_v4");
    const payload = signed[0].params[1] as { types: Record<string, unknown> };
    expect(payload.types.EIP712Domain).toBeDefined();
  });

  it("answers 4001 when the user rejects, and signs nothing", async () => {
    const { approvals } = fakeApprovals({
      reject: { code: ErrorCode.USER_REJECTED, message: "User rejected the request." },
    });
    const { sender, typedData } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    expectError(
      await dispatch(request("eth_signTypedData_v4", signParams()), pageSender(LOCAL), RUNTIME_ID),
      ErrorCode.USER_REJECTED,
    );

    expect(typedData).toEqual([]);
  });
});

describe("eth_signTypedData_v4 refusals that never reach the user", () => {
  it("answers 4100 to an origin that never connected", async () => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender, typedData } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    expectError(
      await dispatch(request("eth_signTypedData_v4", signParams()), pageSender(VERCEL), RUNTIME_ID),
      ErrorCode.UNAUTHORIZED,
    );

    expect(signed).toEqual([]);
    expect(typedData).toEqual([]);
  });

  /** Same control as the `from` of a transaction, and for the same reason. */
  it("answers 4100 when asked to sign as another account", async () => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    expectError(
      await dispatch(
        request("eth_signTypedData_v4", signParams(TYPED_DATA, ANVIL_SECOND)),
        pageSender(LOCAL),
        RUNTIME_ID,
      ),
      ErrorCode.UNAUTHORIZED,
    );

    expect(signed).toEqual([]);
  });

  it.each([
    ["no params", [] as unknown[]],
    ["broken JSON", [ANVIL_FIRST, "{ not json"]],
    ["no domain", [ANVIL_FIRST, JSON.stringify({ ...TYPED_DATA, domain: undefined })]],
    ["no primaryType", [ANVIL_FIRST, JSON.stringify({ ...TYPED_DATA, primaryType: undefined })]],
    [
      "a primaryType not in types",
      [ANVIL_FIRST, JSON.stringify({ ...TYPED_DATA, primaryType: "Invoice" })],
    ],
  ])("answers -32602 to %s, without opening a window", async (_label, params) => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    expectError(
      await dispatch(request("eth_signTypedData_v4", params), pageSender(LOCAL), RUNTIME_ID),
      ErrorCode.INVALID_PARAMS,
    );

    expect(signed).toEqual([]);
  });

  /**
   * ------------------------------------------------------------------------
   * THE CASE THAT MATTERS MOST ABOUT EIP-712
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: la wallet está en Anvil, jugando con dinero de mentira, y la dApp
   * pide firmar algo cuyo dominio dice `chainId: 1`. Esa firma es válida en
   * MAINNET. Si era un `Permit`, alguien acaba de recibir permiso para mover
   * tus tokens de verdad — sin transacción, sin gas y sin nada en el explorador.
   *
   * La sensación de "estoy en una testnet, no puede pasar nada" es justo lo que
   * hace que se firme sin mirar, así que se rechaza en vez de avisar.
   */
  it("refuses a signature meant for another chain, without opening a window", async () => {
    const { approvals, signed } = fakeApprovals({ approve: 0 });
    const { sender, typedData } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    const forMainnet = { ...TYPED_DATA, domain: { ...TYPED_DATA.domain, chainId: 1 } };

    const response = await dispatch(
      request("eth_signTypedData_v4", signParams(forMainnet)),
      pageSender(LOCAL),
      RUNTIME_ID,
    );

    expectError(response, ErrorCode.INVALID_PARAMS);
    if (response.ok) throw new Error("expected a failure");
    expect(response.error.message).toContain("chain 1");
    expect(response.error.message).toContain("31337");

    expect(signed).toEqual([]);
    expect(typedData).toEqual([]);
  });

  it("accepts a chainId that matches, in either notation", async () => {
    const { approvals } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    for (const chainId of [31337, "0x7a69"]) {
      const response = await dispatch(
        request("eth_signTypedData_v4", signParams({ ...TYPED_DATA, domain: { ...TYPED_DATA.domain, chainId } })),
        pageSender(LOCAL),
        RUNTIME_ID,
      );
      expect(response.ok).toBe(true);
    }
  });

  /** A domain with no chainId is legal: a login valid on any chain. */
  it("allows a domain that names no chain at all", async () => {
    const { approvals } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender();
    const { dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    const response = await dispatch(
      request(
        "eth_signTypedData_v4",
        signParams({ ...TYPED_DATA, domain: { name: "Login", version: "1" } }),
      ),
      pageSender(LOCAL),
      RUNTIME_ID,
    );

    expect(response.ok).toBe(true);
  });
});

describe("the typed data never reaches the log", () => {
  /**
   * 🇪🇸 NOTA: la regla de `redactParams` se escribió en la Fase 3, cuando este
   * método respondía 4200. Ahora existe de verdad y la regla sigue puesta sin
   * que nadie haya tenido que acordarse de ella.
   */
  it("logs the call but redacts the payload", async () => {
    const { approvals } = fakeApprovals({ approve: 0 });
    const { sender } = fakeSender();
    const { area, dispatch } = setup(CONNECTED, undefined, undefined, { approvals, sender });

    await dispatch(
      request("eth_signTypedData_v4", signParams()),
      pageSender(LOCAL),
      RUNTIME_ID,
    );

    const entries = logsIn(area);
    expect(entries[0].label).toBe("eth_signTypedData_v4");
    expect(entries[0].detail).toBe("[redacted]");
    expect(JSON.stringify(entries)).not.toContain("Hello, Bob!");
    expect(JSON.stringify(entries)).not.toContain("Ether Mail");
  });
});
