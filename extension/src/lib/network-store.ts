/**
 * @file lib/network-store.ts
 * @description The persisted network catalogue: `cc:networks` plus the active
 * `cc:chainId`, and the serialized chain that every write goes through.
 *
 * ---------------------------------------------------------------------------
 * TWO KEYS, ONE INVARIANT, THEREFORE ONE CHAIN
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: la lección de la Fase 6, otra vez y con un agravante. `cc:networks`
 * es un array entero en una sola clave, así que añadir o quitar una red es un
 * read-modify-write, y `chrome.storage.local` no tiene transacciones: dos altas
 * simultáneas leen el mismo catálogo y la segunda escritura se lleva por
 * delante a la primera. Sin error, sin log, sin nada: la red simplemente no
 * está.
 *
 * El agravante es que aquí son DOS claves con un invariante entre ellas — la
 * red activa tiene que existir en el catálogo — así que además de serializar
 * hay que escribirlas juntas con `setMany`. Un borrado que quite la red y
 * después mueva el activo deja, entre las dos escrituras, una ventana en la que
 * el worker puede morir y dejar `cc:chainId` apuntando a nada.
 *
 * La cadena vive en el closure, como en approvals.ts y en signer.ts. Que no
 * sobreviva al reinicio del worker es correcto: si el worker murió, no hay
 * escrituras en vuelo contra las que serializar.
 *
 * 🇪🇸 NOTA: **una sola instancia por worker**. El background la construye una
 * vez y la inyecta en el despachador. Dos instancias serían dos cadenas que no
 * se ven entre sí, que es exactamente no tener cadena.
 */

import type { Hex, NetworkConfig } from "@/types/messages";

import {
  DEFAULT_CHAIN_ID,
  findNetwork,
  migrateCatalogue,
  removeNetwork,
  upsertNetwork,
  type RemovalResult,
} from "./networks";
import type { WalletStorage } from "./storage";

export interface Catalogue {
  networks: NetworkConfig[];
  chainId: Hex;
}

export interface NetworkStore {
  /** Reads what is stored, in current shape. Does not write. */
  read(): Promise<Catalogue>;
  /** Brings storage to the current shape, writing only when something changed. */
  migrate(): Promise<Catalogue>;
  /** Resolves the active NetworkConfig, or undefined if it vanished. */
  active(): Promise<NetworkConfig | undefined>;
  /** Switches the active network. Refuses a chain id that is not in the catalogue. */
  setActive(chainId: Hex): Promise<boolean>;
  /** Adds or overwrites a user network. Built-ins are left untouched. */
  upsert(entry: NetworkConfig): Promise<NetworkConfig[]>;
  /** Removes a user network, or explains why it would not. */
  remove(chainId: Hex): Promise<RemovalResult>;
}

export function createNetworkStore(storage: WalletStorage): NetworkStore {
  let writes: Promise<unknown> = Promise.resolve();

  /** Both branches run the task: a previous failure must not stall the chain. */
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = writes.then(task, task);
    writes = next.catch(() => undefined);
    return next;
  }

  /**
   * 🇪🇸 NOTA: leer también pasa por `migrateCatalogue`. No es por convertir nada
   * —eso lo hace `migrate()`— sino porque el resto del código no puede tener que
   * preguntarse si el worker ya migró. Una lectura que ocurra antes de que
   * termine la migración del arranque devuelve la forma buena igualmente, y así
   * no hay un orden de inicialización del que depender.
   */
  async function read(): Promise<Catalogue> {
    const [stored, storedChainId] = await Promise.all([
      storage.get("cc:networks"),
      storage.get("cc:chainId"),
    ]);

    return migrateCatalogue(stored, storedChainId);
  }

  async function persist(next: Catalogue): Promise<void> {
    // One write for both keys: the active network must never point at a gap.
    await storage.setMany({ "cc:networks": next.networks, "cc:chainId": next.chainId });
  }

  return {
    read,

    /**
     * 🇪🇸 NOTA: no escribe si no hay nada que cambiar, y por eso la idempotencia
     * importa de verdad y no como propiedad de adorno. Esto corre en CADA
     * arranque del service worker, o sea muchas veces al día. Si escribiera
     * siempre, cada arranque dispararía `chrome.storage.onChanged`, que es lo
     * que refresca el badge y despertaría a la UI abierta sin motivo.
     */
    migrate(): Promise<Catalogue> {
      return serialize(async () => {
        const [stored, storedChainId] = await Promise.all([
          storage.get("cc:networks"),
          storage.get("cc:chainId"),
        ]);

        const next = migrateCatalogue(stored, storedChainId);

        const unchanged =
          storedChainId === next.chainId &&
          JSON.stringify(stored) === JSON.stringify(next.networks);

        if (!unchanged) await persist(next);
        return next;
      });
    },

    async active(): Promise<NetworkConfig | undefined> {
      const { networks, chainId } = await read();
      return findNetwork(networks, chainId);
    },

    setActive(chainId: Hex): Promise<boolean> {
      return serialize(async () => {
        const current = await read();
        if (findNetwork(current.networks, chainId) === undefined) return false;
        if (current.chainId === chainId) return true;

        await persist({ networks: current.networks, chainId });
        return true;
      });
    },

    upsert(entry: NetworkConfig): Promise<NetworkConfig[]> {
      return serialize(async () => {
        const current = await read();
        const networks = upsertNetwork(current.networks, entry);

        await persist({ networks, chainId: current.chainId });
        return networks;
      });
    },

    /**
     * 🇪🇸 NOTA: la comprobación de "¿se puede borrar?" y la escritura van en el
     * MISMO turno serializado, igual que la deduplicación de `approvals.ts`.
     * Separadas, dos borrados concurrentes de redes distintas leen ambos el
     * catálogo completo y el segundo reescribe la red que el primero acababa de
     * quitar — que vuelve a aparecer sola.
     */
    remove(chainId: Hex): Promise<RemovalResult> {
      return serialize(async () => {
        const current = await read();
        const result = removeNetwork(current.networks, chainId, current.chainId);

        if (result.ok) await persist({ networks: result.networks, chainId: current.chainId });
        return result;
      });
    },
  };
}

/** Re-exported so callers do not need two imports for the common fallback. */
export { DEFAULT_CHAIN_ID };
