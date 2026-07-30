/**
 * @file lib/hd-wallet.ts
 * @description BIP-39 / BIP-44 derivation. The ONLY module that imports ethers.
 *
 * Pure: no chrome.* anywhere, no storage, no side effects. That is what makes it
 * testable in isolation, and it is also what keeps `ethers` out of the UI
 * bundles — nothing under src/ui imports this file, directly or transitively.
 *
 * ---------------------------------------------------------------------------
 * SECRET HYGIENE
 * ---------------------------------------------------------------------------
 * No function here logs the phrase or a private key, not partially, not in a
 * catch, not "just the first four words". Validation errors describe the
 * PROBLEM, never the INPUT.
 *
 * 🇪🇸 NOTA: la razón no es paranoia. La consola del service worker persiste
 * entre recargas, y un `console.log(phrase)` puesto para depurar cinco minutos
 * es exactamente el que se queda en el commit. La regla solo funciona si es
 * absoluta: aquí dentro la frase no se imprime nunca, y punto.
 */

import { HDNodeWallet, Mnemonic, randomBytes } from "ethers";

import type { Address } from "@/types/messages";
import { invalidParams } from "./errors";

/** BIP-44 for Ethereum: purpose 44', coin 60', account 0', external chain 0. */
export const DEFAULT_HD_PATH_PREFIX = "m/44'/60'/0'/0";

/**
 * Upper bound for a single derivation request.
 *
 * 🇪🇸 NOTA: `deriveAddresses` es un bucle sobre `count`. Sin tope, un
 * `accountCount: 1e9` cuelga el service worker sin recuperación posible. El
 * contrato no lo acota, así que se acota aquí, que es donde está el bucle.
 */
export const MAX_ACCOUNTS = 100;

export function hdPathForIndex(index: number): string {
  assertAccountIndex(index);
  return `${DEFAULT_HD_PATH_PREFIX}/${index}`;
}

function assertAccountIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_ACCOUNTS) {
    throw invalidParams(`Account index must be an integer between 0 and ${MAX_ACCOUNTS - 1}.`);
  }
}

function assertMnemonic(phrase: string): void {
  if (typeof phrase !== "string" || phrase.trim().length === 0) {
    throw invalidParams("A mnemonic phrase is required.");
  }
  if (!Mnemonic.isValidMnemonic(phrase)) {
    // Deliberately vague about WHICH of the three failed, and silent about the
    // input itself.
    throw invalidParams(
      "Invalid mnemonic phrase: wrong word count, unknown word, or bad checksum.",
    );
  }
}

/**
 * A brand new 12-word phrase.
 *
 * 16 bytes = 128 bits of entropy = 12 words. `randomBytes` is ethers' wrapper
 * over crypto.getRandomValues, which exists in a service worker.
 */
export function createMnemonic(): string {
  return Mnemonic.fromEntropy(randomBytes(16)).phrase;
}

/** Never throws; use it to check, not to guard derivation (that throws instead). */
export function isValidMnemonic(phrase: string): boolean {
  return Mnemonic.isValidMnemonic(phrase);
}

/**
 * The first `count` addresses of the account, in order. Addresses only — no
 * private keys leave this function.
 */
export function deriveAddresses(phrase: string, count: number): Address[] {
  assertMnemonic(phrase);
  if (!Number.isInteger(count) || count < 1 || count > MAX_ACCOUNTS) {
    throw invalidParams(`Account count must be an integer between 1 and ${MAX_ACCOUNTS}.`);
  }

  // Parse the phrase once: this is the expensive step (PBKDF2 over the seed).
  const mnemonic = Mnemonic.fromPhrase(phrase);

  const addresses: Address[] = [];
  for (let index = 0; index < count; index += 1) {
    addresses.push(walletAt(mnemonic, index).address as Address);
  }
  return addresses;
}

/**
 * The signer for one account. Holds a private key: it must never be returned
 * from an RPC handler, only used inside the service worker to sign.
 */
export function deriveSigner(phrase: string, index: number): HDNodeWallet {
  assertMnemonic(phrase);
  assertAccountIndex(index);
  return walletAt(Mnemonic.fromPhrase(phrase), index);
}

/**
 * 🇪🇸 NOTA: aquí está el gotcha de ethers v6 que cuesta media tarde.
 *
 *   // ❌ "cannot derive root path ... for a node at non-zero depth"
 *   const w = HDNodeWallet.fromPhrase(phrase);   // ya viene en m/44'/60'/0'/0/0
 *   w.derivePath("m/44'/60'/0'/0/0");            // depth 5, no puede derivar
 *                                                // desde una ruta absoluta
 *
 * `fromPhrase` NO devuelve la raíz: devuelve el nodo ya derivado en la ruta por
 * defecto. Pedirle una ruta absoluta a un nodo que no está en la raíz es un
 * error de BIP-32, no de ethers. La vía correcta es construir el Mnemonic y
 * dejar que `fromMnemonic` derive la ruta completa desde la semilla.
 */
function walletAt(mnemonic: Mnemonic, index: number): HDNodeWallet {
  return HDNodeWallet.fromMnemonic(mnemonic, `${DEFAULT_HD_PATH_PREFIX}/${index}`);
}
