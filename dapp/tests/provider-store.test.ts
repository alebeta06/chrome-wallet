import { describe, expect, it, vi } from "vitest";

import { createProviderStore } from "@/lib/provider-store";
import {
  EIP6963_ANNOUNCE,
  EIP6963_REQUEST,
  type EIP6963ProviderDetail,
} from "@/types/eip1193";

/**
 * 🇪🇸 NOTA: todo esto corre en Node, sin jsdom y sin navegador, porque
 * `createProviderStore` recibe el `EventTarget` por parámetro en vez de leer
 * `window`. Node trae `EventTarget` y `CustomEvent` como globales, así que el
 * handshake de EIP-6963 se prueba con eventos DE VERDAD — no con un mock del
 * mecanismo que se quiere comprobar.
 */

function detail(rdns: string, overrides: Partial<EIP6963ProviderDetail["info"]> = {}) {
  return {
    info: {
      uuid: `uuid-${rdns}`,
      name: rdns,
      icon: "data:image/svg+xml,<svg/>",
      rdns,
      ...overrides,
    },
    provider: { request: async () => null, on: () => {}, removeListener: () => {} },
  };
}

function announce(target: EventTarget, value: unknown): void {
  target.dispatchEvent(new CustomEvent(EIP6963_ANNOUNCE, { detail: value }));
}

/** A store that is already subscribed, as it would be under React. */
function liveStore() {
  const target = new EventTarget();
  const store = createProviderStore(target);
  const onChange = vi.fn();
  const unsubscribe = store.subscribe(onChange);
  return { target, store, onChange, unsubscribe };
}

describe("discovery", () => {
  it("starts empty", () => {
    const target = new EventTarget();

    expect(createProviderStore(target).getSnapshot()).toEqual([]);
  });

  it("collects an announced wallet", () => {
    const { target, store } = liveStore();

    announce(target, detail("academy.codecrypto.wallet"));

    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0].info.rdns).toBe("academy.codecrypto.wallet");
  });

  it("collects several wallets in announcement order", () => {
    const { target, store } = liveStore();

    announce(target, detail("io.metamask"));
    announce(target, detail("academy.codecrypto.wallet"));
    announce(target, detail("com.brave.wallet"));

    expect(store.getSnapshot().map((entry) => entry.info.rdns)).toEqual([
      "io.metamask",
      "academy.codecrypto.wallet",
      "com.brave.wallet",
    ]);
  });

  it("notifies React on every new wallet", () => {
    const { target, onChange } = liveStore();

    announce(target, detail("io.metamask"));
    announce(target, detail("academy.codecrypto.wallet"));

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("stops notifying after unsubscribe", () => {
    const { target, onChange, unsubscribe } = liveStore();

    unsubscribe();
    announce(target, detail("io.metamask"));

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("the announcement handshake", () => {
  /**
   * 🇪🇸 NOTA: escuchar ANTES de preguntar. Por eso el listener de `announce` se
   * registra al CREAR el store y no al suscribirse: una wallet que conteste de
   * forma síncrona al `requestProvider` emitiría su anuncio dentro del mismo
   * `dispatchEvent`, y si el listener se registrara después ya sería tarde.
   */
  it("catches a wallet that answers synchronously", () => {
    const target = new EventTarget();
    const store = createProviderStore(target);

    // A wallet that announces the instant it is asked.
    target.addEventListener(EIP6963_REQUEST, () => {
      announce(target, detail("academy.codecrypto.wallet"));
    });

    store.subscribe(() => {});

    expect(store.getSnapshot()).toHaveLength(1);
  });

  it("asks on first subscribe", () => {
    const target = new EventTarget();
    const store = createProviderStore(target);
    const asked = vi.fn();
    target.addEventListener(EIP6963_REQUEST, asked);

    store.subscribe(() => {});

    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("asks again on demand", () => {
    const { target, store } = liveStore();
    const asked = vi.fn();
    target.addEventListener(EIP6963_REQUEST, asked);

    store.requestProviders();
    store.requestProviders();

    expect(asked).toHaveBeenCalledTimes(2);
  });
});

describe("deduplication", () => {
  /**
   * 🇪🇸 NOTA: el doble anuncio es el comportamiento CORRECTO de una wallet —
   * anuncia al cargar y otra vez en cada requestProvider. Sin deduplicar, cada
   * pulsación del botón de redescubrir añadiría una tarjeta repetida.
   */
  it("keeps one entry when the same wallet announces twice", () => {
    const { target, store } = liveStore();

    announce(target, detail("io.metamask"));
    announce(target, detail("io.metamask"));

    expect(store.getSnapshot()).toHaveLength(1);
  });

  it("does not wake React up for a repeated announcement", () => {
    const { target, onChange } = liveStore();

    announce(target, detail("io.metamask"));
    announce(target, detail("io.metamask"));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  /**
   * 🇪🇸 NOTA: se compara el CONTENIDO, no solo el rdns. Un uuid distinto en un
   * reanuncio es exactamente el síntoma de un uuid que no es estable por
   * instalación, y esta página es donde se comprueba a ojo: si el store lo
   * ignorara, el bug quedaría invisible.
   */
  it("surfaces a wallet that re-announces with a different uuid", () => {
    const { target, store, onChange } = liveStore();

    announce(target, detail("io.metamask", { uuid: "first" }));
    announce(target, detail("io.metamask", { uuid: "second" }));

    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0].info.uuid).toBe("second");
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("the cached snapshot", () => {
  /**
   * ------------------------------------------------------------------------
   * THE useSyncExternalStore FOOTGUN
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: React compara los snapshots con `Object.is` en cada render. Si
   * `getSnapshot` devolviera un array nuevo cada vez, React lo vería siempre
   * distinto y el componente entraría en un bucle infinito de renders con la
   * pestaña colgada. Este test es barato y es lo único que separa "funciona" de
   * "cuelga el navegador".
   */
  it("returns the very same array reference until something changes", () => {
    const { target, store } = liveStore();
    announce(target, detail("io.metamask"));

    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("returns a new reference once a wallet is added", () => {
    const { target, store } = liveStore();
    announce(target, detail("io.metamask"));
    const before = store.getSnapshot();

    announce(target, detail("academy.codecrypto.wallet"));

    expect(store.getSnapshot()).not.toBe(before);
  });

  it("keeps the reference stable across a duplicate announcement", () => {
    const { target, store } = liveStore();
    announce(target, detail("io.metamask"));
    const before = store.getSnapshot();

    announce(target, detail("io.metamask"));

    expect(store.getSnapshot()).toBe(before);
  });
});

describe("malformed announcements", () => {
  /**
   * 🇪🇸 NOTA: cualquier script de la página puede disparar un anuncio. Esto no
   * es una frontera de seguridad —la de verdad está dentro de la extensión—
   * pero un detail mal formado no puede tumbar la página ni pintar una tarjeta
   * con `undefined` dentro.
   */
  const GOOD_INFO = { uuid: "u", name: "n", icon: "i", rdns: "r" };
  const stub = () => ({ request: async (): Promise<null> => null });

  /**
   * Typed as `unknown` on purpose: these are deliberately malformed values, so
   * letting TypeScript try to unify them into one shape would be describing
   * something the test is specifically about NOT being well shaped.
   */
  const MALFORMED: Array<[string, unknown]> = [
    ["no detail at all", undefined],
    ["null", null],
    ["a string", "io.metamask"],
    ["no provider", { info: GOOD_INFO }],
    ["no info", { provider: stub() }],
    ["a provider without request()", { info: GOOD_INFO, provider: {} }],
    ["an empty rdns", { info: { ...GOOD_INFO, rdns: "" }, provider: stub() }],
    ["a numeric name", { info: { ...GOOD_INFO, name: 42 }, provider: stub() }],
    ["a missing uuid", { info: { name: "n", icon: "i", rdns: "r" }, provider: stub() }],
  ];

  it.each(MALFORMED)("ignores %s", (_label, value) => {
    const { target, store, onChange } = liveStore();

    expect(() => announce(target, value)).not.toThrow();
    expect(store.getSnapshot()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  /** The control: proves the rejections above are not just an inert store. */
  it("(control) accepts a well-formed announcement", () => {
    const { target, store } = liveStore();

    announce(target, detail("io.metamask"));

    expect(store.getSnapshot()).toHaveLength(1);
  });
});
