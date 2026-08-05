import { describe, expect, it, vi } from "vitest";
import { verifyTypedData } from "ethers";

import { ErrorCode, type Address } from "@/types/messages";
import { ProviderError } from "@/lib/errors";
import { createTransactionSender } from "@/lib/signer";
import {
  describeDomain,
  describeMessage,
  domainChainId,
  parseTypedDataParams,
  signableTypes,
} from "@/lib/typed-data";

const PHRASE = "test test test test test test test test test test test junk";
const ANVIL_FIRST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const ANVIL_SECOND = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

/** The canonical EIP-712 example from the spec itself. */
const ETHER_MAIL = {
  domain: {
    name: "Ether Mail",
    version: "1",
    chainId: 31337,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  types: {
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
};

function parse(payload: unknown, address: Address = ANVIL_FIRST) {
  return parseTypedDataParams([ANVIL_FIRST, JSON.stringify(payload)], address);
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

describe("the address check", () => {
  /**
   * 🇪🇸 NOTA: el mismo control del `from` de la Fase 6, y por el mismo motivo.
   * Una dApp conectada a tu cuenta 0 no puede pedirte que firmes como la 3: el
   * permiso que diste era para UNA cuenta.
   */
  it("refuses to sign as an account this origin was not granted", () => {
    const error = expectCode(
      () => parseTypedDataParams([ANVIL_SECOND, JSON.stringify(ETHER_MAIL)], ANVIL_FIRST),
      ErrorCode.UNAUTHORIZED,
    );

    expect(error.serialized.message).toContain(ANVIL_FIRST);
  });

  it("accepts the authorised account whatever its casing", () => {
    expect(
      parseTypedDataParams([ANVIL_FIRST.toLowerCase(), JSON.stringify(ETHER_MAIL)], ANVIL_FIRST)
        .address,
    ).toBe(ANVIL_FIRST);
  });

  it.each([
    ["a non-address", "vitalik.eth"],
    ["a truncated address", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb922"],
    ["a number", 42],
    ["nothing at all", undefined],
  ])("rejects %s with -32602", (_label, address) => {
    expectCode(
      () => parseTypedDataParams([address, JSON.stringify(ETHER_MAIL)], ANVIL_FIRST),
      ErrorCode.INVALID_PARAMS,
    );
  });
});

describe("the payload", () => {
  it("accepts the canonical example", () => {
    expect(parse(ETHER_MAIL).payload.primaryType).toBe("Mail");
  });

  /**
   * 🇪🇸 NOTA: el payload llega como CADENA JSON. Sin capturar el SyntaxError,
   * `toSerializedError` lo redactaría a un -32603 genérico — "error interno de
   * la wallet" cuando el problema es que la dApp mandó JSON roto.
   */
  it("turns broken JSON into -32602, not an internal error", () => {
    const error = expectCode(
      () => parseTypedDataParams([ANVIL_FIRST, "{ not json"], ANVIL_FIRST),
      ErrorCode.INVALID_PARAMS,
    );

    expect(error.serialized.code).not.toBe(ErrorCode.INTERNAL);
    expect(error.serialized.message).toContain("JSON");
  });

  it("refuses typed data sent as an object instead of a string", () => {
    expectCode(
      () => parseTypedDataParams([ANVIL_FIRST, ETHER_MAIL], ANVIL_FIRST),
      ErrorCode.INVALID_PARAMS,
    );
  });

  it.each([
    ["no domain", { ...ETHER_MAIL, domain: undefined }],
    ["no types", { ...ETHER_MAIL, types: undefined }],
    ["no message", { ...ETHER_MAIL, message: undefined }],
    ["no primaryType", { ...ETHER_MAIL, primaryType: undefined }],
    ["an empty primaryType", { ...ETHER_MAIL, primaryType: "" }],
    ["a numeric primaryType", { ...ETHER_MAIL, primaryType: 1 }],
    ["a domain that is an array", { ...ETHER_MAIL, domain: [] }],
  ])("rejects %s with -32602", (_label, payload) => {
    expectCode(() => parse(payload), ErrorCode.INVALID_PARAMS);
  });

  /**
   * 🇪🇸 NOTA: ethers también lo rechazaría, pero mucho más adelante — después de
   * haberle enseñado al usuario una ventana de firma para algo que nunca se iba
   * a poder firmar. Se corta antes de molestar a nadie.
   */
  it("refuses a primaryType that is not declared in types", () => {
    const error = expectCode(
      () => parse({ ...ETHER_MAIL, primaryType: "Invoice" }),
      ErrorCode.INVALID_PARAMS,
    );

    expect(error.serialized.message).toContain("Invoice");
  });

  it("refuses a type whose fields are not properly declared", () => {
    expectCode(
      () => parse({ ...ETHER_MAIL, types: { ...ETHER_MAIL.types, Mail: [{ name: "x" }] } }),
      ErrorCode.INVALID_PARAMS,
    );
  });

  it("keeps the raw string, which is what gets signed", () => {
    const raw = JSON.stringify(ETHER_MAIL);

    expect(parseTypedDataParams([ANVIL_FIRST, raw], ANVIL_FIRST).raw).toBe(raw);
  });
});

describe("signableTypes and the EIP712Domain gotcha", () => {
  const WITH_DOMAIN_TYPE = {
    ...ETHER_MAIL,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...ETHER_MAIL.types,
    },
  };

  it("strips EIP712Domain from what ethers is given", () => {
    const { payload } = parse(WITH_DOMAIN_TYPE);

    expect(signableTypes(payload).EIP712Domain).toBeUndefined();
    expect(signableTypes(payload).Mail).toBeDefined();
  });

  /**
   * ------------------------------------------------------------------------
   * THE COPY IS THE POINT
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: se borra sobre una copia porque el objeto original se guarda en la
   * solicitud pendiente, y la ventana tiene que enseñar el payload TAL COMO
   * LLEGÓ. Si se mutara aquí, el usuario vería algo distinto de lo que su dApp
   * envió — pequeño, pero es exactamente la clase de diferencia que no se debe
   * introducir en una pantalla de firma.
   */
  it("does not mutate the payload the window will render", () => {
    const { payload } = parse(WITH_DOMAIN_TYPE);

    signableTypes(payload);

    expect(payload.types.EIP712Domain).toBeDefined();
  });

  it("leaves a payload without EIP712Domain alone", () => {
    const { payload } = parse(ETHER_MAIL);

    expect(Object.keys(signableTypes(payload)).sort()).toEqual(["Mail", "Person"]);
  });
});

describe("domainChainId", () => {
  it("reads a numeric chainId", () => {
    expect(domainChainId(parse(ETHER_MAIL).payload)).toBe("0x7a69");
  });

  it("reads a hex chainId", () => {
    const payload = parse({ ...ETHER_MAIL, domain: { ...ETHER_MAIL.domain, chainId: "0x1" } });

    expect(domainChainId(payload.payload)).toBe("0x1");
  });

  /** A domain with no chainId is legal: a login that is valid on any chain. */
  it("returns null when the domain names no chain", () => {
    const payload = parse({ ...ETHER_MAIL, domain: { name: "Login", version: "1" } });

    expect(domainChainId(payload.payload)).toBeNull();
  });

  it.each([
    ["a non-numeric string", "mainnet"],
    ["a negative number", -1],
    ["a fractional number", 1.5],
    ["an object", {}],
  ])("returns null for %s rather than guessing", (_label, chainId) => {
    const payload = parse({ ...ETHER_MAIL, domain: { ...ETHER_MAIL.domain, chainId } });

    expect(domainChainId(payload.payload)).toBeNull();
  });
});

// ============================================================================
// The test that proves this is real EIP-712 and not a lookalike
// ============================================================================

describe("interoperability", () => {
  /**
   * ------------------------------------------------------------------------
   * SIGN, THEN RECOVER. IF ANY OF IT IS WRONG, THE ADDRESS COMES BACK WRONG.
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: éste es EL test de la fase. `verifyTypedData` recalcula el hash
   * EIP-712 desde cero —dominio, tipos, mensaje— y recupera quién firmó. Si el
   * separador de dominio estuviera mal construido, si faltara un tipo, si el
   * `primaryType` fuera otro o si el encoding no fuera el del estándar, la
   * dirección recuperada sería DISTINTA y el test fallaría.
   *
   * Es la diferencia entre "produce una firma" y "produce una firma que un
   * contrato aceptaría". Una firma mal construida verifica perfectamente contra
   * su propio código equivocado y falla en cadena.
   */
  const sender = createTransactionSender();

  it("produces a signature that verifies back to the signer", async () => {
    const { payload } = parse(ETHER_MAIL);

    const signature = await sender.signTypedData({
      phrase: PHRASE,
      accountIndex: 0,
      address: ANVIL_FIRST,
      payload,
    });

    const recovered = verifyTypedData(
      payload.domain,
      signableTypes(payload),
      payload.message,
      signature,
    );

    expect(recovered).toBe(ANVIL_FIRST);
  });

  it("verifies for an account other than the first", async () => {
    const { payload } = parse(ETHER_MAIL);

    const signature = await sender.signTypedData({
      phrase: PHRASE,
      accountIndex: 1,
      address: ANVIL_SECOND,
      payload,
    });

    expect(
      verifyTypedData(payload.domain, signableTypes(payload), payload.message, signature),
    ).toBe(ANVIL_SECOND);
  });

  /** The gotcha, proven end to end rather than just unit-tested. */
  it("signs and verifies a payload that included EIP712Domain", async () => {
    const { payload } = parse({
      ...ETHER_MAIL,
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        ...ETHER_MAIL.types,
      },
    });

    const signature = await sender.signTypedData({
      phrase: PHRASE,
      accountIndex: 0,
      address: ANVIL_FIRST,
      payload,
    });

    expect(
      verifyTypedData(payload.domain, signableTypes(payload), payload.message, signature),
    ).toBe(ANVIL_FIRST);
  });

  /** Nested structs and arrays, not just flat fields. */
  it("signs and verifies a payload with arrays of structs", async () => {
    const { payload } = parse({
      domain: { name: "Orders", version: "1", chainId: 31337 },
      types: {
        Item: [
          { name: "sku", type: "string" },
          { name: "amount", type: "uint256" },
        ],
        Order: [
          { name: "buyer", type: "address" },
          { name: "items", type: "Item[]" },
        ],
      },
      primaryType: "Order",
      message: {
        buyer: ANVIL_FIRST,
        items: [
          { sku: "A-1", amount: 2 },
          { sku: "B-7", amount: 5 },
        ],
      },
    });

    const signature = await sender.signTypedData({
      phrase: PHRASE,
      accountIndex: 0,
      address: ANVIL_FIRST,
      payload,
    });

    expect(
      verifyTypedData(payload.domain, signableTypes(payload), payload.message, signature),
    ).toBe(ANVIL_FIRST);
  });

  /**
   * 🇪🇸 NOTA: el control. Si `verifyTypedData` devolviera la dirección correcta
   * aunque el mensaje cambiara, los tests de arriba no probarían nada.
   */
  it("(control) a tampered message recovers a different address", async () => {
    const { payload } = parse(ETHER_MAIL);

    const signature = await sender.signTypedData({
      phrase: PHRASE,
      accountIndex: 0,
      address: ANVIL_FIRST,
      payload,
    });

    const recovered = verifyTypedData(
      payload.domain,
      signableTypes(payload),
      { ...payload.message, contents: "Goodbye, Bob!" },
      signature,
    );

    expect(recovered).not.toBe(ANVIL_FIRST);
  });

  it("refuses to sign as an account it did not derive", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { payload } = parse(ETHER_MAIL);

    await expect(
      sender.signTypedData({
        phrase: PHRASE,
        accountIndex: 1, // derives ANVIL_SECOND
        address: ANVIL_FIRST,
        payload,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  /**
   * 🇪🇸 NOTA: firmar es criptografía local — no hay nonce, no hay fees y no hay
   * nada que difundir. Este `createTransactionSender` no tiene ningún nodo
   * detrás y aun así firma, que es exactamente por lo que
   * `eth_signTypedData_v4` funciona con Anvil apagado.
   */
  it("needs no network at all", async () => {
    const noNode = createTransactionSender(() => {
      throw new Error("there is no node here");
    });
    const { payload } = parse(ETHER_MAIL);

    await expect(
      noNode.signTypedData({
        phrase: PHRASE,
        accountIndex: 0,
        address: ANVIL_FIRST,
        payload,
      }),
    ).resolves.toMatch(/^0x[0-9a-f]+$/i);
  });
});

// ============================================================================
// Rendering
// ============================================================================

describe("describeDomain", () => {
  it("orders the fields so verifyingContract is visible", () => {
    const rows = describeDomain(parse(ETHER_MAIL).payload);

    expect(rows.map((row) => row.label)).toEqual([
      "name",
      "version",
      "chainId",
      "verifyingContract",
    ]);
  });

  it("skips fields the domain does not have", () => {
    const { payload } = parse({ ...ETHER_MAIL, domain: { name: "Login" } });

    expect(describeDomain(payload).map((row) => row.label)).toEqual(["name"]);
  });
});

describe("describeMessage", () => {
  /**
   * 🇪🇸 NOTA: nada de `JSON.stringify` sobre el mensaje entero. Los tipos están
   * declarados, así que cada campo se puede enseñar con su nombre — que es la
   * diferencia entre "aquí hay un objeto" y "esto autoriza a 0xCcCc… a gastar".
   */
  it("walks the declared types instead of dumping JSON", () => {
    const fields = describeMessage(parse(ETHER_MAIL).payload);

    expect(fields.map((field) => field.label)).toEqual(["from", "to", "contents"]);
    expect(fields[0].children?.map((child) => child.label)).toEqual(["name", "wallet"]);
    expect(fields[0].children?.[0].value).toBe("Cow");
    expect(fields[2].value).toBe("Hello, Bob!");
  });

  it("expands an array into one entry per item", () => {
    const { payload } = parse({
      domain: { name: "Orders", version: "1" },
      types: {
        Item: [{ name: "sku", type: "string" }],
        Order: [{ name: "items", type: "Item[]" }],
      },
      primaryType: "Order",
      message: { items: [{ sku: "A-1" }, { sku: "B-7" }] },
    });

    const items = describeMessage(payload)[0];
    expect(items.children).toHaveLength(2);
    expect(items.children?.[0].children?.[0].value).toBe("A-1");
  });

  /**
   * ------------------------------------------------------------------------
   * THE DEPTH CAP IS NOT COSMETIC
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: `types` lo escribe una web. Dos tipos que se referencien
   * mutuamente harían que el recorrido no terminara nunca y la ventana de firma
   * se quedara colgada. El tope convierte un cuelgue en una línea de JSON fea.
   */
  it("stops instead of hanging on mutually recursive types", () => {
    const { payload } = parse({
      domain: { name: "Loop", version: "1" },
      types: {
        A: [{ name: "b", type: "B" }],
        B: [{ name: "a", type: "A" }],
      },
      primaryType: "A",
      message: { b: { a: { b: { a: { b: { a: {} } } } } } },
    });

    const rendered = describeMessage(payload);

    expect(rendered).toHaveLength(1);
    // It got to the cap and stopped, rather than never returning.
    expect(JSON.stringify(rendered)).toContain("truncated");
  });

  it("renders a scalar field even when its value is missing", () => {
    const { payload } = parse({ ...ETHER_MAIL, message: { contents: "only this" } });

    const fields = describeMessage(payload);
    expect(fields.find((field) => field.label === "contents")?.value).toBe("only this");
    expect(fields.find((field) => field.label === "from")?.children).toBeDefined();
  });
});
