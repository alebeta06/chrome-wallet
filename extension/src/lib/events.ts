/**
 * @file lib/events.ts
 * @description Delivering provider events to the right tabs, and only those.
 *
 * The `chrome.tabs` surface is injected rather than imported, so the whole
 * targeting decision — who hears an event and who does not — can be tested
 * without a browser. That matters more here than anywhere else in the codebase:
 * the failure mode is not a crash, it is dApp B quietly learning which account
 * you use on dApp A.
 */

import {
  eventTargets,
  type Origin,
  type ProviderEventMap,
  type ProviderEventName,
  type TabEventMessage,
} from "@/types/messages";

import type { ConnectedSites } from "./sites";

/** The two things this module uses from chrome.tabs. */
export interface TabsPort {
  query(queryInfo: { url: string }): Promise<{ id?: number }[]>;
  sendMessage(tabId: number, message: TabEventMessage): Promise<unknown>;
}

export interface EmitOptions {
  /** Which origin changed. null for wallet-wide events like chainChanged. */
  changedOrigin: Origin | null;
  connectedSites: ConnectedSites;
}

export type EventEmitter = <E extends ProviderEventName>(
  eventName: E,
  data: ProviderEventMap[E],
  options: EmitOptions,
) => Promise<void>;

/**
 * `chrome.tabs.query` wants a match pattern, not an origin.
 *
 * 🇪🇸 NOTA: `"https://dapp.example"` no es un patrón válido y devolvería cero
 * pestañas en silencio — el evento simplemente no llegaría a nadie y no habría
 * ningún error que lo delatara. Hace falta la barra y el comodín.
 *
 * El comodín cubre la RUTA, no el host: `https://dapp.example/*` casa con
 * `/app` y con `/settings`, y NO casa con `https://dapp.example.evil.com`. Eso
 * es lo que mantiene la entrega dentro del origen.
 */
export function originMatchPattern(origin: Origin): string {
  return `${origin}/*`;
}

/**
 * 🇪🇸 NOTA: un origen opaco no es direccionable. Un iframe `about:blank` reporta
 * `location.origin === "null"`, y `chrome.tabs.query({ url: "null/*" })` lanza
 * en vez de devolver vacío. Se filtra antes de preguntar.
 */
export function isAddressableOrigin(origin: Origin): boolean {
  return origin.startsWith("http://") || origin.startsWith("https://");
}

export function createEventEmitter(tabs: TabsPort): EventEmitter {
  return async function emit(eventName, data, { changedOrigin, connectedSites }) {
    /**
     * 🇪🇸 NOTA: los destinatarios los decide `eventTargets` del CONTRATO, no una
     * lista escrita aquí. Ahí es donde vive la asimetría del modelo:
     * accountsChanged va solo al origen afectado, chainChanged va a todos. Si
     * esa regla se reimplementara en este archivo, habría dos fuentes de verdad
     * y la de aquí se olvidaría de actualizar.
     */
    const targets = eventTargets(eventName, connectedSites, changedOrigin);

    await Promise.all(
      targets.filter(isAddressableOrigin).map((origin) => deliverToOrigin(tabs, origin, eventName, data)),
    );
  };
}

async function deliverToOrigin<E extends ProviderEventName>(
  tabs: TabsPort,
  origin: Origin,
  eventName: E,
  data: ProviderEventMap[E],
): Promise<void> {
  const message: TabEventMessage<E> = {
    type: "CODECRYPTO_TAB_EVENT",
    eventName,
    data,
    // The second lock. The content script drops anything that does not match
    // its own location.origin — tab ids get recycled and tabs navigate.
    expectedOrigin: origin,
  };

  let openTabs: { id?: number }[];

  try {
    openTabs = await tabs.query({ url: originMatchPattern(origin) });
  } catch (cause) {
    console.error(`[codecrypto] could not list tabs for ${origin}:`, cause);
    return;
  }

  /**
   * ------------------------------------------------------------------------
   * EVERY TAB, AND EACH ONE ISOLATED
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: dos cosas que se ven en cuanto pruebas esto de verdad.
   *
   * TODAS las pestañas, no `openTabs[0]`. Es normal tener la misma dApp abierta
   * dos veces, y quedarse con la primera deja a la otra mostrando la cuenta
   * vieja — una wallet que dice una cosa y una web que dice otra.
   *
   * Y cada envío en su propio try/catch. Una pestaña puede no tener content
   * script escuchando: recién navegada, o abierta antes de instalar la
   * extensión. Ahí `sendMessage` RECHAZA. Con un solo try alrededor del bucle,
   * la primera pestaña muerta se lleva por delante la entrega a todas las
   * demás.
   */
  await Promise.all(
    openTabs.map(async (tab) => {
      if (tab.id === undefined) return;

      try {
        await tabs.sendMessage(tab.id, message);
      } catch {
        // Expected and harmless: nobody is listening in that tab.
      }
    }),
  );
}
