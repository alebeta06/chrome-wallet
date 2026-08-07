import { describe, expect, it } from "vitest";

import { ErrorCode, type NetworkConfig, type Origin } from "@/types/messages";
import type { EventEmitter } from "@/lib/events";
import { ProviderError } from "@/lib/errors";
import { addChain, switchChain } from "@/lib/network-rpc";
import type { AddChainRequestInput, ApprovalCoordinator } from "@/lib/approvals";
import type { ChainIdReader } from "@/lib/chain";
import { createNetworkStore, type NetworkStore } from "@/lib/network-store";
import {
  ANVIL_CHAIN_ID,
  DEFAULT_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
  findNetwork,
  toNetworkConfig,
} from "@/lib/networks";
import type { PermissionsPort } from "@/lib/permissions";
import { createWalletStorage } from "@/lib/storage";
import { createMemoryStorageArea } from "./helpers/memory-storage-area";

const METHOD = "wallet_switchEthereumChain";

const POLYGON = toNetworkConfig(
  {
    chainId: "0x89",
    name: "Polygon",
    rpcUrl: "https://polygon-rpc.com",
    nativeCurrency: { name: "Polygon Ecosystem Token", symbol: "POL", decimals: 18 },
    explorerUrl: null,
  },
  1_000,
);

function denying(...denied: string[]): PermissionsPort {
  const blocked = new Set(denied);
  return {
    contains: (pattern) => Promise.resolve(!blocked.has(pattern)),
    remove: () => Promise.resolve(true),
  };
}

async function setup(options: { permissions?: PermissionsPort; extra?: NetworkConfig[] } = {}) {
  const emitted: { name: string; data: unknown; changedOrigin: Origin | null }[] = [];
  const emit: EventEmitter = async (name, data, opts) => {
    emitted.push({ name, data, changedOrigin: opts.changedOrigin });
  };

  const storage = createWalletStorage(createMemoryStorageArea());
  const networks: NetworkStore = createNetworkStore(storage, emit);
  await networks.migrate();

  for (const entry of options.extra ?? []) await networks.upsert(entry);
  emitted.length = 0;

  return {
    networks,
    emitted,
    deps: { networks, permissions: options.permissions ?? denying() },
  };
}

/** Asserts the call failed with this code, and hands the error back. */
async function expectRejection(promise: Promise<unknown>, code: number): Promise<ProviderError> {
  const cause = await promise.then(
    () => null,
    (error: unknown) => error,
  );

  expect(cause).toBeInstanceOf(ProviderError);
  const error = cause as ProviderError;
  expect(error.serialized.code).toBe(code);
  return error;
}

describe("switchChain", () => {
  it("switches to a known, permitted network and announces it", async () => {
    const { deps, networks, emitted } = await setup();

    await expect(switchChain(deps, [{ chainId: SEPOLIA_CHAIN_ID }], METHOD)).resolves.toBeNull();

    expect((await networks.read()).chainId).toBe(SEPOLIA_CHAIN_ID);
    expect(emitted).toEqual([
      { name: "chainChanged", data: SEPOLIA_CHAIN_ID, changedOrigin: null },
    ]);
  });

  /**
   * ------------------------------------------------------------------------
   * chainChanged IS GLOBAL. accountsChanged IS NOT EMITTED AT ALL
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: éste es el test de contraste que fija el modelo por origen desde el
   * lado de la red. Cambiar de red NO toca ni las cuentas ni los permisos por
   * origen: son ejes independientes. Si alguien añadiera `accountsChanged` aquí,
   * cada cambio de red parecería un cambio de sesión y las dApps repintarían
   * entera la suya sin motivo.
   *
   * Y `changedOrigin` es null porque `chainChanged` es de alcance global — la
   * red es una propiedad de la wallet, no de la relación con un sitio.
   */
  it("emits chainChanged to everyone and accountsChanged to nobody", async () => {
    const { deps, emitted } = await setup();

    await switchChain(deps, [{ chainId: SEPOLIA_CHAIN_ID }], METHOD);

    expect(emitted.map((entry) => entry.name)).toEqual(["chainChanged"]);
    expect(emitted[0].changedOrigin).toBeNull();
  });

  /** 🇪🇸 NOTA: la misma cadena escrita de otra forma no es una cadena distinta. */
  it.each(["0x0aa36a7", "0xAA36A7", "0Xaa36a7"])("accepts %s as Sepolia", async (spelling) => {
    const { deps, networks } = await setup();

    await expect(switchChain(deps, [{ chainId: spelling }], METHOD)).resolves.toBeNull();
    expect((await networks.read()).chainId).toBe(SEPOLIA_CHAIN_ID);
  });

  it("succeeds without emitting when already on that network", async () => {
    const { deps, emitted } = await setup();

    await expect(switchChain(deps, [{ chainId: ANVIL_CHAIN_ID }], METHOD)).resolves.toBeNull();
    expect(emitted).toEqual([]);
  });

  describe("refusals", () => {
    it.each([
      ["no params", [] as unknown[]],
      ["an array instead of an object", [["0x1"]]],
      ["no chainId", [{}]],
      ["a decimal chain id", [{ chainId: "11155111" }]],
      ["a non-hex chain id", [{ chainId: "0xzz" }]],
      ["a numeric chain id", [{ chainId: 11155111 }]],
      ["chain id zero", [{ chainId: "0x0" }]],
    ])("answers -32602 to %s", async (_label, params) => {
      const { deps, emitted } = await setup();

      await expectRejection(switchChain(deps, params, METHOD), ErrorCode.INVALID_PARAMS);
      expect(emitted).toEqual([]);
    });

    it("answers 4902 for a chain that is not in the catalogue", async () => {
      const { deps } = await setup();

      const error = await expectRejection(
        switchChain(deps, [{ chainId: "0x1" }], METHOD),
        ErrorCode.UNRECOGNIZED_CHAIN,
      );

      expect(error.serialized.message).toContain("wallet_addEthereumChain");
    });

    /**
     * ------------------------------------------------------------------------
     * SAME CODE, DIFFERENT MESSAGE
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: 4902 en los dos casos porque para la dApp la reacción correcta es
     * la misma. Lo que cambia es la causa que el usuario tiene que entender:
     * "no tengo esa red" no se arregla igual que "la tengo, pero me quitaste el
     * permiso para hablar con su nodo".
     */
    it("answers 4902 with a different message for a revoked host", async () => {
      const { deps } = await setup({ permissions: denying("https://sepolia.drpc.org/*") });

      const error = await expectRejection(
        switchChain(deps, [{ chainId: SEPOLIA_CHAIN_ID }], METHOD),
        ErrorCode.UNRECOGNIZED_CHAIN,
      );

      expect(error.serialized.message).toContain("Sepolia");
      expect(error.serialized.message).toContain("revoked");
    });

    /** 🇪🇸 NOTA: una rpcUrl puede llevar una API key dentro. Nunca en un error. */
    it("never puts the rpc url in the error", async () => {
      const secret = toNetworkConfig(
        {
          chainId: "0x1",
          name: "Mainnet",
          rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/SUPERSECRET",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          explorerUrl: null,
        },
        1_000,
      );
      const { deps } = await setup({
        extra: [secret],
        permissions: denying("https://eth-mainnet.g.alchemy.com/*"),
      });

      const error = await expectRejection(
        switchChain(deps, [{ chainId: "0x1" }], METHOD),
        ErrorCode.UNRECOGNIZED_CHAIN,
      );

      expect(JSON.stringify(error.serialized)).not.toContain("SUPERSECRET");
      expect(JSON.stringify(error.serialized)).not.toContain("alchemy");
    });

    /**
     * ------------------------------------------------------------------------
     * A FAILED SWITCH EMITS NOTHING, AND MOVES NOTHING
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: el permiso se comprueba ANTES de escribir. Al revés, el usuario
     * acabaría en una red con la que no se puede hablar por culpa de una llamada
     * que además falló — y con el `chainChanged` ya repartido a todas las dApps,
     * que se lo creerían.
     */
    it("leaves the active network alone when it refuses", async () => {
      const { deps, networks, emitted } = await setup({
        extra: [POLYGON],
        permissions: denying("https://polygon-rpc.com/*"),
      });

      await expectRejection(
        switchChain(deps, [{ chainId: POLYGON.chainId }], METHOD),
        ErrorCode.UNRECOGNIZED_CHAIN,
      );

      expect((await networks.read()).chainId).toBe(DEFAULT_CHAIN_ID);
      expect(emitted).toEqual([]);
    });
  });
});

// ============================================================================
// addChain
// ============================================================================

const POLYGON_PARAM = {
  chainId: "0x89" as const,
  chainName: "Polygon",
  rpcUrls: ["https://polygon-rpc.com"],
  nativeCurrency: { name: "Polygon Ecosystem Token", symbol: "POL", decimals: 18 },
  blockExplorerUrls: ["https://polygonscan.com/"],
};

const FROM = { origin: "https://dapp.example" };

/** A coordinator that answers without a browser. */
function approver(outcome: "approve" | "reject") {
  const asked: AddChainRequestInput[] = [];

  const approvals: ApprovalCoordinator = {
    requestConnect: () => Promise.reject(new Error("not used")),
    requestSignature: () => Promise.reject(new Error("not used")),
    requestAddChain: async (input) => {
      asked.push(input);
      if (outcome === "reject") {
        throw new ProviderError({ code: ErrorCode.USER_REJECTED, message: "no" });
      }
    },
    settle: async () => {},
    reject: async () => {},
    read: async () => null,
  };

  return { approvals, asked };
}

/** A permissions port whose grants a test can flip mid-flight. */
function grantable(...initial: string[]) {
  const held = new Set(initial);
  let removeWorks = true;

  return {
    port: {
      contains: (pattern: string) => Promise.resolve(held.has(pattern)),
      remove: (pattern: string) => {
        if (removeWorks) held.delete(pattern);
        return Promise.resolve(true);
      },
    } satisfies PermissionsPort,
    grant: (pattern: string) => held.add(pattern),
    holds: (pattern: string) => held.has(pattern),
    breakRemove: () => {
      removeWorks = false;
    },
  };
}

async function addSetup(
  options: {
    permissions?: PermissionsPort;
    approvals?: ApprovalCoordinator;
    reports?: string | (() => Promise<never>);
    extra?: NetworkConfig[];
  } = {},
) {
  const base = await setup({ permissions: options.permissions ?? denying(), extra: options.extra });
  const readChainId: ChainIdReader = async () => {
    if (typeof options.reports === "function") return options.reports();
    return options.reports ?? "0x89";
  };

  return {
    ...base,
    deps: {
      ...base.deps,
      approvals: options.approvals ?? approver("approve").approvals,
      readChainId,
    },
  };
}

describe("addChain", () => {
  describe("validation, before any window", () => {
    it.each([
      ["no params", [] as unknown[]],
      ["a bad chain id", [{ ...POLYGON_PARAM, chainId: "nope" }]],
      ["no rpc urls", [{ ...POLYGON_PARAM, rpcUrls: [] }]],
      ["a blank name", [{ ...POLYGON_PARAM, chainName: "  " }]],
      ["no symbol", [{ ...POLYGON_PARAM, nativeCurrency: { name: "x", symbol: "", decimals: 18 } }]],
      [
        "fractional decimals",
        [{ ...POLYGON_PARAM, nativeCurrency: { name: "x", symbol: "X", decimals: 1.5 } }],
      ],
    ])("answers -32602 to %s without opening a window", async (_label, params) => {
      const { approvals, asked } = approver("approve");
      const { deps, networks } = await addSetup({ approvals });

      await expectRejection(addChain(deps, params, FROM), ErrorCode.INVALID_PARAMS);

      expect(asked).toEqual([]);
      expect((await networks.read()).networks).toHaveLength(2);
    });

    /** 🇪🇸 NOTA: la política del RPC tiene su propio mensaje, no un -32602 mudo. */
    it("answers -32602 for plain http on a public host, and says why", async () => {
      const { deps } = await addSetup();

      const error = await expectRejection(
        addChain(deps, [{ ...POLYGON_PARAM, rpcUrls: ["http://polygon-rpc.com"] }], FROM),
        ErrorCode.INVALID_PARAMS,
      );

      expect(error.serialized.message).toContain("https");
      expect(error.serialized.message).toContain("localhost");
    });
  });

  describe("built-ins", () => {
    it("refuses to repoint a built-in, with no window and no permission asked", async () => {
      const { approvals, asked } = approver("approve");
      const { deps, networks } = await addSetup({ approvals });

      const error = await expectRejection(
        addChain(
          deps,
          [{ ...POLYGON_PARAM, chainId: SEPOLIA_CHAIN_ID, rpcUrls: ["https://evil.example"] }],
          FROM,
        ),
        ErrorCode.INVALID_PARAMS,
      );

      expect(error.serialized.message).toContain("Sepolia");
      expect(asked).toEqual([]);

      const sepolia = findNetwork((await networks.read()).networks, SEPOLIA_CHAIN_ID);
      expect(sepolia?.rpcUrl).toBe("https://sepolia.drpc.org");
    });

    /** A dApp making sure the network is there before operating. Nothing to decide. */
    it("is idempotent for a built-in offered its own endpoint", async () => {
      const { approvals, asked } = approver("approve");
      const { deps, networks } = await addSetup({ approvals });

      await expect(
        addChain(
          deps,
          [
            {
              ...POLYGON_PARAM,
              chainId: SEPOLIA_CHAIN_ID,
              chainName: "Sepolia",
              rpcUrls: ["https://sepolia.drpc.org"],
            },
          ],
          FROM,
        ),
      ).resolves.toBeNull();

      expect(asked).toEqual([]);
      expect((await networks.read()).networks).toHaveLength(2);
    });
  });

  describe("the happy path", () => {
    it("adds the network after approval and verification", async () => {
      const permissions = grantable();
      const { approvals, asked } = approver("approve");
      const { deps, networks } = await addSetup({ permissions: permissions.port, approvals });

      // The window is what grants it, so the fake grants it when asked.
      approvals.requestAddChain = async (input) => {
        asked.push(input);
        permissions.grant("https://polygon-rpc.com/*");
      };

      await expect(addChain(deps, [POLYGON_PARAM], FROM)).resolves.toBeNull();

      const added = findNetwork((await networks.read()).networks, "0x89");
      expect(added?.rpcUrl).toBe("https://polygon-rpc.com");
      expect(added?.symbol).toBe("POL");
      // The trailing slash is normalised on write.
      expect(added?.explorerUrl).toBe("https://polygonscan.com");
    });

    /**
     * 🇪🇸 NOTA: añadir una red NO cambia de red. MetaMask lo pregunta aparte, y
     * mover al usuario a una cadena recién aprobada sin que lo pida es
     * exactamente lo que no debe hacer una wallet.
     */
    it("does not switch to the network it just added", async () => {
      const permissions = grantable("https://polygon-rpc.com/*");
      const { deps, networks, emitted } = await addSetup({ permissions: permissions.port });

      await addChain(deps, [POLYGON_PARAM], FROM);

      expect((await networks.read()).chainId).toBe(DEFAULT_CHAIN_ID);
      expect(emitted).toEqual([]);
    });

    it("is idempotent when the network is already there and reachable", async () => {
      const permissions = grantable("https://polygon-rpc.com/*");
      const { approvals, asked } = approver("approve");
      const { deps } = await addSetup({ permissions: permissions.port, approvals });

      await addChain(deps, [POLYGON_PARAM], FROM);
      asked.length = 0;

      await expect(addChain(deps, [POLYGON_PARAM], FROM)).resolves.toBeNull();
      expect(asked).toEqual([]);
    });
  });

  describe("the endpoint has to prove who it is", () => {
    /**
     * ------------------------------------------------------------------------
     * A LIE IS THE ONLY THING THAT COSTS THE PERMISSION
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: el endpoint declaró 0x89 y responde otra cosa. Esto es lo único
     * que hace que un permiso concedido por el usuario se revoque, y por eso el
     * test comprueba las tres cosas a la vez: el error, que la red NO se añadió,
     * y que el permiso se fue.
     */
    it("revokes the permission and refuses when the endpoint reports another chain", async () => {
      const permissions = grantable("https://polygon-rpc.com/*");
      const { deps, networks } = await addSetup({
        permissions: permissions.port,
        reports: "0x1",
      });

      await expectRejection(addChain(deps, [POLYGON_PARAM], FROM), ErrorCode.INVALID_PARAMS);

      expect(findNetwork((await networks.read()).networks, "0x89")).toBeUndefined();
      expect(permissions.holds("https://polygon-rpc.com/*")).toBe(false);
    });

    /**
     * 🇪🇸 NOTA: la lección de Brave del GATE 2. `remove()` puede resolver `true`
     * sin revocar nada, así que el alta falla IGUAL — no se da de alta una red
     * que mintió solo porque no pudimos limpiar el permiso.
     */
    it("still refuses when the revocation does not take", async () => {
      const permissions = grantable("https://polygon-rpc.com/*");
      permissions.breakRemove();
      const { deps, networks } = await addSetup({
        permissions: permissions.port,
        reports: "0x1",
      });

      await expectRejection(addChain(deps, [POLYGON_PARAM], FROM), ErrorCode.INVALID_PARAMS);

      expect(findNetwork((await networks.read()).networks, "0x89")).toBeUndefined();
      expect(permissions.holds("https://polygon-rpc.com/*")).toBe(true);
    });

    /**
     * ------------------------------------------------------------------------
     * A NODE THAT DOES NOT ANSWER HAS NOT LIED
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: 4901 y el permiso SE CONSERVA. No sabemos nada malo del endpoint,
     * solo que ahora mismo no está; revocar por un parpadeo obligaría al usuario
     * a pasar otra vez por el diálogo nativo entero. Reintentar más tarde
     * funciona sin segundo diálogo, y eso es lo que fija la última línea.
     */
    it("keeps the permission when the node does not answer", async () => {
      const permissions = grantable("https://polygon-rpc.com/*");
      const { deps, networks } = await addSetup({
        permissions: permissions.port,
        reports: () =>
          Promise.reject(
            new ProviderError({ code: ErrorCode.CHAIN_DISCONNECTED, message: "no node" }),
          ),
      });

      await expectRejection(addChain(deps, [POLYGON_PARAM], FROM), ErrorCode.CHAIN_DISCONNECTED);

      expect(findNetwork((await networks.read()).networks, "0x89")).toBeUndefined();
      expect(permissions.holds("https://polygon-rpc.com/*")).toBe(true);
    });

    it("treats a malformed answer as a lie", async () => {
      const permissions = grantable("https://polygon-rpc.com/*");
      const { deps } = await addSetup({ permissions: permissions.port, reports: "not-hex" });

      await expectRejection(addChain(deps, [POLYGON_PARAM], FROM), ErrorCode.INVALID_PARAMS);
      expect(permissions.holds("https://polygon-rpc.com/*")).toBe(false);
    });

    /** 🇪🇸 NOTA: 0x089 y 0x89 son la misma cadena. Un nodo no miente por eso. */
    it("accepts a non-canonical answer for the same chain", async () => {
      const permissions = grantable("https://polygon-rpc.com/*");
      const { deps, networks } = await addSetup({
        permissions: permissions.port,
        reports: "0x089",
      });

      await expect(addChain(deps, [POLYGON_PARAM], FROM)).resolves.toBeNull();
      expect(findNetwork((await networks.read()).networks, "0x89")).toBeDefined();
    });
  });

  describe("the user says no", () => {
    it("answers 4001 and adds nothing", async () => {
      const { approvals } = approver("reject");
      const { deps, networks } = await addSetup({ approvals });

      await expectRejection(addChain(deps, [POLYGON_PARAM], FROM), ErrorCode.USER_REJECTED);
      expect(findNetwork((await networks.read()).networks, "0x89")).toBeUndefined();
    });

    /**
     * 🇪🇸 NOTA: la ventana solo aprueba después de conseguir el permiso, así que
     * llegar aquí sin él significa que las dos fuentes discrepan. Se responde
     * 4001 y no se llama al RPC: hacerlo devolvería un 4901 que culparía al nodo
     * de un problema nuestro.
     */
    it("answers 4001 when approval arrived without the permission", async () => {
      const { deps, networks } = await addSetup({ permissions: grantable().port });

      await expectRejection(addChain(deps, [POLYGON_PARAM], FROM), ErrorCode.USER_REJECTED);
      expect(findNetwork((await networks.read()).networks, "0x89")).toBeUndefined();
    });
  });

  /**
   * ---------------------------------------------------------------------------
   * THE CYCLE THAT THE IDEMPOTENT SHORTCUT WOULD HAVE CLOSED
   * ---------------------------------------------------------------------------
   * 🇪🇸 NOTA: éste es el test que justifica la quinta fila de la clasificación.
   * Con el atajo "mismo chainId y mismo rpcUrl → null", el 4902 mandaba a
   * re-añadir la red, el alta devolvía null sin reconceder nada, y el switch
   * volvía al mismo 4902 — para siempre. La dApp hacía exactamente lo que se le
   * pedía y no llegaba a ninguna parte.
   *
   * El ciclo entero, de una pieza: revocado → 4902 → alta con los MISMOS params
   * → aprobar → el switch funciona.
   */
  it("recovers a revoked network through addEthereumChain", async () => {
    const permissions = grantable("https://polygon-rpc.com/*");
    const { approvals, asked } = approver("approve");
    const { deps, networks } = await addSetup({ permissions: permissions.port, approvals });

    await addChain(deps, [POLYGON_PARAM], FROM);
    expect(findNetwork((await networks.read()).networks, "0x89")).toBeDefined();

    // The user revokes the host from chrome://extensions.
    await permissions.port.remove("https://polygon-rpc.com/*");

    // 1. Switching now fails with 4902, pointing at wallet_addEthereumChain.
    const refusal = await expectRejection(
      switchChain(deps, [{ chainId: "0x89" }], METHOD),
      ErrorCode.UNRECOGNIZED_CHAIN,
    );
    expect(refusal.serialized.message).toContain("wallet_addEthereumChain");

    // 2. The very same params must open a window, not short-circuit to null.
    asked.length = 0;
    approvals.requestAddChain = async (input) => {
      asked.push(input);
      permissions.grant("https://polygon-rpc.com/*");
    };

    await expect(addChain(deps, [POLYGON_PARAM], FROM)).resolves.toBeNull();
    expect(asked).toHaveLength(1);

    // 3. And now the advice the 4902 gave actually worked.
    await expect(switchChain(deps, [{ chainId: "0x89" }], METHOD)).resolves.toBeNull();
    expect((await networks.read()).chainId).toBe("0x89");
  });
});
