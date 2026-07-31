/**
 * @file lib/chain.ts
 * @description Reads chain state over JSON-RPC. The second and last module that
 * imports ethers — and, like hd-wallet.ts, nothing under src/ui may touch it.
 */

import { JsonRpcProvider, toBeHex } from "ethers";

import { ErrorCode, type Address, type Hex, type NetworkConfig } from "@/types/messages";
import { ProviderError } from "./errors";

/**
 * Injected into the dispatcher so the RPC handlers can be tested without a
 * node running. Same pattern as StorageArea.
 */
export type BalanceReader = (
  network: NetworkConfig,
  addresses: Address[],
) => Promise<Record<Address, Hex>>;

export const fetchBalances: BalanceReader = async (network, addresses) => {
  /**
   * 🇪🇸 NOTA: un provider POR PETICIÓN, nunca en una variable de módulo. El
   * service worker se suspende cuando le apetece y se lleva por delante el
   * provider a medio uso; y si el usuario cambia de red, un provider cacheado
   * seguiría consultando la anterior.
   *
   * `batchMaxCount: 1` desactiva el batching JSON-RPC: dRPC rechaza los batches
   * y hará falta en Sepolia. `staticNetwork: true` evita que ethers añada un
   * eth_chainId de validación a cada llamada, que en un worker que arranca de
   * cero constantemente es una petición de red por cada consulta.
   */
  const provider = new JsonRpcProvider(network.rpcUrl, undefined, {
    batchMaxCount: 1,
    staticNetwork: true,
  });

  try {
    const values = await Promise.all(addresses.map((address) => provider.getBalance(address)));

    const balances: Record<Address, Hex> = {};
    addresses.forEach((address, index) => {
      balances[address] = toBeHex(values[index]) as Hex;
    });
    return balances;
  } catch (cause) {
    // Full detail stays in the service worker console; the wire gets a code.
    console.error(`[codecrypto] balance lookup failed on ${network.name}:`, cause);

    /**
     * 🇪🇸 NOTA: 4901 (CHAIN_DISCONNECTED) y no -32603. La diferencia importa
     * para la UI: -32603 significa "hay un bug", 4901 significa "tu wallet está
     * bien, el nodo no responde". Con Anvil apagado el popup tiene que seguir
     * mostrando las cuentas y avisar de la red, no parecer que se ha roto.
     *
     * El mensaje lleva el NOMBRE de la red, no la rpcUrl: una URL con API key
     * dentro no tiene por qué acabar en un objeto de error.
     */
    throw new ProviderError({
      code: ErrorCode.CHAIN_DISCONNECTED,
      message: `Cannot reach the RPC endpoint for ${network.name}.`,
    });
  } finally {
    // JsonRpcProvider extends JsonRpcApiPollingProvider: without this, every
    // request would leave a poller behind in the worker.
    provider.destroy();
  }
};
