import { describe, expect, it } from "vitest";

import { formatEther, isHexQuantity, looksLikeAddress, shortenAddress } from "@/lib/format";

const ANVIL_FIRST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("formatEther", () => {
  it("formats a whole amount", () => {
    expect(formatEther("0xde0b6b3a7640000")).toBe("1.0000");
  });

  it("formats zero", () => {
    expect(formatEther("0x0")).toBe("0.0000");
  });

  it("formats Anvil's 10000 ETH", () => {
    expect(formatEther("0x21e19e0c9bab2400000")).toBe("10000.0000");
  });

  /**
   * ------------------------------------------------------------------------
   * THE BUG THIS FUNCTION EXISTS TO NOT HAVE
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: 10^15 wei son 0.001 ETH. El resto de dividir entre 10^18 es
   * 1000000000000000 — QUINCE dígitos, no dieciocho, porque un número no
   * conserva sus ceros a la izquierda. Sin el `padStart(18, "0")`, cortar los
   * cuatro primeros da "1000" y se muestra 0.1000: cien veces el saldo real.
   *
   * Contra Anvil no se ve nunca, porque sus 10000 ETH son exactos. Aparece la
   * primera vez que alguien recibe una cantidad pequeña, que es justo cuando
   * más caro sale.
   */
  it("does not lose the leading zeros of the fraction", () => {
    // 10^15 wei = 0.001 ETH
    expect(formatEther("0x38d7ea4c68000")).toBe("0.0010");
  });

  it("keeps small amounts small", () => {
    // 10^12 wei = 0.000001 ETH — below the display precision, so it reads zero.
    expect(formatEther("0xe8d4a51000")).toBe("0.0000");
  });

  /**
   * 🇪🇸 NOTA: se trunca, no se redondea. Un saldo nunca debe mostrarse MAYOR de
   * lo que es: alguien que ve 1.0000 y tiene 0.99999 intenta mandar 1 ETH y la
   * transacción falla.
   */
  it("truncates instead of rounding up", () => {
    // 0.99999 ETH
    expect(formatEther("0xdE0B6B3A763FFFF")).toBe("0.9999");
  });

  /**
   * 🇪🇸 NOTA: 12345678.9 ETH son 1.23456789e25 wei — nueve órdenes de magnitud
   * por encima de `Number.MAX_SAFE_INTEGER` (9.007e15). Ésa es la razón de que
   * toda la función use BigInt: con `Number` el valor ya llega redondeado antes
   * de dividir, y el saldo mostrado sería inventado.
   */
  it("stays exact well past Number.MAX_SAFE_INTEGER", () => {
    expect(formatEther("0xa364c981e1bd52e520000")).toBe("12345678.9000");
  });
});

describe("shortenAddress", () => {
  it("keeps the checksum casing intact", () => {
    expect(shortenAddress(ANVIL_FIRST)).toBe("0xf39F…2266");
  });

  it("leaves anything already short alone", () => {
    expect(shortenAddress("0x1234")).toBe("0x1234");
  });
});

describe("looksLikeAddress", () => {
  it.each([
    ANVIL_FIRST,
    "0x0000000000000000000000000000000000000000",
    `  ${ANVIL_FIRST}  `,
  ])("accepts %s", (value) => {
    expect(looksLikeAddress(value)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["no 0x prefix", "f39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
    ["too short", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb922"],
    ["too long", `${ANVIL_FIRST}00`],
    ["not hex", "0xzzzzd6e51aad88F6F4ce6aB8827279cffFb92266"],
    ["an ENS name", "vitalik.eth"],
  ])("rejects %s", (_label, value) => {
    expect(looksLikeAddress(value)).toBe(false);
  });
});

describe("isHexQuantity", () => {
  it.each(["0x0", "0xde0b6b3a7640000", "0xABCDEF"])("accepts %s", (value) => {
    expect(isHexQuantity(value)).toBe(true);
  });

  /**
   * 🇪🇸 NOTA: esto es lo que evita que un `BigInt()` sobre una respuesta rara
   * lance un SyntaxError y acabe mostrado como si fuera un error del provider.
   */
  it.each([
    ["0x alone", "0x"],
    ["a decimal string", "1000"],
    ["a number", 1000],
    ["null", null],
    ["undefined", undefined],
    ["an array", []],
  ])("rejects %s", (_label, value) => {
    expect(isHexQuantity(value)).toBe(false);
  });
});
