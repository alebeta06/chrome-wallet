import { describe, expect, it } from "vitest";

import { ErrorCode, type NetworkConfig, type Origin } from "@/types/messages";
import type { EventEmitter } from "@/lib/events";
import { ProviderError } from "@/lib/errors";
import { switchChain } from "@/lib/network-rpc";
import { createNetworkStore, type NetworkStore } from "@/lib/network-store";
import {
  ANVIL_CHAIN_ID,
  DEFAULT_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
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
