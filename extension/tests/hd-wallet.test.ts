import { describe, expect, it } from "vitest";

import { ErrorCode } from "@/types/messages";
import { ProviderError } from "@/lib/errors";
import {
  MAX_ACCOUNTS,
  createMnemonic,
  deriveAddresses,
  deriveSigner,
  hdPathForIndex,
  isValidMnemonic,
} from "@/lib/hd-wallet";

/**
 * Anvil's public test phrase. Every Ethereum developer's node starts with these
 * accounts, which makes them the one derivation result we can assert against an
 * external source of truth rather than against ourselves.
 */
const ANVIL_PHRASE = "test test test test test test test test test test test junk";

const ANVIL_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
];

/** Asserts a rejection is protocol vocabulary, not a stray exception. */
function expectInvalidParams(run: () => unknown): ProviderError {
  let thrown: unknown;
  try {
    run();
  } catch (cause) {
    thrown = cause;
  }
  expect(thrown).toBeInstanceOf(ProviderError);
  const error = thrown as ProviderError;
  expect(error.serialized.code).toBe(ErrorCode.INVALID_PARAMS);
  return error;
}

describe("deriveAddresses", () => {
  it("derives Anvil's five well-known accounts, in order", () => {
    expect(deriveAddresses(ANVIL_PHRASE, 5)).toEqual(ANVIL_ADDRESSES);
  });

  it("returns checksummed addresses", () => {
    // Not the same assertion as above: a lowercase result would still be the
    // right account but would break every string comparison downstream.
    const [first] = deriveAddresses(ANVIL_PHRASE, 1);
    expect(first).toBe(ANVIL_ADDRESSES[0]);
    expect(first).not.toBe(ANVIL_ADDRESSES[0]?.toLowerCase());
  });

  it("is deterministic across calls", () => {
    expect(deriveAddresses(ANVIL_PHRASE, 3)).toEqual(deriveAddresses(ANVIL_PHRASE, 3));
  });

  it("derives along m/44'/60'/0'/0/i", () => {
    expect(hdPathForIndex(0)).toBe("m/44'/60'/0'/0/0");
    expect(hdPathForIndex(7)).toBe("m/44'/60'/0'/0/7");
  });

  it("rejects a count outside 1..MAX_ACCOUNTS", () => {
    expectInvalidParams(() => deriveAddresses(ANVIL_PHRASE, 0));
    expectInvalidParams(() => deriveAddresses(ANVIL_PHRASE, -1));
    expectInvalidParams(() => deriveAddresses(ANVIL_PHRASE, 1.5));
    expectInvalidParams(() => deriveAddresses(ANVIL_PHRASE, MAX_ACCOUNTS + 1));
  });
});

describe("deriveSigner", () => {
  it("agrees with deriveAddresses on the same index", () => {
    expect(deriveSigner(ANVIL_PHRASE, 0).address).toBe(deriveAddresses(ANVIL_PHRASE, 1)[0]);
    expect(deriveSigner(ANVIL_PHRASE, 4).address).toBe(deriveAddresses(ANVIL_PHRASE, 5)[4]);
  });

  it("exposes a signer on the expected BIP-44 path", () => {
    expect(deriveSigner(ANVIL_PHRASE, 2).path).toBe("m/44'/60'/0'/0/2");
  });

  it("rejects an out-of-range index", () => {
    expectInvalidParams(() => deriveSigner(ANVIL_PHRASE, -1));
    expectInvalidParams(() => deriveSigner(ANVIL_PHRASE, 1.5));
    expectInvalidParams(() => deriveSigner(ANVIL_PHRASE, MAX_ACCOUNTS));
  });
});

describe("createMnemonic", () => {
  it("produces a valid 12-word phrase", () => {
    const phrase = createMnemonic();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(isValidMnemonic(phrase)).toBe(true);
  });

  it("produces a different phrase every time", () => {
    const phrases = new Set(Array.from({ length: 8 }, () => createMnemonic()));
    expect(phrases.size).toBe(8);
  });

  it("produces phrases that derive usable accounts", () => {
    expect(deriveAddresses(createMnemonic(), 1)[0]).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("invalid mnemonics", () => {
  const ELEVEN_WORDS = "test test test test test test test test test test test";
  const BAD_CHECKSUM = "test test test test test test test test test test test test";
  const NOT_IN_WORDLIST = "codecrypto test test test test test test test test test test junk";

  const cases: Array<[label: string, phrase: string]> = [
    ["11 words", ELEVEN_WORDS],
    ["broken checksum", BAD_CHECKSUM],
    ["word outside the wordlist", NOT_IN_WORDLIST],
    ["empty string", ""],
    ["only whitespace", "   "],
  ];

  it.each(cases)("isValidMnemonic rejects %s", (_label, phrase) => {
    expect(isValidMnemonic(phrase)).toBe(false);
  });

  it.each(cases)("deriveAddresses throws a typed error for %s", (_label, phrase) => {
    expectInvalidParams(() => deriveAddresses(phrase, 1));
  });

  it.each(cases)("deriveSigner throws a typed error for %s", (_label, phrase) => {
    expectInvalidParams(() => deriveSigner(phrase, 0));
  });

  /**
   * 🇪🇸 NOTA: este es el test que protege la regla de higiene de secretos. Si
   * alguien "mejora" el mensaje de error para incluir la frase que falló —cosa
   * que parece útil mientras depuras— este test lo caza. Se comprueba contra
   * una frase con palabras poco comunes para que la coincidencia sea señal y no
   * ruido.
   */
  it("never leaks the input phrase in the error message", () => {
    const secret = "vault ozone garment ritual ceiling puppy fabric velvet cabbage ostrich mimic junk";
    const error = expectInvalidParams(() => deriveAddresses(secret, 1));
    const serialized = JSON.stringify(error.serialized) + error.message + (error.stack ?? "");

    for (const word of secret.split(" ")) {
      expect(serialized.toLowerCase()).not.toContain(word);
    }
  });
});
