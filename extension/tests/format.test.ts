import { describe, expect, it } from "vitest";

import type { Address, Hex } from "@/types/messages";
import { formatEther, normalizeMnemonicInput, shortenAddress } from "@/lib/format";

/** Wei as the contract carries it: a hex string, not a number. */
const wei = (value: bigint): Hex => `0x${value.toString(16)}`;

describe("formatEther", () => {
  it("renders a whole number of ether", () => {
    expect(formatEther(wei(10n ** 18n))).toBe("1.0000");
    expect(formatEther(wei(10000n * 10n ** 18n))).toBe("10000.0000");
  });

  it("renders zero", () => {
    expect(formatEther("0x0")).toBe("0.0000");
    expect(formatEther(wei(0n))).toBe("0.0000");
  });

  /**
   * 🇪🇸 NOTA: éste es el grupo que importa, y el que no se ejercita contra Anvil.
   *
   * La parte fraccionaria es un número, así que pierde los ceros a la izquierda:
   * 10^15 wei deja un resto de 1000000000000000, que son 16 dígitos y no 18.
   * Truncar esa cadena a cuatro da "1000" -> 0.1000, cien veces el saldo real.
   * Hay que rellenar hasta 18 ANTES de cortar.
   *
   * Contra Anvil no se ve: sus 10000 ETH son exactos y el resto es 0, así que
   * los ceros a la izquierda nunca entran en juego. El fallo aparecería la
   * primera vez que alguien recibe una cantidad pequeña.
   */
  describe("fractions with leading zeros", () => {
    it("renders 10^15 wei as 0.0010, not 0.1000", () => {
      expect(formatEther(wei(10n ** 15n))).toBe("0.0010");
    });

    it("renders 10^14 wei as 0.0001", () => {
      expect(formatEther(wei(10n ** 14n))).toBe("0.0001");
    });

    it("renders 10^13 wei as 0.0000 — below the displayed precision", () => {
      expect(formatEther(wei(10n ** 13n))).toBe("0.0000");
    });

    it("renders 1 wei as 0.0000, never 0.0001", () => {
      expect(formatEther(wei(1n))).toBe("0.0000");
    });

    it("keeps the whole part when the fraction is tiny", () => {
      expect(formatEther(wei(5n * 10n ** 18n + 10n ** 15n))).toBe("5.0010");
    });

    it("truncates a long fraction rather than rounding it", () => {
      expect(formatEther(wei(1234567890123456789n))).toBe("1.2345");
      // 0.99999… must never be shown as 1.0000.
      expect(formatEther(wei(999999999999999999n))).toBe("0.9999");
    });
  });

  it("handles values far beyond Number.MAX_SAFE_INTEGER without scientific notation", () => {
    const huge = formatEther(wei(123456789012345678901234567890n));
    expect(huge).toBe("123456789012.3456");
    expect(huge).not.toContain("e");
  });
});

describe("shortenAddress", () => {
  it("keeps six leading and four trailing characters", () => {
    expect(shortenAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe("0xf39F…2266");
  });

  it("preserves checksum casing", () => {
    const shortened = shortenAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(shortened).toBe("0x7099…79C8");
    expect(shortened).not.toBe(shortened.toLowerCase());
  });

  it("leaves anything already short alone", () => {
    expect(shortenAddress("0x1234" as Address)).toBe("0x1234");
  });
});

describe("normalizeMnemonicInput", () => {
  const CANONICAL = "test test test test test test test test test test test junk";

  it("leaves an already-clean phrase untouched", () => {
    expect(normalizeMnemonicInput(CANONICAL)).toBe(CANONICAL);
  });

  it("collapses double spaces", () => {
    expect(normalizeMnemonicInput("test  test   junk")).toBe("test test junk");
  });

  it("strips leading and trailing whitespace", () => {
    expect(normalizeMnemonicInput(`\n  ${CANONICAL}  \n`)).toBe(CANONICAL);
  });

  it("turns newlines and tabs into single spaces", () => {
    expect(normalizeMnemonicInput("test\ntest\tjunk")).toBe("test test junk");
    expect(normalizeMnemonicInput("test\r\ntest\r\njunk")).toBe("test test junk");
  });

  it("lowercases", () => {
    expect(normalizeMnemonicInput("TEST Test JUNK")).toBe("test test junk");
  });

  it("handles a phrase pasted one word per line", () => {
    expect(normalizeMnemonicInput(CANONICAL.split(" ").join("\n"))).toBe(CANONICAL);
  });

  it("removes non-breaking spaces", () => {
    expect(normalizeMnemonicInput("test\u00a0test\u00a0junk")).toBe("test test junk");
  });

  /**
   * 🇪🇸 NOTA: el caso que no se ve. `\s` de JavaScript NO cubre los caracteres
   * de ancho cero, así que sin quitarlos aparte la frase sigue teniendo doce
   * palabras en pantalla y el checksum falla igualmente. El usuario ve doce
   * palabras correctas y un error, sin nada que lo explique.
   */
  it("removes zero-width characters a password manager may inject", () => {
    expect(normalizeMnemonicInput("\ufefftest\u200btest\u200djunk")).toBe("testtestjunk");
    expect(normalizeMnemonicInput(`${CANONICAL}\u200b`)).toBe(CANONICAL);
    expect(normalizeMnemonicInput("test\u200b test junk")).toBe("test test junk");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeMnemonicInput("")).toBe("");
    expect(normalizeMnemonicInput("   \n\t ")).toBe("");
  });
});
