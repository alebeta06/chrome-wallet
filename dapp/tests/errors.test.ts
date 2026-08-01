import { describe, expect, it } from "vitest";

import { PROVIDER_ERROR_MESSAGES, describeProviderError } from "@/lib/errors";

/** An EIP-1193 rejection as the injected provider rebuilds it. */
function providerError(code: number, message: string, data?: unknown) {
  const error = new Error(message) as Error & { code: number; data?: unknown };
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

describe("describeProviderError", () => {
  it("turns a known code into a sentence a person can read", () => {
    const described = describeProviderError(providerError(4001, "User rejected the request."));

    expect(described.code).toBe(4001);
    expect(described.title).toBe(PROVIDER_ERROR_MESSAGES[4001]);
    expect(described.detail).toBe("User rejected the request.");
  });

  it.each([4001, 4100, 4200, 4900, 4901, 4902, -32602, -32603])(
    "has a message for code %i",
    (code) => {
      const described = describeProviderError(providerError(code, "raw wallet message"));

      expect(described.title).toBe(PROVIDER_ERROR_MESSAGES[code]);
      // The mapped sentence must not just echo the raw message back.
      expect(described.title).not.toBe("raw wallet message");
    },
  );

  /**
   * 🇪🇸 NOTA: un código que no está en el mapa se muestra igual, con su número,
   * en vez de esconderse detrás de un "error desconocido". Que aparezca un
   * código nuevo es información: significa que la wallet ha crecido y a esta
   * tabla le falta una fila.
   */
  it("shows an unmapped code honestly instead of hiding it", () => {
    const described = describeProviderError(providerError(4321, "something new"));

    expect(described.code).toBe(4321);
    expect(described.title).toContain("4321");
    expect(described.detail).toBe("something new");
  });

  /**
   * 🇪🇸 NOTA: la comprobación es sobre el `code` numérico, no sobre
   * `instanceof Error`. El error cruza dos boundaries antes de llegar aquí, y
   * aunque nuestra extensión sí reconstruye un Error de verdad, una dApp no
   * puede darlo por hecho de ninguna wallet.
   */
  it("reads the code off a plain object that is not an Error", () => {
    const described = describeProviderError({ code: 4001, message: "nope" });

    expect(described.code).toBe(4001);
    expect(described.title).toBe(PROVIDER_ERROR_MESSAGES[4001]);
  });

  it("survives an Error with no code at all", () => {
    const described = describeProviderError(new Error("the network blew up"));

    expect(described.code).toBeNull();
    expect(described.title).toContain("Something went wrong");
    expect(described.detail).toBe("the network blew up");
  });

  it.each([
    ["a thrown string", "just a string"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an empty object", {}],
  ])("never throws on %s", (_label, cause) => {
    const described = describeProviderError(cause);

    expect(described.code).toBeNull();
    expect(described.title.length).toBeGreaterThan(0);
    expect(described.detail.length).toBeGreaterThan(0);
  });

  it("ignores a non-numeric code", () => {
    expect(describeProviderError({ code: "4001", message: "nope" }).code).toBeNull();
  });

  it("keeps a message that would otherwise be empty", () => {
    expect(describeProviderError(new Error("")).detail.length).toBeGreaterThan(0);
  });
});
