/**
 * @file lib/provider-store.ts
 * @description EIP-6963 discovery, as an external store React can subscribe to.
 *
 * The `EventTarget` is a parameter and not `window`, which is the whole reason
 * the discovery handshake can be tested in Node: a test creates a plain
 * `EventTarget`, dispatches real announcements at it, and asserts what comes
 * out. No jsdom, no browser.
 */

import {
  EIP6963_ANNOUNCE,
  EIP6963_REQUEST,
  type EIP6963ProviderDetail,
} from "@/types/eip1193";

export interface ProviderStore {
  /** React calls this on mount. Returns the unsubscribe function. */
  subscribe(onStoreChange: () => void): () => void;
  getSnapshot(): EIP6963ProviderDetail[];
  /** Re-asks every wallet to announce itself. Wired to a button. */
  requestProviders(): void;
}

/**
 * Announcements are attacker-adjacent data: any script on the page can dispatch
 * one. Nothing here is a security boundary — the real one is inside the
 * extension — but a malformed detail must not crash the page or render an
 * entry with `undefined` in it.
 */
function isUsableDetail(value: unknown): value is EIP6963ProviderDetail {
  if (typeof value !== "object" || value === null) return false;

  const { info, provider } = value as Partial<EIP6963ProviderDetail>;

  if (typeof provider !== "object" || provider === null) return false;
  if (typeof provider.request !== "function") return false;
  if (typeof info !== "object" || info === null) return false;

  return (
    typeof info.uuid === "string" &&
    typeof info.name === "string" &&
    typeof info.icon === "string" &&
    typeof info.rdns === "string" &&
    info.rdns.length > 0
  );
}

/**
 * Everything that would make a rendered card look different.
 *
 * ---------------------------------------------------------------------------
 * THE `provider` REFERENCE IS DELIBERATELY NOT COMPARED
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: nada en EIP-6963 obliga a una wallet a reanunciar el MISMO objeto
 * provider. Si se comparara la referencia, una wallet que envuelva el suyo en
 * cada anuncio haría que el store publicase de nuevo en cada
 * `requestProvider` — y eso no es solo churn de renders: `useProviderEvents`
 * depende de la identidad de `provider`, así que se resuscribiría y BORRARÍA el
 * registro de eventos. Pulsar "redescubrir" vaciaría el panel, que es
 * exactamente lo contrario de lo que espera quien lo pulsa.
 *
 * Consecuencia asumida: si una wallet cambiara su provider manteniendo el info
 * idéntico, nos quedaríamos con el primero. Para eso tendría que anunciar dos
 * implementaciones distintas bajo la misma identidad, que sería un bug suyo.
 */
function sameInfo(a: EIP6963ProviderDetail, b: EIP6963ProviderDetail): boolean {
  return (
    a.info.uuid === b.info.uuid &&
    a.info.name === b.info.name &&
    a.info.icon === b.info.icon
  );
}

export function createProviderStore(target: EventTarget): ProviderStore {
  /** Keyed by rdns: the stable identity of a wallet across announcements. */
  const byRdns = new Map<string, EIP6963ProviderDetail>();
  const listeners = new Set<() => void>();

  /**
   * ------------------------------------------------------------------------
   * THE CACHED SNAPSHOT IS NOT AN OPTIMISATION
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: `useSyncExternalStore` compara el resultado de `getSnapshot()` con
   * `Object.is` en cada render. Si esto hiciera `return [...byRdns.values()]`,
   * devolvería un array nuevo cada vez, React lo vería siempre distinto, y el
   * componente entraría en un bucle infinito de renders — con un error de
   * "getSnapshot should be cached" en consola y la pestaña colgada. El array
   * SOLO se reconstruye cuando el Map cambia de verdad.
   */
  let snapshot: EIP6963ProviderDetail[] = [];

  function publish(): void {
    snapshot = [...byRdns.values()];
    for (const listener of listeners) listener();
  }

  function onAnnounce(event: Event): void {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isUsableDetail(detail)) return;

    const known = byRdns.get(detail.info.rdns);

    /**
     * 🇪🇸 NOTA: hay que deduplicar porque el doble anuncio de EIP-6963 es el
     * comportamiento CORRECTO de una wallet: anuncia al cargar y otra vez en
     * cada `requestProvider`. Sin esto, cada pulsación del botón de redescubrir
     * añadiría una tarjeta duplicada de la misma wallet.
     *
     * Se compara el contenido y no solo la clave: si una wallet reanuncia con
     * un uuid distinto, eso SÍ hay que mostrarlo. Es exactamente el síntoma de
     * un uuid que no es estable por instalación, y esta página es donde se
     * comprueba.
     */
    if (known !== undefined && sameInfo(known, detail)) return;

    byRdns.set(detail.info.rdns, detail);
    publish();
  }

  target.addEventListener(EIP6963_ANNOUNCE, onAnnounce);

  function requestProviders(): void {
    target.dispatchEvent(new Event(EIP6963_REQUEST));
  }

  return {
    subscribe(onStoreChange) {
      listeners.add(onStoreChange);

      /**
       * 🇪🇸 NOTA: escuchar ANTES de preguntar, y por eso el listener de
       * `announce` se registra al crear el store y no aquí. Al revés se pierde
       * el anuncio de las wallets que responden de forma síncrona, que es
       * justamente el bug que la doble vía de EIP-6963 existe para evitar.
       */
      requestProviders();

      return () => {
        listeners.delete(onStoreChange);
      };
    },

    getSnapshot() {
      return snapshot;
    },

    requestProviders,
  };
}
