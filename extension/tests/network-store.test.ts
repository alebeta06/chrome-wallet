import { describe, expect, it } from "vitest";

import type { NetworkConfig, Origin } from "@/types/messages";
import type { EventEmitter } from "@/lib/events";
import { createNetworkStore, type NetworkStore } from "@/lib/network-store";
import {
  ANVIL_CHAIN_ID,
  DEFAULT_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
  findNetwork,
  toNetworkConfig,
} from "@/lib/networks";
import { createWalletStorage, type StorageArea } from "@/lib/storage";
import { createMemoryStorageArea } from "./helpers/memory-storage-area";

function network(chainId: string, rpcUrl: string, name = `Chain ${chainId}`): NetworkConfig {
  return toNetworkConfig(
    {
      chainId: chainId as NetworkConfig["chainId"],
      name,
      rpcUrl,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      explorerUrl: null,
    },
    1_000,
  );
}

const POLYGON = network("0x89", "https://polygon-rpc.com", "Polygon");
const BASE = network("0x2105", "https://mainnet.base.org", "Base");

/** Wraps a storage area so a test can assert how many writes really happened. */
function countingArea(seed: Record<string, unknown> = {}): StorageArea & { writes: number } {
  const inner = createMemoryStorageArea(seed);
  const wrapper = {
    writes: 0,
    get: (keys: string[]) => inner.get(keys),
    set: (items: Record<string, unknown>) => {
      wrapper.writes += 1;
      return inner.set(items);
    },
    remove: (keys: string[]) => inner.remove(keys),
  };
  return wrapper;
}

function storeOn(area: StorageArea): NetworkStore {
  return createNetworkStore(createWalletStorage(area));
}

/** Records every provider event the store emits, in order. */
function recordingEmitter() {
  const emitted: { name: string; data: unknown; changedOrigin: Origin | null }[] = [];

  const emit: EventEmitter = async (name, data, options) => {
    emitted.push({ name, data, changedOrigin: options.changedOrigin });
  };

  return { emit, emitted };
}

function storeWithEmitter(area: StorageArea) {
  const { emit, emitted } = recordingEmitter();
  return { store: createNetworkStore(createWalletStorage(area), emit), emitted };
}

describe("createNetworkStore", () => {
  describe("migrate", () => {
    it("seeds the catalogue on a fresh install", async () => {
      const area = countingArea();
      const { networks, chainId } = await storeOn(area).migrate();

      expect(networks.map((entry) => entry.chainId)).toEqual([ANVIL_CHAIN_ID, SEPOLIA_CHAIN_ID]);
      expect(chainId).toBe(DEFAULT_CHAIN_ID);
      expect(area.writes).toBe(1);
    });

    /**
     * ------------------------------------------------------------------------
     * A NO-OP MIGRATION WRITES NOTHING
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: esto corre en cada arranque del service worker, o sea decenas de
     * veces al día. Una escritura inútil dispara `chrome.storage.onChanged`, que
     * es lo que recalcula el badge y despierta a la UI abierta. Escribir "por si
     * acaso" convertiría cada despertar del worker en un refresco visible.
     */
    it("writes nothing the second time", async () => {
      const area = countingArea();
      const store = storeOn(area);

      await store.migrate();
      const before = area.writes;
      await store.migrate();

      expect(area.writes).toBe(before);
    });

    /**
     * ------------------------------------------------------------------------
     * A CLAMPED CHAIN IS ANNOUNCED, AND ONLY THEN
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: una dApp abierta guarda el chainId de su `eth_chainId` inicial.
     * Si la migración mueve la red activa y no lo dice, esa dApp se queda con
     * el valor viejo para siempre y firmaría creyendo estar en otra red.
     */
    it("announces the chain change when the active network was clamped", async () => {
      const area = countingArea({ "cc:chainId": "0xdead" });
      const { store, emitted } = storeWithEmitter(area);

      await store.migrate();

      expect(emitted).toEqual([
        { name: "chainChanged", data: DEFAULT_CHAIN_ID, changedOrigin: null },
      ]);
    });

    /**
     * 🇪🇸 NOTA: sin esto, cada despertar del service worker emitiría un
     * `chainChanged` a todas las dApps conectadas — decenas al día, todos
     * mintiendo, y cada uno provocando que la dApp vuelva a preguntar y a
     * repintar.
     */
    it("says nothing when there was nothing to clamp", async () => {
      const area = countingArea();
      const { store, emitted } = storeWithEmitter(area);

      await store.migrate();
      await store.migrate();

      expect(emitted).toEqual([]);
    });

    /** Seeding a fresh install is not a chain change: there was no chain before. */
    it("says nothing on a fresh install", async () => {
      const { store, emitted } = storeWithEmitter(countingArea());

      await store.migrate();

      expect(emitted).toEqual([]);
    });

    /**
     * 🇪🇸 NOTA: añadir una red también escribe, y no mueve al usuario de red.
     * Emitir al escribir en vez de al cambiar el valor sería un `chainChanged`
     * mentiroso en cada alta.
     */
    it("says nothing when the write only added a network", async () => {
      const area = countingArea();
      const { store, emitted } = storeWithEmitter(area);
      await store.migrate();

      await store.upsert(POLYGON);
      await store.migrate();

      expect(emitted).toEqual([]);
    });

    it("keeps the active network across a restart", async () => {
      const area = countingArea();
      const store = storeOn(area);

      await store.migrate();
      await store.setActive(SEPOLIA_CHAIN_ID);

      // A new store is what the worker gets after being suspended.
      expect((await storeOn(area).migrate()).chainId).toBe(SEPOLIA_CHAIN_ID);
    });
  });

  describe("read", () => {
    it("returns the current shape without writing", async () => {
      const area = countingArea({ "cc:networks": [POLYGON] });
      const { networks } = await storeOn(area).read();

      expect(networks).toHaveLength(3);
      expect(area.writes).toBe(0);
    });
  });

  describe("setActive", () => {
    it("switches to a network in the catalogue", async () => {
      const store = storeOn(countingArea());
      await store.migrate();

      await expect(store.setActive(SEPOLIA_CHAIN_ID)).resolves.toBe(true);
      expect((await store.read()).chainId).toBe(SEPOLIA_CHAIN_ID);
    });

    it("refuses a chain that is not in the catalogue", async () => {
      const store = storeOn(countingArea());
      await store.migrate();

      await expect(store.setActive("0xdead")).resolves.toBe(false);
      expect((await store.read()).chainId).toBe(DEFAULT_CHAIN_ID);
    });
  });

  describe("remove", () => {
    it("removes a user network and leaves the active one alone", async () => {
      const store = storeOn(countingArea());
      await store.upsert(POLYGON);

      await expect(store.remove(POLYGON.chainId)).resolves.toEqual({
        ok: true,
        networks: expect.any(Array),
      });
      expect(findNetwork((await store.read()).networks, POLYGON.chainId)).toBeUndefined();
      expect((await store.read()).chainId).toBe(DEFAULT_CHAIN_ID);
    });

    it("refuses the active network without touching storage", async () => {
      const store = storeOn(countingArea());
      await store.upsert(POLYGON);
      await store.setActive(POLYGON.chainId);

      await expect(store.remove(POLYGON.chainId)).resolves.toEqual({
        ok: false,
        reason: "active",
      });
      expect(findNetwork((await store.read()).networks, POLYGON.chainId)).toBeDefined();
    });

    it("refuses a built-in", async () => {
      const store = storeOn(countingArea());
      await store.migrate();

      await expect(store.remove(SEPOLIA_CHAIN_ID)).resolves.toEqual({
        ok: false,
        reason: "built-in",
      });
    });
  });

  describe("fallbackIfUnusable", () => {
    const always = async () => true;
    const never = async () => false;

    /**
     * 🇪🇸 NOTA: el usuario quita el permiso desde `chrome://extensions` sin pasar
     * por la wallet. Si era el de la red activa, quedarse ahí deja una wallet
     * que no funciona y no dice por qué: las cuentas están, la red está en el
     * selector, y los saldos no llegan.
     */
    it("moves to the default network and announces it", async () => {
      const area = countingArea();
      const { store, emitted } = storeWithEmitter(area);
      await store.upsert(POLYGON);
      await store.setActive(POLYGON.chainId);
      // The arrange switched networks, which now announces on its own.
      emitted.length = 0;

      await expect(store.fallbackIfUnusable(never)).resolves.toBe(DEFAULT_CHAIN_ID);

      expect((await store.read()).chainId).toBe(DEFAULT_CHAIN_ID);
      expect(emitted).toEqual([
        { name: "chainChanged", data: DEFAULT_CHAIN_ID, changedOrigin: null },
      ]);
    });

    it("does nothing while the active network is still usable", async () => {
      const area = countingArea();
      const { store, emitted } = storeWithEmitter(area);
      await store.upsert(POLYGON);
      await store.setActive(POLYGON.chainId);
      emitted.length = 0;
      const writesBefore = area.writes;

      await expect(store.fallbackIfUnusable(always)).resolves.toBeNull();

      expect((await store.read()).chainId).toBe(POLYGON.chainId);
      expect(emitted).toEqual([]);
      expect(area.writes).toBe(writesBefore);
    });

    /**
     * 🇪🇸 NOTA: sin esta guarda, revocar cualquier permiso con Anvil activo
     * emitiría un `chainChanged` de Anvil a Anvil. Una dApp que reacciona
     * recargando lo haría por un cambio que no ha ocurrido.
     */
    it("says nothing when the default network is already the active one", async () => {
      const { store, emitted } = storeWithEmitter(countingArea());
      await store.migrate();

      await expect(store.fallbackIfUnusable(never)).resolves.toBeNull();
      expect(emitted).toEqual([]);
    });

    /**
     * ------------------------------------------------------------------------
     * IT FALLS BACK EVEN IF THE DEFAULT IS UNUSABLE TOO
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: comportamiento escrito, no deducido por descarte. Si el permiso
     * de Anvil también estuviera revocado, la wallet se mueve a Anvil
     * igualmente y NO se pone a buscar "alguna red que funcione".
     *
     * Buscar una usable sonaría mejor y es peor: dejaría al usuario en una red
     * que no eligió —la primera que pasara el filtro— y firmando en ella sin
     * haber hecho nada. Una wallet que se cambia sola de cadena es exactamente
     * lo que nadie quiere que haga una wallet.
     *
     * Caer al DEFAULT es predecible: siempre el mismo sitio, es una builtin que
     * no se puede borrar, y si tampoco es alcanzable el popup ya lo dice —
     * aparece en `unusableChainIds` y el selector lo marca. Queda una wallet que
     * no puede leer saldos y lo explica, en vez de una que te ha movido a una
     * red que no reconoces.
     *
     * En la práctica es un caso de esquina: Anvil está en `host_permissions`, y
     * la comprobación manual 57 midió que los hosts declarados salen concedidos.
     * Está escrito porque "no llega a pasar" no es lo mismo que "está definido".
     */
    it("moves to the default even when the default is unusable too", async () => {
      const area = countingArea();
      const { store, emitted } = storeWithEmitter(area);
      await store.upsert(POLYGON);
      await store.setActive(POLYGON.chainId);
      emitted.length = 0;

      await expect(store.fallbackIfUnusable(never)).resolves.toBe(DEFAULT_CHAIN_ID);

      expect((await store.read()).chainId).toBe(DEFAULT_CHAIN_ID);
      // The chain did change, so the dApps are told. Being unreachable is a
      // separate problem, and one the popup already surfaces.
      expect(emitted).toEqual([
        { name: "chainChanged", data: DEFAULT_CHAIN_ID, changedOrigin: null },
      ]);
    });

    it("only asks about the active network", async () => {
      const store = storeOn(countingArea());
      await store.upsert(POLYGON);
      await store.upsert(BASE);
      await store.setActive(POLYGON.chainId);

      const asked: string[] = [];
      await store.fallbackIfUnusable(async (entry) => {
        asked.push(entry.chainId);
        return true;
      });

      expect(asked).toEqual([POLYGON.chainId]);
    });
  });

  /**
   * ---------------------------------------------------------------------------
   * THE RACE. NO AWAIT BETWEEN THE CALLS
   * ---------------------------------------------------------------------------
   * 🇪🇸 NOTA: la lección de la Fase 6, y la razón de que estos tests se escriban
   * así. Un `await` entre las dos llamadas las serializaría ARTIFICIALMENTE y el
   * test pasaría con o sin cadena — probando un escenario que el navegador no
   * produce. `chrome.runtime.onMessage` despacha concurrente: dos dApps dando de
   * alta una red a la vez salen a la vez.
   *
   * Sin la cadena serializada de `network-store.ts`, las dos lecturas ven el
   * mismo catálogo y la segunda escritura se lleva por delante a la primera. El
   * síntoma no es un error: la red simplemente no está.
   */
  describe("concurrent writes", () => {
    it("keeps both networks when two are added at once", async () => {
      const store = storeOn(countingArea());
      await store.migrate();

      await Promise.all([store.upsert(POLYGON), store.upsert(BASE)]);

      const { networks } = await store.read();
      expect(findNetwork(networks, POLYGON.chainId)).toBeDefined();
      expect(findNetwork(networks, BASE.chainId)).toBeDefined();
    });

    it("does not resurrect a network removed while another was added", async () => {
      const store = storeOn(countingArea());
      await store.upsert(POLYGON);

      await Promise.all([store.remove(POLYGON.chainId), store.upsert(BASE)]);

      const { networks } = await store.read();
      expect(findNetwork(networks, POLYGON.chainId)).toBeUndefined();
      expect(findNetwork(networks, BASE.chainId)).toBeDefined();
    });

    /**
     * 🇪🇸 NOTA: se afirman los DOS efectos, no que el invariante se sostenga. Sin
     * cadena, una escritura pisa a la otra y se pierde uno de los dos — o el
     * cambio de red, o el alta— pero el catálogo resultante sigue conteniendo su
     * propia red activa en los dos casos. Una aserción sobre el invariante
     * pasaría con el bug delante, que es la peor clase de test.
     */
    it("keeps both the switch and the addition when they race", async () => {
      const store = storeOn(countingArea());
      await store.upsert(POLYGON);

      await Promise.all([store.setActive(POLYGON.chainId), store.upsert(BASE)]);

      const { networks, chainId } = await store.read();
      expect(chainId).toBe(POLYGON.chainId);
      expect(findNetwork(networks, BASE.chainId)).toBeDefined();
    });

    it("survives ten simultaneous additions", async () => {
      const store = storeOn(countingArea());
      await store.migrate();

      const many = Array.from({ length: 10 }, (_unused, index) =>
        network(`0x${(1000 + index).toString(16)}`, `https://rpc-${index}.example`),
      );

      await Promise.all(many.map((entry) => store.upsert(entry)));

      const { networks } = await store.read();
      for (const entry of many) {
        expect(findNetwork(networks, entry.chainId)).toBeDefined();
      }
    });
  });
});
