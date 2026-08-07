/**
 * @file lib/chain.ts
 * @description Reads chain state over JSON-RPC. The second and last module that
 * imports ethers — and, like hd-wallet.ts, nothing under src/ui may touch it.
 */

import { JsonRpcProvider, Network, toBeHex } from "ethers";

import { ErrorCode, type Address, type BlockTag, type Hex, type NetworkConfig } from "@/types/messages";
import { ProviderError } from "./errors";

/**
 * Injected into the dispatcher so the RPC handlers can be tested without a
 * node running. Same pattern as StorageArea.
 */
export type BalanceReader = (
  network: NetworkConfig,
  addresses: Address[],
) => Promise<Record<Address, Hex>>;

/** The single-address, block-aware read behind the public `eth_getBalance`. */
export type BalanceAtReader = (
  network: NetworkConfig,
  address: Address,
  blockTag: BlockTag,
) => Promise<Hex>;

/**
 * The one place a provider is built. Shared with signer.ts.
 *
 * ---------------------------------------------------------------------------
 * A PROVIDER PER REQUEST, AND NO CACHE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: nunca en una variable de módulo. El service worker se suspende
 * cuando le apetece y se lleva por delante el provider a medio uso, así que una
 * caché en memoria del worker es la carrera de la Fase 6 otra vez: estado
 * compartido que a veces está y a veces no, sin nada que avise de cuál de las
 * dos cosas. Y una caché por chainId seguiría sirviendo la conexión vieja
 * después de que el usuario editara el RPC de esa red.
 *
 * ---------------------------------------------------------------------------
 * LAS DOS OPCIONES SON NECESARIAS, Y LA RED TAMBIÉN. MEDIDO
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: `batchMaxCount: 1` desactiva el batching JSON-RPC porque dRPC
 * rechaza los batches, y eso hace falta en Sepolia.
 *
 * `staticNetwork: true` NO basta por sí solo, y ésta es la parte que sorprende.
 * Lo que hace es decirle a ethers "da por buena la red que te di en el
 * constructor" — si no le diste ninguna, no hay nada que dar por bueno y ethers
 * la detecta con un `eth_chainId` de verdad. Contando peticiones contra un
 * servidor HTTP local, con dos `getBalance` por provider y ethers 6.17.0:
 *
 *   url, undefined, { staticNetwork: true }   → 1 eth_chainId  ← lo que había
 *   url, Network,   { staticNetwork: true }   → 0 eth_chainId  ← esto
 *   url, Network,   sin staticNetwork         → 2 eth_chainId  (¡uno por llamada!)
 *
 * O sea que las dos piezas van juntas: la red en el constructor y la opción que
 * hace que ethers se la crea. Con providers por petición, la forma de antes
 * costaba una ida y vuelta EXTRA en cada consulta de saldo — y el popup consulta
 * cada 5 s. Hay un test que cuenta las llamadas al transporte para que nadie
 * quite ninguna de las dos por parecerle redundante.
 *
 * `Network.from` con un bigint no registrado devuelve una red "unknown" con ese
 * chainId en vez de lanzar, así que esto vale igual para una red que el usuario
 * añadió en runtime.
 */
export function createRpcProvider(network: NetworkConfig): JsonRpcProvider {
  return new JsonRpcProvider(network.rpcUrl, Network.from(BigInt(network.chainId)), {
    batchMaxCount: 1,
    staticNetwork: true,
  });
}

/**
 * Asks an endpoint which chain it actually serves.
 *
 * ---------------------------------------------------------------------------
 * THE ONE CALL WHOSE ANSWER WE DO NOT TRUST IN ADVANCE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: esto verifica que un RPC propuesto es de verdad la cadena que la
 * dApp dice. `send` crudo y no `getNetwork()`: el provider se construye con la
 * red DECLARADA y `staticNetwork: true` justamente para no gastar peticiones,
 * así que `getNetwork()` devolvería lo que le dimos —la afirmación que estamos
 * intentando comprobar— en vez de lo que dice el nodo. Un `send("eth_chainId")`
 * va al cable y vuelve con la verdad.
 *
 * Que el provider lleve dentro un chainId posiblemente falso no afecta: no se
 * usa para nada más que para no detectar la red.
 */
export type ChainIdReader = (network: NetworkConfig) => Promise<string>;

export const fetchChainId: ChainIdReader = async (network) => {
  const provider = createRpcProvider(network);

  try {
    return (await provider.send("eth_chainId", [])) as string;
  } catch (cause) {
    throw unreachable(network, cause);
  } finally {
    provider.destroy();
  }
};

/**
 * 🇪🇸 NOTA: 4901 (CHAIN_DISCONNECTED) y no -32603. La diferencia importa para
 * la UI: -32603 significa "hay un bug", 4901 significa "tu wallet está bien, el
 * nodo no responde". Con Anvil apagado el popup tiene que seguir mostrando las
 * cuentas y avisar de la red, no parecer que se ha roto.
 *
 * El mensaje lleva el NOMBRE de la red, no la rpcUrl: una URL con API key dentro
 * no tiene por qué acabar en un objeto de error que cruza hasta una dApp.
 */
function unreachable(network: NetworkConfig, cause: unknown): ProviderError {
  // Full detail stays in the service worker console; the wire gets a code.
  console.error(`[codecrypto] an rpc call failed on ${network.name}:`, cause);

  return new ProviderError({
    code: ErrorCode.CHAIN_DISCONNECTED,
    message: `Cannot reach the RPC endpoint for ${network.name}.`,
  });
}

export const fetchBalances: BalanceReader = async (network, addresses) => {
  const provider = createRpcProvider(network);

  try {
    const values = await Promise.all(addresses.map((address) => provider.getBalance(address)));

    const balances: Record<Address, Hex> = {};
    addresses.forEach((address, index) => {
      balances[address] = toBeHex(values[index]) as Hex;
    });
    return balances;
  } catch (cause) {
    throw unreachable(network, cause);
  } finally {
    // JsonRpcProvider extends JsonRpcApiPollingProvider: without this, every
    // request would leave a poller behind in the worker.
    provider.destroy();
  }
};

/**
 * Reads one balance at one block.
 *
 * 🇪🇸 NOTA: existe aparte de `fetchBalances` por el `blockTag`. El contrato
 * define `eth_getBalance` como `[Address, BlockTag?]`, y es un método PÚBLICO:
 * lo llama una dApp, no nuestra UI. Reutilizar `fetchBalances` habría significado
 * ignorar el segundo parámetro en silencio — devolver el saldo de `latest` a
 * quien preguntó por un bloque concreto es una respuesta incorrecta disfrazada
 * de correcta, que es peor que un error.
 */
export const fetchBalanceAt: BalanceAtReader = async (network, address, blockTag) => {
  const provider = createRpcProvider(network);

  try {
    return toBeHex(await provider.getBalance(address, blockTag)) as Hex;
  } catch (cause) {
    throw unreachable(network, cause);
  } finally {
    provider.destroy();
  }
};
