import { describe, expect, it } from "vitest";

import { ErrorCode, type Address } from "@/types/messages";
import { ProviderError } from "@/lib/errors";
import {
  functionSelector,
  isContractCall,
  parseTransactionRequest,
} from "@/lib/tx";

const MINE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const TARGET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const ONE_ETH = "0xde0b6b3a7640000";

function parse(tx: unknown, authorised: Address = MINE) {
  return parseTransactionRequest([tx], authorised);
}

function expectCode(run: () => unknown, code: number): ProviderError {
  try {
    run();
  } catch (cause) {
    if (!(cause instanceof ProviderError)) throw new Error(`expected a ProviderError: ${String(cause)}`);
    expect(cause.serialized.code).toBe(code);
    return cause;
  }
  throw new Error("expected a rejection");
}

describe("the from check", () => {
  /**
   * ------------------------------------------------------------------------
   * THE CHECK THIS WHOLE MODULE EXISTS FOR
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: una dApp puede poner cualquier `from`. Sin esta comprobación, una
   * web conectada a tu cuenta 0 pide firmar desde la cuenta 3, la ventana
   * enseña la cuenta 3, y tú la apruebas porque la ventana lo dice. El permiso
   * que diste era para UNA cuenta, no para la wallet entera.
   */
  it("refuses a from that is not the account this origin was granted", () => {
    const error = expectCode(
      () => parse({ from: OTHER, to: TARGET, value: ONE_ETH }),
      ErrorCode.UNAUTHORIZED,
    );

    expect(error.serialized.message).toContain(MINE);
  });

  it("accepts the authorised account", () => {
    expect(parse({ from: MINE, to: TARGET, value: ONE_ETH }).from).toBe(MINE);
  });

  /** EIP-55 checksums differ only in casing; the same address is the same address. */
  it("compares addresses case-insensitively", () => {
    expect(parse({ from: MINE.toLowerCase(), to: TARGET }).from).toBe(MINE);
  });

  /**
   * 🇪🇸 NOTA: sin `from` se rellena con la cuenta del origen. Es lo que espera
   * una dApp bien escrita y no hay ambigüedad: solo hay una cuenta que ese
   * origen puede usar.
   */
  it("fills in the account when from is absent", () => {
    expect(parse({ to: TARGET, value: ONE_ETH }).from).toBe(MINE);
  });

  it("never returns the from the dApp sent, only the authorised one", () => {
    // Same address, different casing: the answer is the canonical one.
    expect(parse({ from: MINE.toLowerCase(), to: TARGET }).from).toBe(MINE);
  });

  it.each([
    ["a non-address string", "vitalik.eth"],
    ["a truncated address", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb922"],
    ["a number", 42],
    ["null", null],
  ])("rejects %s as from with -32602", (_label, from) => {
    expectCode(() => parse({ from, to: TARGET }), ErrorCode.INVALID_PARAMS);
  });
});

describe("the to address", () => {
  it("accepts a well-formed address", () => {
    expect(parse({ to: TARGET }).to).toBe(TARGET);
  });

  /**
   * 🇪🇸 NOTA: sin `to` es un despliegue de contrato. No está en el alcance y
   * firmarlo por accidente crearía un contrato con los fondos del usuario.
   */
  it.each([
    ["a missing to", {}],
    ["an explicit null", { to: null }],
    ["an explicit undefined", { to: undefined }],
  ])("refuses %s rather than deploying a contract", (_label, tx) => {
    const error = expectCode(() => parse(tx), ErrorCode.INVALID_PARAMS);
    expect(error.serialized.message).toContain("deployment");
  });

  it.each([
    ["not hex", "0xzzz4CdDdB6a900fa2b585dd299e03d12FA4293BC"],
    ["too short", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293"],
    ["too long", `${TARGET}00`],
    ["a number", 1],
  ])("rejects %s", (_label, to) => {
    expectCode(() => parse({ to }), ErrorCode.INVALID_PARAMS);
  });
});

describe("value, gas and the other quantities", () => {
  it("defaults value to zero", () => {
    expect(parse({ to: TARGET }).value).toBe("0x0");
  });

  it("keeps an explicit value", () => {
    expect(parse({ to: TARGET, value: ONE_ETH }).value).toBe(ONE_ETH);
  });

  /**
   * 🇪🇸 NOTA: si la dApp manda las fees explícitamente se respetan. Es una
   * petición legítima — una dApp puede querer acelerar una transacción — y
   * sobrescribirlas en silencio haría que la wallet mandara algo distinto de lo
   * que se le pidió.
   */
  it("keeps explicit EIP-1559 fees", () => {
    const parsed = parse({
      to: TARGET,
      maxFeePerGas: "0x77359400",
      maxPriorityFeePerGas: "0x3b9aca00",
    });

    expect(parsed.maxFeePerGas).toBe("0x77359400");
    expect(parsed.maxPriorityFeePerGas).toBe("0x3b9aca00");
  });

  it("keeps an explicit nonce", () => {
    expect(parse({ to: TARGET, nonce: "0x5" }).nonce).toBe("0x5");
  });

  /** Both spellings are seen in the wild; both mean the gas limit. */
  it.each(["gas", "gasLimit"])("accepts %s", (field) => {
    expect(parse({ to: TARGET, [field]: "0x5208" }).gas).toBe("0x5208");
  });

  it.each([
    ["a decimal string", "1000000000000000000"],
    ["a plain number", 1],
    ["0x on its own", "0x"],
    ["not hex", "0xzz"],
    ["null", null],
  ])("rejects %s as value with -32602", (_label, value) => {
    expectCode(() => parse({ to: TARGET, value }), ErrorCode.INVALID_PARAMS);
  });

  it("names the offending field in the message", () => {
    const error = expectCode(
      () => parse({ to: TARGET, maxFeePerGas: "nope" }),
      ErrorCode.INVALID_PARAMS,
    );
    expect(error.serialized.message).toContain("maxFeePerGas");
  });
});

describe("data", () => {
  it("defaults to empty", () => {
    expect(parse({ to: TARGET }).data).toBe("0x");
  });

  it("keeps well-formed calldata", () => {
    const data = "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead";
    expect(parse({ to: TARGET, data }).data).toBe(data);
  });

  /**
   * 🇪🇸 NOTA: un número impar de dígitos hex es medio byte, que no es calldata
   * válido. Dejarlo pasar convierte el problema en un fallo del nodo DESPUÉS de
   * que el usuario haya aprobado — el peor momento posible para descubrirlo.
   */
  it.each([
    ["an odd number of digits", "0xabc"],
    ["no 0x prefix", "a9059cbb"],
    ["not hex", "0xzzzz"],
    ["a number", 1],
  ])("rejects %s", (_label, data) => {
    expectCode(() => parse({ to: TARGET, data }), ErrorCode.INVALID_PARAMS);
  });
});

describe("unknown fields", () => {
  /**
   * 🇪🇸 NOTA: lista blanca, no lista negra. Ignorar en silencio un campo
   * desconocido significa firmar algo distinto de lo que la dApp pidió, y la
   * dApp creyendo que se firmó lo suyo.
   */
  it("refuses a field it does not understand", () => {
    const error = expectCode(
      () => parse({ to: TARGET, accessList: [] }),
      ErrorCode.INVALID_PARAMS,
    );
    expect(error.serialized.message).toContain("accessList");
  });

  it("tolerates chainId and type, which are checked elsewhere", () => {
    expect(() => parse({ to: TARGET, chainId: "0x7a69", type: "0x2" })).not.toThrow();
  });
});

describe("the shape of the params array", () => {
  it.each([
    ["no params", []],
    ["a string", ["0xdead"]],
    ["null", [null]],
    ["an array", [[]]],
    ["a number", [1]],
  ])("rejects %s with -32602", (_label, params) => {
    expectCode(() => parseTransactionRequest(params, MINE), ErrorCode.INVALID_PARAMS);
  });
});

describe("isContractCall", () => {
  /**
   * 🇪🇸 NOTA: éste es el caso que hace peligroso el phishing — `value: 0`
   * tranquiliza, y el `data` es lo que te vacía el token. La ventana de firma
   * necesita poder distinguirlo para poder decirlo.
   */
  it("spots a call that moves no ETH", () => {
    expect(isContractCall({ data: "0xa9059cbb" })).toBe(true);
  });

  it("treats empty calldata as a plain transfer", () => {
    expect(isContractCall({ data: "0x" })).toBe(false);
  });

  it("reads the selector when there is one", () => {
    expect(functionSelector({ data: "0xa9059cbb0000dead" })).toBe("0xa9059cbb");
  });

  it("returns null when the calldata is shorter than a selector", () => {
    expect(functionSelector({ data: "0xabcd" })).toBeNull();
    expect(functionSelector({ data: "0x" })).toBeNull();
  });
});
