import { describe, expect, it } from "vitest";

import type { NetworkConfig } from "@/types/messages";
import {
  ANVIL_CHAIN_ID,
  DEFAULT_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
  canonicalChainId,
  draftFromParameter,
  findNetwork,
  migrateCatalogue,
  normalizeExplorerUrl,
  removeNetwork,
  toNetworkConfig,
  upsertNetwork,
} from "@/lib/networks";

const POLYGON = "0x89";

function custom(chainId = POLYGON, rpcUrl = "https://polygon-rpc.com"): NetworkConfig {
  return toNetworkConfig(
    {
      chainId: chainId as NetworkConfig["chainId"],
      name: "Polygon",
      rpcUrl,
      nativeCurrency: { name: "Polygon Ecosystem Token", symbol: "POL", decimals: 18 },
      explorerUrl: "https://polygonscan.com",
    },
    1_000,
  );
}

describe("canonicalChainId", () => {
  /**
   * 🇪🇸 NOTA: las tres formas son la MISMA red. Sin canonicalizar, un usuario que
   * escribe `0x01` da de alta una segunda entrada para la cadena que ya tenía, y
   * la búsqueda por id falla para una red que está delante.
   */
  it.each(["0x1", "0x01", "0X1", "0x0001"])("reads %s as 0x1", (value) => {
    expect(canonicalChainId(value)).toBe("0x1");
  });

  it("lowercases the digits", () => {
    expect(canonicalChainId("0xAA36A7")).toBe(SEPOLIA_CHAIN_ID);
  });

  it("leaves an already canonical id alone", () => {
    expect(canonicalChainId(ANVIL_CHAIN_ID)).toBe(ANVIL_CHAIN_ID);
  });

  it.each([
    ["zero", "0x0"],
    ["decimal", "31337"],
    ["no digits", "0x"],
    ["not hex", "0xzz"],
    ["a number", 31337],
    ["null", null],
    ["undefined", undefined],
  ])("refuses %s", (_label, value) => {
    expect(canonicalChainId(value)).toBeNull();
  });

  /** Above MAX_SAFE_INTEGER the id stops surviving the Number() round trip. */
  it("refuses an id too large to be a chain id", () => {
    expect(canonicalChainId("0xffffffffffffffff")).toBeNull();
  });
});

describe("normalizeExplorerUrl", () => {
  it.each([
    ["https://polygonscan.com/", "https://polygonscan.com"],
    ["https://polygonscan.com///", "https://polygonscan.com"],
    ["  https://polygonscan.com/  ", "https://polygonscan.com"],
    ["https://polygonscan.com", "https://polygonscan.com"],
  ])("normalises %s", (input, expected) => {
    expect(normalizeExplorerUrl(input)).toBe(expected);
  });

  it.each(["", "   ", "not a url", null, 42])("gives null for %s", (input) => {
    expect(normalizeExplorerUrl(input)).toBeNull();
  });
});

describe("toNetworkConfig", () => {
  /**
   * ------------------------------------------------------------------------
   * THE INVARIANT: symbol IS nativeCurrency.symbol
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: el mismo dato guardado dos veces acaba discrepando en cuanto
   * alguien actualiza uno de los dos. Aquí se fija que no hay forma de que eso
   * pase: `symbol` no se pasa, se deriva.
   */
  it("derives symbol from nativeCurrency", () => {
    expect(custom().symbol).toBe("POL");
    expect(custom().nativeCurrency?.symbol).toBe("POL");
  });

  it("normalises the explorer url on write", () => {
    const entry = toNetworkConfig(
      {
        chainId: POLYGON as NetworkConfig["chainId"],
        name: "  Polygon  ",
        rpcUrl: "https://polygon-rpc.com",
        nativeCurrency: { name: "Pol", symbol: "POL", decimals: 18 },
        explorerUrl: "https://polygonscan.com/",
      },
      1_000,
    );

    expect(entry.explorerUrl).toBe("https://polygonscan.com");
    expect(entry.name).toBe("Polygon");
  });
});

describe("draftFromParameter", () => {
  it("takes the first rpc url and the first explorer", () => {
    const draft = draftFromParameter({
      chainId: "0X89" as `0x${string}`,
      chainName: "Polygon",
      rpcUrls: ["https://polygon-rpc.com", "https://backup.example"],
      nativeCurrency: { name: "Pol", symbol: "POL", decimals: 18 },
      blockExplorerUrls: ["https://polygonscan.com", "https://other.example"],
    });

    expect(draft).toEqual({
      chainId: "0x89",
      name: "Polygon",
      rpcUrl: "https://polygon-rpc.com",
      nativeCurrency: { name: "Pol", symbol: "POL", decimals: 18 },
      explorerUrl: "https://polygonscan.com",
    });
  });

  it.each([
    ["a bad chain id", { chainId: "nope" }],
    ["no rpc urls", { rpcUrls: [] }],
    ["a blank name", { chainName: "   " }],
    ["no symbol", { nativeCurrency: { name: "x", symbol: "", decimals: 18 } }],
    ["fractional decimals", { nativeCurrency: { name: "x", symbol: "X", decimals: 1.5 } }],
  ])("refuses %s", (_label, override) => {
    const draft = draftFromParameter({
      chainId: "0x89",
      chainName: "Polygon",
      rpcUrls: ["https://polygon-rpc.com"],
      nativeCurrency: { name: "Pol", symbol: "POL", decimals: 18 },
      ...override,
    } as Parameters<typeof draftFromParameter>[0]);

    expect(draft).toBeNull();
  });
});

describe("upsertNetwork", () => {
  it("appends a network that was not there", () => {
    const next = upsertNetwork([], custom());
    expect(next).toHaveLength(1);
  });

  /**
   * 🇪🇸 NOTA: en su sitio, no al final. Una lista que se reordena sola cada vez
   * que alguien cambia un RPC es una lista en la que se pulsa la entrada
   * equivocada.
   */
  it("overwrites in place, keeping the order", () => {
    const catalogue = [custom("0x1", "https://one.example"), custom(POLYGON), custom("0x2")];
    const next = upsertNetwork(catalogue, custom("0x1", "https://changed.example"));

    expect(next.map((entry) => entry.chainId)).toEqual(["0x1", POLYGON, "0x2"]);
    expect(next[0].rpcUrl).toBe("https://changed.example");
  });

  /** A dApp must not be able to repoint "Sepolia" at its own node. */
  it("refuses to touch a built-in", () => {
    const catalogue = [...migrateCatalogue(undefined, undefined).networks];
    const next = upsertNetwork(catalogue, custom(SEPOLIA_CHAIN_ID, "https://evil.example"));

    expect(findNetwork(next, SEPOLIA_CHAIN_ID)?.rpcUrl).toBe(
      "https://ethereum-sepolia-rpc.publicnode.com",
    );
  });
});

describe("removeNetwork", () => {
  const catalogue = [...migrateCatalogue(undefined, undefined).networks, custom()];

  it("removes a user network", () => {
    const result = removeNetwork(catalogue, POLYGON, ANVIL_CHAIN_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(findNetwork(result.networks, POLYGON)).toBeUndefined();
  });

  it.each([
    ["a built-in", SEPOLIA_CHAIN_ID, ANVIL_CHAIN_ID, "built-in"],
    ["the active network", POLYGON, POLYGON, "active"],
    ["one that is not there", "0xdead", ANVIL_CHAIN_ID, "not-found"],
  ])("refuses %s", (_label, chainId, active, reason) => {
    const result = removeNetwork(
      catalogue,
      chainId as NetworkConfig["chainId"],
      active as NetworkConfig["chainId"],
    );

    expect(result).toEqual({ ok: false, reason });
  });
});

describe("migrateCatalogue", () => {
  it("seeds both built-ins when nothing is stored", () => {
    const { networks, chainId } = migrateCatalogue(undefined, undefined);

    expect(networks.map((entry) => entry.chainId)).toEqual([ANVIL_CHAIN_ID, SEPOLIA_CHAIN_ID]);
    expect(networks.every((entry) => entry.builtIn)).toBe(true);
    expect(chainId).toBe(DEFAULT_CHAIN_ID);
  });

  /**
   * ------------------------------------------------------------------------
   * A CUSTOM ENTRY CAN NEVER SHADOW A BUILT-IN, WHATEVER THE ORDER
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: la custom va PRIMERA en el array a propósito. Con un dedupe de
   * "gana la primera" sobre la lista mezclada, este test pasaría a rojo — y ese
   * es justo el bug: una red del usuario apuntando "Sepolia" a su propio RPC,
   * con el nombre de Sepolia en la ventana de firma.
   */
  it("keeps the built-in even when a custom entry claims its id first", () => {
    const impostor = {
      chainId: SEPOLIA_CHAIN_ID,
      name: "Sepolia",
      rpcUrl: "https://evil.example",
      symbol: "ETH",
      explorerUrl: null,
      builtIn: false,
    };

    const { networks } = migrateCatalogue([impostor, custom()], undefined);
    const sepolia = findNetwork(networks, SEPOLIA_CHAIN_ID);

    expect(sepolia?.rpcUrl).toBe("https://ethereum-sepolia-rpc.publicnode.com");
    expect(sepolia?.builtIn).toBe(true);
    expect(findNetwork(networks, POLYGON)).toBeDefined();
  });

  /** Same, spelled the other way: a built-in id in non-canonical form. */
  it("catches an impostor that spells the id differently", () => {
    const { networks } = migrateCatalogue(
      [{ ...custom(), chainId: "0xAA36A7", name: "Not Sepolia" }],
      undefined,
    );

    expect(findNetwork(networks, SEPOLIA_CHAIN_ID)?.name).toBe("Sepolia");
    expect(networks).toHaveLength(2);
  });

  /**
   * 🇪🇸 NOTA: éste es el caso real de la migración. `cc:networks` nunca se
   * escribió antes de la Fase 8, pero una entrada de un build intermedio no
   * tendría `nativeCurrency` — solo `symbol`. Se sintetiza en vez de descartarla,
   * y así el invariante se cumple también para lo migrado.
   */
  it("synthesises nativeCurrency from an old entry that only had symbol", () => {
    const old = {
      chainId: POLYGON,
      name: "Polygon",
      rpcUrl: "https://polygon-rpc.com",
      symbol: "POL",
      explorerUrl: "https://polygonscan.com/",
      builtIn: false,
    };

    const entry = findNetwork(migrateCatalogue([old], undefined).networks, POLYGON);

    expect(entry?.nativeCurrency).toEqual({ name: "POL", symbol: "POL", decimals: 18 });
    expect(entry?.symbol).toBe("POL");
    expect(entry?.explorerUrl).toBe("https://polygonscan.com");
  });

  it("drops entries that are not networks at all", () => {
    const { networks } = migrateCatalogue([null, 42, {}, { chainId: "0x1" }, custom()], undefined);

    expect(networks).toHaveLength(3);
  });

  it("keeps only the first of two custom entries for the same chain", () => {
    const { networks } = migrateCatalogue(
      [custom(POLYGON, "https://first.example"), custom(POLYGON, "https://second.example")],
      undefined,
    );

    expect(findNetwork(networks, POLYGON)?.rpcUrl).toBe("https://first.example");
  });

  /** 🇪🇸 NOTA: esto es "sin perder la red activa" del enunciado de la fase. */
  it("keeps the active network across a restart", () => {
    expect(migrateCatalogue(undefined, SEPOLIA_CHAIN_ID).chainId).toBe(SEPOLIA_CHAIN_ID);
    expect(migrateCatalogue([custom()], POLYGON).chainId).toBe(POLYGON);
  });

  it("canonicalises the stored active id", () => {
    expect(migrateCatalogue(undefined, "0xAA36A7").chainId).toBe(SEPOLIA_CHAIN_ID);
  });

  it("falls back to Anvil when the active network is gone", () => {
    expect(migrateCatalogue(undefined, POLYGON).chainId).toBe(DEFAULT_CHAIN_ID);
    expect(migrateCatalogue(undefined, "garbage").chainId).toBe(DEFAULT_CHAIN_ID);
  });

  /**
   * ------------------------------------------------------------------------
   * IDEMPOTENT, AND IT HAS TO BE
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: esto corre en CADA arranque del service worker. Si la segunda
   * pasada produjera algo distinto de la primera, el store escribiría en cada
   * arranque, cada escritura dispararía `chrome.storage.onChanged` y la UI
   * abierta se refrescaría sin que nada hubiera cambiado.
   */
  it.each([
    ["a fresh install", undefined, undefined],
    ["a stored catalogue", [custom()], POLYGON],
    ["an old entry", [{ chainId: POLYGON, name: "P", rpcUrl: "https://p.example", symbol: "POL", explorerUrl: null, builtIn: false }], undefined],
  ])("is idempotent for %s", (_label, stored, active) => {
    const once = migrateCatalogue(stored, active);
    const twice = migrateCatalogue(once.networks, once.chainId);

    expect(twice).toEqual(once);
  });
});
