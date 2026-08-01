import { describe, expect, it } from "vitest";

import { describeChain } from "@/lib/networks";

describe("describeChain", () => {
  it.each([
    ["0x7a69", "Anvil Local", 31337],
    ["0xaa36a7", "Sepolia", 11155111],
    ["0x1", "Ethereum Mainnet", 1],
  ])("names %s", (chainId, name, decimal) => {
    const chain = describeChain(chainId);

    expect(chain.name).toBe(name);
    expect(chain.decimal).toBe(decimal);
    expect(chain.known).toBe(true);
  });

  it("normalises uppercase hex", () => {
    expect(describeChain("0xAA36A7").name).toBe("Sepolia");
  });

  /**
   * 🇪🇸 NOTA: una red desconocida se muestra con su número, no como "unknown".
   * Alguien mirando la página tiene que poder decir "esto es 137, estoy en
   * Polygon" aunque la tabla no la conozca. Esconderlo detrás de una etiqueta
   * genérica es justo lo que hace que la gente firme en la red equivocada.
   */
  it("still gives a useful name to a chain it does not know", () => {
    const chain = describeChain("0x89");

    expect(chain.decimal).toBe(137);
    expect(chain.name).toBe("Chain 137");
    expect(chain.known).toBe(false);
  });

  it.each([
    ["a decimal string", "31337"],
    ["0x alone", "0x"],
    ["a number", 31337],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
  ])("survives %s without throwing", (_label, value) => {
    const chain = describeChain(value);

    expect(chain.decimal).toBeNull();
    expect(chain.known).toBe(false);
    expect(chain.name.length).toBeGreaterThan(0);
  });
});
