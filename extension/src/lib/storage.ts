/**
 * @file lib/storage.ts
 * @description Typed access to chrome.storage.local, driven by StorageSchema.
 *
 * The area is injected rather than imported, which is what lets the tests run a
 * real implementation against an in-memory double instead of stubbing globals.
 */

import { RESET_CLEARED_KEYS, type StorageKey, type StorageSchema } from "@/types/messages";

/**
 * The only three things we use from chrome.storage.local.
 *
 * 🇪🇸 NOTA: declarar la superficie mínima en vez de depender del tipo completo
 * de Chrome es lo que hace que el doble de los tests sea un objeto de quince
 * líneas y no un mock de toda la API de storage.
 */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface WalletStorage {
  get<K extends StorageKey>(key: K): Promise<StorageSchema[K] | undefined>;
  set<K extends StorageKey>(key: K, value: StorageSchema[K]): Promise<void>;
  /** One write for several keys — fewer round trips and no half-written state. */
  setMany(items: Partial<StorageSchema>): Promise<void>;
  remove(keys: StorageKey | StorageKey[]): Promise<void>;
  /** Clears exactly RESET_CLEARED_KEYS. Logs and provider uuid survive. */
  resetWallet(): Promise<void>;
}

/**
 * @param area defaults to chrome.storage.local, resolved at call time so that
 *             importing this module outside a extension context is harmless.
 */
export function createWalletStorage(area: StorageArea = chrome.storage.local): WalletStorage {
  return {
    async get<K extends StorageKey>(key: K): Promise<StorageSchema[K] | undefined> {
      const items = await area.get([key]);
      return items[key] as StorageSchema[K] | undefined;
    },

    async set<K extends StorageKey>(key: K, value: StorageSchema[K]): Promise<void> {
      await area.set({ [key]: value });
    },

    async setMany(items: Partial<StorageSchema>): Promise<void> {
      await area.set(items as Record<string, unknown>);
    },

    async remove(keys: StorageKey | StorageKey[]): Promise<void> {
      await area.remove(Array.isArray(keys) ? keys : [keys]);
    },

    /**
     * 🇪🇸 NOTA: la lista viene de messages.ts, no se reescribe aquí. Si mañana
     * el contrato añade una clave que un reset debe borrar, este método la borra
     * sin que nadie lo toque. Una segunda lista es una segunda lista que se
     * olvida de actualizar.
     */
    async resetWallet(): Promise<void> {
      await area.remove([...RESET_CLEARED_KEYS]);
    },
  };
}
