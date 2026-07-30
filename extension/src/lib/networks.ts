/**
 * @file lib/networks.ts
 * @description The built-in network catalogue.
 *
 * These two are `builtIn: true`, which per the contract means the user cannot
 * remove them. User-added networks arrive in phase 8 and get persisted under
 * `cc:networks`; until then this catalogue lives in code, not in storage.
 */

import type { Hex, NetworkConfig } from "@/types/messages";

/** Anvil's default chain id, 31337. */
export const ANVIL_CHAIN_ID: Hex = "0x7a69";

/** Sepolia, 11155111. */
export const SEPOLIA_CHAIN_ID: Hex = "0xaa36a7";

/** What a fresh wallet points at. Local first: no faucet, no rate limits. */
export const DEFAULT_CHAIN_ID: Hex = ANVIL_CHAIN_ID;

export const DEFAULT_NETWORKS: readonly NetworkConfig[] = [
  {
    chainId: ANVIL_CHAIN_ID,
    name: "Anvil Local",
    rpcUrl: "http://localhost:8545",
    symbol: "ETH",
    explorerUrl: null,
    builtIn: true,
  },
  {
    chainId: SEPOLIA_CHAIN_ID,
    name: "Sepolia",
    rpcUrl: "https://sepolia.drpc.org",
    symbol: "ETH",
    explorerUrl: "https://sepolia.etherscan.io",
    builtIn: true,
  },
];

/** A fresh, mutable copy — callers must not be able to edit the catalogue. */
export function defaultNetworks(): NetworkConfig[] {
  return DEFAULT_NETWORKS.map((network) => ({ ...network }));
}
