"use client";

import { useSyncExternalStore } from "react";

import { createProviderStore, type ProviderStore } from "@/lib/provider-store";
import type { EIP6963ProviderDetail } from "@/types/eip1193";

/**
 * The store is created lazily, and only in the browser.
 *
 * 🇪🇸 NOTA: durante el render en servidor no existe `window`. React resuelve
 * esto llamando a `getServerSnapshot` en el servidor y a `getSnapshot` en el
 * cliente, así que basta con que la creación del store viva DENTRO de esas
 * funciones: en el servidor no se llega a ejecutar nunca.
 */
let store: ProviderStore | null = null;

function ensureStore(): ProviderStore {
  store ??= createProviderStore(window);
  return store;
}

/**
 * 🇪🇸 NOTA: una constante de módulo, no un `[]` en línea. `useSyncExternalStore`
 * compara los snapshots con `Object.is`, así que un array literal nuevo en cada
 * llamada sería siempre distinto y provocaría un bucle de renders. Es el mismo
 * motivo por el que el store cachea el suyo.
 */
const NO_PROVIDERS: EIP6963ProviderDetail[] = [];

/**
 * 🇪🇸 NOTA: estas tres referencias son estables a nivel de módulo, y tienen que
 * serlo. Si `subscribe` fuera una flecha definida dentro del hook, React vería
 * una función distinta en cada render y volvería a suscribirse cada vez —
 * desmontando y remontando el listener de anuncios sin parar.
 */
const subscribe = (onStoreChange: () => void) => ensureStore().subscribe(onStoreChange);
const getSnapshot = () => ensureStore().getSnapshot();
const getServerSnapshot = () => NO_PROVIDERS;

/** Every wallet that has announced itself, in announcement order. */
export function useProviders(): EIP6963ProviderDetail[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Re-dispatches eip6963:requestProvider. Wired to the "look again" button. */
export function requestProviders(): void {
  ensureStore().requestProviders();
}
