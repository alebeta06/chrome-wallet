import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type RpcRequestMessage, type RpcResponseMessage, type WalletSnapshot } from "@/types/messages";
import { createDispatcher } from "@/lib/dispatch";
import { createWalletStorage } from "@/lib/storage";
import { ANVIL_CHAIN_ID, SEPOLIA_CHAIN_ID } from "@/lib/networks";
import { createMemoryStorageArea } from "./helpers/memory-storage-area";

const RUNTIME_ID = "codecryptowalletextensionidaaaa";
const ANVIL_PHRASE = "test test test test test test test test test test test junk";
const ANVIL_FIRST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** The extension's own UI: no tab, so classifySender reports fromPage: false. */
function uiSender(): chrome.runtime.MessageSender {
  return {
    id: RUNTIME_ID,
    origin: `chrome-extension://${RUNTIME_ID}`,
    url: `chrome-extension://${RUNTIME_ID}/connect.html`,
  };
}

/**
 * A web page. The only thing that makes it one, as far as the contract is
 * concerned, is `tab` being defined — which a page cannot fake, because Chrome
 * fills it in.
 */
function pageSender(origin = "https://dapp.example"): chrome.runtime.MessageSender {
  return { id: RUNTIME_ID, origin, url: `${origin}/`, tab: { id: 42 } as chrome.tabs.Tab };
}

function request(method: string, params: unknown[] = []): RpcRequestMessage {
  return { type: "CODECRYPTO_RPC", id: "req-1", method, params };
}

function setup(seed: Record<string, unknown> = {}) {
  const area = createMemoryStorageArea(seed);
  return { area, dispatch: createDispatcher({ storage: createWalletStorage(area) }) };
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
    expect(area.keys()).toEqual([]);
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
    const foreign: chrome.runtime.MessageSender = { id: "some-other-extension-id" };

    expectError(await dispatch(request("wallet_getState"), foreign, RUNTIME_ID), ErrorCode.UNAUTHORIZED);
  });

  it("lets a public method through the gate (it just is not implemented yet)", async () => {
    const { dispatch } = setup();

    // 4200, not 4100: the sender check passed and the switch fell through.
    expectError(await dispatch(request("eth_accounts"), pageSender(), RUNTIME_ID), ErrorCode.UNSUPPORTED_METHOD);
  });

  it("answers an unknown method with 4200", async () => {
    const { dispatch } = setup();
    expectError(await dispatch(request("wallet_doesNotExist"), uiSender(), RUNTIME_ID), ErrorCode.UNSUPPORTED_METHOD);
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
