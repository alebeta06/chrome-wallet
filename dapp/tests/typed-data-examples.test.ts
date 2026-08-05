import { describe, expect, it } from "vitest";
import { verifyTypedData, Wallet } from "ethers";

import { DEFAULT_EXAMPLE, TYPED_DATA_EXAMPLES } from "@/lib/typed-data-examples";

/**
 * 🇪🇸 NOTA: los ejemplos son fixtures escritos a mano, y un fixture roto solo se
 * descubre al pulsar el botón. Estos tests son baratos y convierten "el ejemplo
 * de arrays no firma" en un fallo de CI en vez de en una comprobación manual que
 * falla delante del tribunal.
 */
describe("the EIP-712 examples", () => {
  it("all parse as JSON", () => {
    for (const example of TYPED_DATA_EXAMPLES) {
      expect(() => JSON.parse(example.json)).not.toThrow();
    }
  });

  it("all have the four required members", () => {
    for (const example of TYPED_DATA_EXAMPLES) {
      const payload = JSON.parse(example.json);

      expect(payload.domain, example.id).toBeDefined();
      expect(payload.types, example.id).toBeDefined();
      expect(payload.message, example.id).toBeDefined();
      expect(typeof payload.primaryType, example.id).toBe("string");
    }
  });

  it("declare their own primaryType", () => {
    for (const example of TYPED_DATA_EXAMPLES) {
      const payload = JSON.parse(example.json);

      expect(Array.isArray(payload.types[payload.primaryType]), example.id).toBe(true);
    }
  });

  /**
   * 🇪🇸 NOTA: los que deben firmar, firman. El de `wrong-chain` se excluye porque
   * su gracia es que la wallet lo RECHACE — pero su payload tiene que ser válido
   * igualmente, o estaría fallando por el motivo equivocado.
   */
  it("are all signable, including the one the wallet must refuse", async () => {
    const wallet = Wallet.createRandom();

    for (const example of TYPED_DATA_EXAMPLES) {
      const payload = JSON.parse(example.json);
      const { EIP712Domain: _unused, ...types } = payload.types;

      const signature = await wallet.signTypedData(payload.domain, types, payload.message);

      expect(verifyTypedData(payload.domain, types, payload.message, signature), example.id).toBe(
        wallet.address,
      );
    }
  });

  it("has a wrong-chain example that really names another chain", () => {
    const wrong = TYPED_DATA_EXAMPLES.find((example) => example.id === "wrong-chain");

    expect(JSON.parse(wrong!.json).domain.chainId).not.toBe(31337);
  });

  it("defaults to the canonical spec example", () => {
    expect(DEFAULT_EXAMPLE.id).toBe("mail");
    expect(JSON.parse(DEFAULT_EXAMPLE.json).primaryType).toBe("Mail");
  });
});
