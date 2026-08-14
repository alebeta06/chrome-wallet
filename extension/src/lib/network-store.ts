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

import type { EventEmitter } from "./events";
import {
  DEFAULT_CHAIN_ID,
  findNetwork,
  migrateCatalogue,
  removeNetwork,
  upsertNetwork,
  type RemovalResult,
} from "./networks";
import { createSerializer } from "./serialize";
import type { WalletStorage } from "./storage";

/**
 * Cleanup that has to happen with the removal, not after it.
 *
 * 🇪🇸 NOTA: se inyecta en vez de importar `permissions.ts` aquí, por la misma
 * razón que el predicado de `fallbackIfUnusable`: este módulo no sabe nada de
 * `chrome.*` y así el caso entero se prueba sin navegador.
 */
export type AfterRemoval = (
  removed: NetworkConfig,
  remaining: NetworkConfig[],
) => Promise<void>;

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
  /**
   * Removes a user network, or explains why it would not.
   *
   * `afterRemoval` runs INSIDE the serialized turn, with the entry that went and
   * the catalogue that is left. See the note on the implementation.
   */
  remove(chainId: Hex, afterRemoval?: AfterRemoval): Promise<RemovalResult>;
  /**
   * Moves off the active network if it is no longer usable. Resolves with the
   * new chain id, or null when nothing moved.
   */
  fallbackIfUnusable(isUsable: (network: NetworkConfig) => Promise<boolean>): Promise<Hex | null>;
}

/** Inert by default: a test that only reads a catalogue should not need tabs. */
const NO_EMIT: EventEmitter = () => Promise.resolve();

export function createNetworkStore(
  storage: WalletStorage,
  emit: EventEmitter = NO_EMIT,
): NetworkStore {
  /**
   * 🇪🇸 NOTA: `cc:networks` es un array entero en una sola clave, así que dar de
   * alta o borrar una red es un read-modify-write, y dos a la vez se pisan. La
   * cadena es SUYA: el mecanismo y —sobre todo— lo que NO cubre están en
   * `serialize.ts`.
   */
  const serialize = createSerializer();

  /**
   * ------------------------------------------------------------------------
   * A CHAIN THAT CHANGES WITHOUT SAYING SO IS A DESYNCHRONISED dApp
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: `chainChanged` es global —lo dice `EVENT_SCOPE` del contrato— así
   * que va a todos los orígenes conectados y `changedOrigin` es null.
   *
   * Se emite después de persistir, nunca antes: una dApp que reaccione al
   * evento preguntando `eth_chainId` tiene que encontrarse el valor nuevo, no
   * el que estaba a medio escribir.
   */
  async function announceChain(chainId: Hex): Promise<void> {
    const connectedSites = (await storage.get("cc:connectedSites")) ?? {};

    try {
      await emit("chainChanged", chainId, { changedOrigin: null, connectedSites });
    } catch (cause) {
      // A dApp that missed the event is worse than one that missed it silently,
      // but neither is a reason to fail the write that already landed.
      console.error("[codecrypto] could not announce the chain change:", cause);
    }
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

        if (unchanged) return next;

        await persist(next);

        /**
         * ------------------------------------------------------------------
         * THE CLAMP IS A CHAIN CHANGE, AND IT HAS TO BE ANNOUNCED
         * ------------------------------------------------------------------
         * 🇪🇸 NOTA: si el activo guardado ya no existe, la migración lo mueve a
         * Anvil. Una dApp abierta tiene el chainId viejo cacheado desde su
         * `eth_chainId` inicial y nadie la corrige nunca: firmaría creyendo
         * estar en una red y estaría en otra. Es la misma desincronización que
         * cierra la comprobación de deriva en las aprobaciones pendientes,
         * vista desde el otro lado.
         *
         * La condición es que el valor GUARDADO cambie, no que la migración
         * escriba. Añadir una red también escribe y no mueve al usuario de red;
         * emitir ahí sería un `chainChanged` mentiroso. Y sin la guarda de
         * `undefined`, una instalación nueva emitiría un cambio de red que no
         * ha ocurrido — a nadie, porque no hay sitios conectados, pero sería
         * igual de falso.
         */
        if (storedChainId !== undefined && storedChainId !== next.chainId) {
          await announceChain(next.chainId);
        }

        return next;
      });
    },

    async active(): Promise<NetworkConfig | undefined> {
      const { networks, chainId } = await read();
      return findNetwork(networks, chainId);
    },

    /**
     * ------------------------------------------------------------------------
     * EVERY WAY OF CHANGING THE CHAIN ANNOUNCES IT, BECAUSE THEY ALL COME HERE
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: la emisión vive DENTRO del store y no en quien llama. Hay tres
     * caminos que mueven la red activa —el selector del popup, un
     * `wallet_switchEthereumChain` de una dApp, y el clampeo de la migración— y
     * dejar el `chainChanged` en cada uno significa que el cuarto se olvidará.
     * El síntoma de olvidarlo no es un error: es una dApp que sigue creyendo que
     * está en la red anterior hasta que alguien recarga.
     *
     * Un cambio a la red que ya estaba activa devuelve `true` y NO emite: la
     * llamada tuvo éxito —estás donde pediste estar— pero no ha cambiado nada
     * que contar.
     */
    setActive(chainId: Hex): Promise<boolean> {
      return serialize(async () => {
        const current = await read();
        if (findNetwork(current.networks, chainId) === undefined) return false;
        if (current.chainId === chainId) return true;

        await persist({ networks: current.networks, chainId });
        await announceChain(chainId);

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
    /**
     * ------------------------------------------------------------------------
     * THE CLEANUP RUNS INSIDE THE TURN, AND THAT IS THE WHOLE POINT
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: al borrar una red hay que revocar su permiso de host, pero solo
     * si ninguna OTRA red del catálogo usa el mismo patrón de origen. Ese
     * cálculo y la revocación tienen que ir en el mismo turno serializado que el
     * borrado.
     *
     * Lo que cierra: que el conteo se haga contra el catálogo YA sin la red
     * borrada, y que dos borrados simultáneos vean el efecto del otro. Sin esto,
     * dos redes que comparten patrón borradas a la vez leen ambas el catálogo de
     * antes, cada una ve a la otra, y NINGUNA revoca — permiso huérfano y nada
     * que lo delate. Hay un test que se pone rojo si el conteo sale del turno.
     *
     * Lo que NO cierra, y conviene tenerlo escrito: un alta que aterrice DESPUÉS
     * de la revocación. Eso no es un read-modify-write, es orden entre dos
     * operaciones independientes, y serializar no lo arregla — la escritura del
     * alta va después y punto. El desenlace ahí es visible y reversible: la red
     * nueva aparece en `unusableChainIds` con su botón de reconceder, que es el
     * camino del bloque D. No es silencioso, que es la diferencia que importa.
     */

    remove(chainId: Hex, afterRemoval?: AfterRemoval): Promise<RemovalResult> {
      return serialize(async () => {
        const current = await read();
        const result = removeNetwork(current.networks, chainId, current.chainId);
        if (!result.ok) return result;

        const removed = findNetwork(current.networks, chainId);

        /**
         * 🇪🇸 NOTA: se persiste ANTES de limpiar. Borrar es lo que el usuario
         * pidió; revocar es aseo. Y la revocación no es que pueda fallar: en
         * Chrome falla SIEMPRE —ver la cabecera de `lib/permissions.ts`—, así
         * que este orden es el único que deja al usuario con lo que pidió. Al
         * revés, ninguna red se borraría nunca porque no supimos limpiar detrás.
         */
        await persist({ networks: result.networks, chainId: current.chainId });

        if (removed !== undefined && afterRemoval !== undefined) {
          await afterRemoval(removed, result.networks);
        }

        return result;
      });
    },

    /**
     * ------------------------------------------------------------------------
     * A REVOKED PERMISSION LEAVES THE WALLET POINTING AT A DEAD NETWORK
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: el usuario puede dejar la wallet sin permisos sin pasar por ella,
     * moviendo Site access a "On click" en `chrome://extensions` — medido en la
     * comprobación 80, y se los quita TODOS de golpe, builtin incluidas. Si
     * era el de la red activa, todo lo que consulte la red empieza a fallar y
     * el popup no tendría forma de explicar por qué: las cuentas están, la red
     * está en el selector, y los saldos no llegan.
     *
     * Moverse a la red por defecto es reversible en un clic y visible en el
     * selector. Quedarse quieto no es ninguna de las dos cosas.
     *
     * El predicado se inyecta en vez de importar `permissions.ts` para que este
     * módulo siga sin saber nada de `chrome.*` y el caso se pueda probar sin
     * navegador.
     */
    fallbackIfUnusable(
      isUsable: (network: NetworkConfig) => Promise<boolean>,
    ): Promise<Hex | null> {
      return serialize(async () => {
        const current = await read();
        const active = findNetwork(current.networks, current.chainId);

        // Already the default, or gone entirely — migrate() owns that case.
        if (active === undefined || active.chainId === DEFAULT_CHAIN_ID) return null;
        if (await isUsable(active)) return null;

        await persist({ networks: current.networks, chainId: DEFAULT_CHAIN_ID });
        await announceChain(DEFAULT_CHAIN_ID);

        return DEFAULT_CHAIN_ID;
      });
    },
  };
}

/** Re-exported so callers do not need two imports for the common fallback. */
export { DEFAULT_CHAIN_ID };
