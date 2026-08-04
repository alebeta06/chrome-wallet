/**
 * @file lib/networks.ts
 * @description chainId → a name a person recognises.
 *
 * 🇪🇸 NOTA: `eth_chainId` devuelve "0x7a69". Enseñar eso tal cual obliga a quien
 * mira a convertirlo de cabeza para saber si está en la red que cree. Mostrar
 * "Anvil Local · 31337 · 0x7a69" cuesta esta tabla y quita una clase entera de
 * confusión — la de firmar en una red creyendo que es otra.
 *
 * La lista es corta a propósito: las dos que la extensión trae de serie, más
 * mainnet porque es donde el error de red duele de verdad. Una red desconocida
 * se muestra igual, con su número, en vez de esconderse detrás de "unknown".
 */

const KNOWN_CHAINS: Readonly<Record<string, string>> = {
  "0x1": "Ethereum Mainnet",
  "0xaa36a7": "Sepolia",
  "0x7a69": "Anvil Local",
};

export interface ChainDescription {
  name: string;
  /** null when the wallet answered with something that is not a hex quantity. */
  decimal: number | null;
  chainId: string;
  known: boolean;
}

const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;

export function describeChain(chainId: unknown): ChainDescription {
  if (typeof chainId !== "string" || !HEX_QUANTITY.test(chainId)) {
    return {
      name: "Unrecognised answer",
      decimal: null,
      chainId: typeof chainId === "string" ? chainId : String(chainId),
      known: false,
    };
  }

  const normalised = chainId.toLowerCase();
  const decimal = Number.parseInt(normalised, 16);
  const known = normalised in KNOWN_CHAINS;

  return {
    name: KNOWN_CHAINS[normalised] ?? `Chain ${decimal}`,
    decimal,
    chainId: normalised,
    known,
  };
}

const EXPLORERS: Readonly<Record<string, string>> = {
  "0x1": "https://etherscan.io",
  "0xaa36a7": "https://sepolia.etherscan.io",
  // Anvil is local and has no explorer, which is why this map has a hole in it.
};

/**
 * A link to the transaction, when the network has somewhere to link to.
 *
 * 🇪🇸 NOTA: devuelve null para Anvil a propósito. Un enlace roto a un explorador
 * que no existe es peor que no ofrecer enlace: el usuario lo pulsa, ve un 404 y
 * se pregunta si la transacción ha fallado.
 */
export function explorerTxUrl(chainId: string | null, hash: string): string | null {
  if (chainId === null) return null;
  const base = EXPLORERS[chainId.toLowerCase()];
  return base === undefined ? null : `${base}/tx/${hash}`;
}
