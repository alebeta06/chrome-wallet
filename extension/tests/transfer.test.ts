import { describe, expect, it } from "vitest";

import { ErrorCode, type Address } from "@/types/messages";
import { ProviderError } from "@/lib/errors";
import { parseInternalTransfer, transferTransaction } from "@/lib/transfer";

const ACCOUNTS: Address[] = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
];

function expectInvalidParams(run: () => unknown): ProviderError {
  try {
    run();
  } catch (cause) {
    expect(cause).toBeInstanceOf(ProviderError);
    expect((cause as ProviderError).serialized.code).toBe(ErrorCode.INVALID_PARAMS);
    return cause as ProviderError;
  }
  throw new Error("expected it to throw");
}

describe("parseInternalTransfer", () => {
  it("reads a well-formed transfer", () => {
    expect(parseInternalTransfer([{ fromIndex: 0, toIndex: 2, valueWei: "0xde0b6b3a7640000" }], 3))
      .toEqual({ fromIndex: 0, toIndex: 2, valueWei: "0xde0b6b3a7640000" });
  });

  it.each([
    ["nothing", []],
    ["a string", ["nope"]],
    ["an array", [[]]],
    ["null", [null]],
  ])("refuses %s", (_label, params) => {
    expectInvalidParams(() => parseInternalTransfer(params, 3));
  });

  /**
   * 🇪🇸 NOTA: contra el número REAL de cuentas.
   * `noUncheckedIndexedAccess` está desactivado, así que `accounts[7]` con tres
   * cuentas compila y devuelve `undefined`; firmar desde ahí reventaría mucho
   * más abajo con un mensaje que no se parece al problema.
   */
  it.each([
    ["out of range above", { fromIndex: 3, toIndex: 0 }],
    ["negative", { fromIndex: -1, toIndex: 0 }],
    ["fractional", { fromIndex: 0.5, toIndex: 1 }],
    ["a string", { fromIndex: "0", toIndex: 1 }],
    ["missing", { toIndex: 1 }],
    ["destination out of range", { fromIndex: 0, toIndex: 9 }],
  ])("refuses an index that is %s", (_label, indices) => {
    expectInvalidParams(() =>
      parseInternalTransfer([{ ...indices, valueWei: "0x1" }], ACCOUNTS.length),
    );
  });

  /** Valid on-chain, and pure gas burn. The dropdown does not offer it either. */
  it("refuses sending to the same account", () => {
    const error = expectInvalidParams(() =>
      parseInternalTransfer([{ fromIndex: 1, toIndex: 1, valueWei: "0x1" }], 3),
    );

    expect(error.serialized.message).toContain("different account");
  });

  it.each([
    ["not hex", "1000"],
    ["empty", ""],
    ["a number", 1000],
    ["decimal-looking", "0.5"],
  ])("refuses a value that is %s", (_label, valueWei) => {
    expectInvalidParams(() => parseInternalTransfer([{ fromIndex: 0, toIndex: 1, valueWei }], 3));
  });

  it("refuses zero", () => {
    expectInvalidParams(() => parseInternalTransfer([{ fromIndex: 0, toIndex: 1, valueWei: "0x0" }], 3));
  });

  it("accepts one wei", () => {
    expect(
      parseInternalTransfer([{ fromIndex: 0, toIndex: 1, valueWei: "0x1" }], 3).valueWei,
    ).toBe("0x1");
  });

  it("refuses everything when the wallet has no accounts", () => {
    expectInvalidParams(() => parseInternalTransfer([{ fromIndex: 0, toIndex: 1, valueWei: "0x1" }], 0));
  });
});

describe("transferTransaction", () => {
  it("resolves both ends from the wallet's own accounts", () => {
    const tx = transferTransaction(ACCOUNTS, { fromIndex: 0, toIndex: 2, valueWei: "0x1" });

    expect(tx.from).toBe(ACCOUNTS[0]);
    expect(tx.to).toBe(ACCOUNTS[2]);
    expect(tx.value).toBe("0x1");
  });

  /**
   * 🇪🇸 NOTA: `data: "0x"` explícito y no ausente. Una transferencia de valor no
   * lleva calldata, y decirlo no es lo mismo que dejar que el firmante lo
   * adivine — que es cómo una transferencia acaba pareciendo una llamada a
   * contrato en la ventana que la enseña.
   */
  it("says there is no calldata rather than leaving it out", () => {
    expect(transferTransaction(ACCOUNTS, { fromIndex: 0, toIndex: 1, valueWei: "0x1" }).data).toBe(
      "0x",
    );
  });
});
