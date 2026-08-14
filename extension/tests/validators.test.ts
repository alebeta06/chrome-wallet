import { describe, expect, it } from "vitest";

import { ErrorCode } from "@/types/messages";
import {
  ETH_DECIMALS,
  parseAmount,
  toWei,
  validateAddress,
  validateAmount,
  validateChainId,
  validateNetworkName,
  validateRpcUrl,
  type ValidationResult,
} from "@/lib/validators";

const ANVIL_FIRST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ONE_ETH = 10n ** 18n;
const ONE_WEI = 1n;
/** A realistic 21000 * 20 gwei. */
const FEE = 420_000_000_000_000n;

function expectValid(result: ValidationResult): void {
  expect(result).toEqual({ ok: true });
}

function expectInvalid(result: ValidationResult): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    // 🇪🇸 NOTA: del catálogo EIP-1193, nunca un código propio.
    expect(result.code).toBe(ErrorCode.INVALID_PARAMS);
    expect(result.message.length).toBeGreaterThan(0);
  }
}

describe("validateAddress", () => {
  it.each([ANVIL_FIRST, "0x" + "0".repeat(40), "0x" + "F".repeat(40)])("accepts %s", (value) => {
    expectValid(validateAddress(value));
  });

  it.each([
    ["empty", ""],
    ["no prefix", "f39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
    ["too short", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb9226"],
    ["too long", `${ANVIL_FIRST}0`],
    ["not hex", `0x${"z".repeat(40)}`],
    ["a number", 1],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expectInvalid(validateAddress(value));
  });

  /**
   * 🇪🇸 NOTA: se comprueba la FORMA, no el checksum EIP-55. Verificarlo necesita
   * keccak —ethers— y este módulo lo importa la UI. Está escrito aquí para que
   * nadie lo lea como un descuido: es la regla del bundle del popup.
   */
  it("accepts an address whose checksum casing is wrong", () => {
    expectValid(validateAddress(ANVIL_FIRST.toLowerCase()));
  });
});

describe("validateChainId", () => {
  it.each(["0x1", "0x7a69", "0xaa36a7", "0x89"])("accepts %s", (value) => {
    expectValid(validateChainId(value));
  });

  it.each([
    ["decimal", "31337"],
    ["zero", "0x0"],
    ["no prefix", "7a69"],
    ["not hex", "0xzz"],
    ["empty", ""],
    ["a number", 31337],
  ])("rejects %s", (_label, value) => {
    expectInvalid(validateChainId(value));
  });
});

describe("validateRpcUrl", () => {
  it.each([
    "https://ethereum-sepolia-rpc.publicnode.com",
    "http://localhost:8545",
    "http://127.0.0.1:8545",
  ])("accepts %s", (value) => {
    expectValid(validateRpcUrl(value));
  });

  /** 🇪🇸 NOTA: http fuera de local es la política de la Fase 8, no una nueva. */
  it.each([
    ["plain http", "http://example.com"],
    ["not a url", "nonsense"],
    ["empty", ""],
    ["whitespace", "   "],
    ["a number", 8545],
  ])("rejects %s", (_label, value) => {
    expectInvalid(validateRpcUrl(value));
  });

  it("tolerates the whitespace a paste leaves behind", () => {
    expectValid(validateRpcUrl("  http://localhost:8545  "));
  });
});

describe("validateNetworkName", () => {
  it.each(["Anvil", "Sepolia", "a"])("accepts %s", (value) => {
    expectValid(validateNetworkName(value));
  });

  it.each([
    ["empty", ""],
    ["only spaces", "   "],
    ["only a tab", "\t"],
    ["a number", 1],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expectInvalid(validateNetworkName(value));
  });
});

describe("parseAmount", () => {
  it.each<[string, bigint]>([
    ["0", 0n],
    ["1", ONE_ETH],
    ["0.5", ONE_ETH / 2n],
    ["1.5", ONE_ETH + ONE_ETH / 2n],
    ["10000", 10_000n * ONE_ETH],
    // 🇪🇸 NOTA: el borde del padEnd. Sin rellenar por la derecha, "0.1" daría 1 wei.
    ["0.1", 10n ** 17n],
    ["0.000000000000000001", ONE_WEI],
    ["0.000000000000000000", 0n],
    ["1.000000000000000001", ONE_ETH + ONE_WEI],
  ])("parses %s", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each([
    ["nineteen decimals", "0.0000000000000000001"],
    ["negative", "-1"],
    ["exponential", "1e18"],
    ["hex", "0x1"],
    ["a leading dot", ".5"],
    ["a trailing dot", "1."],
    ["two dots", "1.2.3"],
    ["empty", ""],
    ["a comma", "1,5"],
    ["letters", "abc"],
    ["a space inside", "1 5"],
  ])("refuses %s", (_label, input) => {
    expect(parseAmount(input)).toBeNull();
  });

  it("takes exactly eighteen decimals and no more", () => {
    expect(parseAmount(`0.${"0".repeat(ETH_DECIMALS - 1)}1`)).toBe(ONE_WEI);
    expect(parseAmount(`0.${"0".repeat(ETH_DECIMALS)}1`)).toBeNull();
  });

  it("does not go through Number on the way", () => {
    // 🇪🇸 NOTA: `0.1 * 1e18` en coma flotante da 100000000000000000 con error
    // escondido; este valor tiene más precisión de la que un `number` conserva.
    expect(parseAmount("0.100000000000000001")).toBe(10n ** 17n + ONE_WEI);
  });
});

describe("validateAmount", () => {
  const rich = { balanceWei: ONE_ETH, feeWei: FEE };
  const spendable = ONE_ETH - FEE;

  it("accepts a normal amount", () => {
    expectValid(validateAmount("0.5", rich));
  });

  it("accepts one wei", () => {
    expectValid(validateAmount("0.000000000000000001", rich));
  });

  /**
   * ------------------------------------------------------------------------
   * THE BOUNDARY IS INCLUSIVE, AND ON PURPOSE
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: gastar exactamente saldo menos fee deja la cuenta a cero, y es algo
   * que la gente hace a propósito. Un `>=` aquí en vez de `>` haría que "enviar
   * todo" fuese siempre inválido por un wei, sin que el mensaje lo explicara.
   */
  it("accepts exactly balance minus fee", () => {
    expectValid(validateAmount(weiToDecimal(spendable), rich));
  });

  it("refuses one wei more than balance minus fee", () => {
    expectInvalid(validateAmount(weiToDecimal(spendable + ONE_WEI), rich));
  });

  it("accepts one wei less than balance minus fee", () => {
    expectValid(validateAmount(weiToDecimal(spendable - ONE_WEI), rich));
  });

  /** Validating against the balance alone is the classic bug this rules out. */
  it("refuses the whole balance, because the fee still has to come out", () => {
    expectInvalid(validateAmount(weiToDecimal(ONE_ETH), rich));
  });

  it.each([
    ["zero", "0"],
    ["zero with decimals", "0.000000000000000000"],
  ])("refuses %s", (_label, input) => {
    expectInvalid(validateAmount(input, rich));
  });

  it("refuses anything that is not a decimal number", () => {
    expectInvalid(validateAmount("abc", rich));
    expectInvalid(validateAmount("0.0000000000000000001", rich));
  });

  /**
   * 🇪🇸 NOTA: mensaje propio. "Excede el máximo" sería cierto y no ayudaría: no
   * hay ninguna cantidad válida, y decir cuál es el problema ahorra que el
   * usuario pruebe cifras cada vez más pequeñas.
   */
  it("says the fee alone eats the balance, rather than talking about a maximum", () => {
    const result = validateAmount("0.000000000000000001", { balanceWei: FEE, feeWei: FEE });

    expectInvalid(result);
    if (!result.ok) expect(result.message).toContain("fee");
  });

  it("refuses everything when the fee is larger than the balance", () => {
    expectInvalid(validateAmount("0.000000000000000001", { balanceWei: 1n, feeWei: FEE }));
  });

  it("refuses everything on an empty account", () => {
    expectInvalid(validateAmount("0.000000000000000001", { balanceWei: 0n, feeWei: 0n }));
  });

  /** With no fee at all, the ceiling is simply the balance. */
  it("lets the whole balance go when the fee is zero", () => {
    expectValid(validateAmount("1", { balanceWei: ONE_ETH, feeWei: 0n }));
    expectInvalid(validateAmount("1.000000000000000001", { balanceWei: ONE_ETH, feeWei: 0n }));
  });
});

describe("toWei", () => {
  it("reads a hex balance the way storage holds it", () => {
    expect(toWei("0x0")).toBe(0n);
    expect(toWei("0xde0b6b3a7640000")).toBe(ONE_ETH);
  });
});

/** Exact wei to its decimal string, so the boundary tests say what they mean. */
function weiToDecimal(wei: bigint): string {
  const whole = wei / ONE_ETH;
  const fraction = (wei % ONE_ETH).toString().padStart(ETH_DECIMALS, "0");
  return `${whole.toString()}.${fraction}`;
}
