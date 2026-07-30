import type { StorageArea } from "@/lib/storage";

export interface MemoryStorageArea extends StorageArea {
  /** Everything currently stored, as a copy. For assertions only. */
  snapshot(): Record<string, unknown>;
  /** Keys currently present, sorted. */
  keys(): string[];
}

/**
 * An in-memory stand-in for chrome.storage.local.
 *
 * 🇪🇸 NOTA: el `structuredClone` de entrada y de salida no es celo excesivo, es
 * fidelidad. chrome.storage serializa de verdad: lo que guardas y lo que lees
 * son objetos distintos. Un doble que devolviera la misma referencia dejaría
 * pasar un test como "leo cc:accounts, le hago push, y ya está guardado", que en
 * Chrome no guarda nada. El doble tiene que ser tan poco cooperativo como la
 * API real.
 */
export function createMemoryStorageArea(seed: Record<string, unknown> = {}): MemoryStorageArea {
  const store = new Map<string, unknown>(
    Object.entries(seed).map(([key, value]) => [key, structuredClone(value)]),
  );

  return {
    async get(keys: string[]): Promise<Record<string, unknown>> {
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (store.has(key)) result[key] = structuredClone(store.get(key));
      }
      return result;
    },

    async set(items: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, structuredClone(value));
      }
    },

    async remove(keys: string[]): Promise<void> {
      for (const key of keys) store.delete(key);
    },

    snapshot(): Record<string, unknown> {
      return structuredClone(Object.fromEntries(store));
    },

    keys(): string[] {
      return [...store.keys()].sort();
    },
  };
}
