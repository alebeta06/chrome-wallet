import { describe, expect, it, vi } from "vitest";

import type { ConnectedSite, TabEventMessage } from "@/types/messages";
import {
  createEventEmitter,
  isAddressableOrigin,
  originMatchPattern,
  type TabsPort,
} from "@/lib/events";
import type { ConnectedSites } from "@/lib/sites";

const VERCEL = "https://chrome-wallet.vercel.app";
const LOCAL = "http://localhost:3000";

function site(origin: string, accountIndex: number): ConnectedSite {
  return { origin, accountIndex, connectedAt: 0, lastUsedAt: 0 };
}

const TWO_SITES: ConnectedSites = {
  [VERCEL]: site(VERCEL, 3),
  [LOCAL]: site(LOCAL, 1),
};

/**
 * A fake browser: `tabsByOrigin` says which tabs each origin has open, and
 * `failing` is the set of tab ids with no content script listening.
 */
function fakeTabs(tabsByOrigin: Record<string, number[]>, failing: number[] = []) {
  const sent: Array<{ tabId: number; message: TabEventMessage }> = [];

  const port: TabsPort = {
    query: vi.fn(async ({ url }) => {
      const origin = url.replace(/\/\*$/, "");
      return (tabsByOrigin[origin] ?? []).map((id) => ({ id }));
    }),
    sendMessage: vi.fn(async (tabId, message) => {
      if (failing.includes(tabId)) {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      sent.push({ tabId, message });
      return undefined;
    }),
  };

  return { port, sent };
}

describe("originMatchPattern", () => {
  /**
   * 🇪🇸 NOTA: sin la barra y el comodín, `chrome.tabs.query` devuelve cero
   * pestañas EN SILENCIO. El evento no llega a nadie y no hay ningún error que
   * lo delate — el peor tipo de fallo.
   */
  it("builds a pattern chrome.tabs.query accepts", () => {
    expect(originMatchPattern(VERCEL)).toBe(`${VERCEL}/*`);
    expect(originMatchPattern(LOCAL)).toBe(`${LOCAL}/*`);
  });

  /** The wildcard covers the path, never the host. */
  it("does not turn into a host wildcard", () => {
    expect(originMatchPattern("https://dapp.example")).not.toContain(".evil");
    expect(originMatchPattern("https://dapp.example")).toBe("https://dapp.example/*");
  });
});

describe("isAddressableOrigin", () => {
  it.each([VERCEL, LOCAL, "http://127.0.0.1:8080"])("accepts %s", (origin) => {
    expect(isAddressableOrigin(origin)).toBe(true);
  });

  /**
   * 🇪🇸 NOTA: un iframe about:blank reporta el origen "null". Pasárselo a
   * `chrome.tabs.query` como "null/*" LANZA, en vez de devolver vacío.
   */
  it.each([
    ["an opaque origin", "null"],
    ["an extension page", "chrome-extension://abc"],
    ["a file", "file:///home/x/index.html"],
    ["nonsense", "unknown"],
  ])("rejects %s", (_label, origin) => {
    expect(isAddressableOrigin(origin)).toBe(false);
  });
});

describe("accountsChanged — an origin-scoped event", () => {
  /**
   * ------------------------------------------------------------------------
   * THE LEAK THIS MODULE EXISTS TO NOT HAVE
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: si accountsChanged llegara a todos los orígenes conectados, la
   * dApp B se enteraría de qué cuenta usas en la dApp A. Ése es exactamente el
   * fallo que el modelo por origen existe para evitar, y es invisible salvo que
   * se compruebe: todo seguiría funcionando, solo que filtrando.
   */
  it("reaches only the origin that changed", async () => {
    const { port, sent } = fakeTabs({ [VERCEL]: [1], [LOCAL]: [2] });
    const emit = createEventEmitter(port);

    await emit("accountsChanged", ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"], {
      changedOrigin: VERCEL,
      connectedSites: TWO_SITES,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].tabId).toBe(1);
    expect(port.query).toHaveBeenCalledTimes(1);
    expect(port.query).toHaveBeenCalledWith({ url: `${VERCEL}/*` });
  });

  /**
   * 🇪🇸 NOTA: esto lo vi en vivo probando la Fase 3 — `chrome.tabs.query`
   * devolvió dos pestañas de la misma dApp. Quedarse con `[0]` deja la otra
   * mostrando la cuenta vieja: la wallet dice una cosa y la web dice otra.
   */
  it("reaches every tab of that origin, not just the first", async () => {
    const { port, sent } = fakeTabs({ [VERCEL]: [1, 2, 3] });
    const emit = createEventEmitter(port);

    await emit("accountsChanged", [], { changedOrigin: VERCEL, connectedSites: TWO_SITES });

    expect(sent.map((entry) => entry.tabId).sort()).toEqual([1, 2, 3]);
  });

  /**
   * 🇪🇸 NOTA: una pestaña recién navegada, o abierta antes de instalar la
   * extensión, no tiene content script escuchando y `sendMessage` RECHAZA. Con
   * un solo try alrededor del bucle, la primera pestaña muerta se lleva por
   * delante la entrega a todas las demás.
   */
  it("keeps delivering when one tab has no content script", async () => {
    const { port, sent } = fakeTabs({ [VERCEL]: [1, 2, 3] }, [1]);
    const emit = createEventEmitter(port);

    await expect(
      emit("accountsChanged", [], { changedOrigin: VERCEL, connectedSites: TWO_SITES }),
    ).resolves.toBeUndefined();

    expect(sent.map((entry) => entry.tabId).sort()).toEqual([2, 3]);
  });

  it("stamps expectedOrigin so the content script can double-check", async () => {
    const { port, sent } = fakeTabs({ [VERCEL]: [1] });
    const emit = createEventEmitter(port);

    await emit("accountsChanged", [], { changedOrigin: VERCEL, connectedSites: TWO_SITES });

    expect(sent[0].message).toMatchObject({
      type: "CODECRYPTO_TAB_EVENT",
      eventName: "accountsChanged",
      expectedOrigin: VERCEL,
    });
  });

  it("sends nothing when the changed origin is not connected", async () => {
    const { port, sent } = fakeTabs({ "https://evil.example": [9] });
    const emit = createEventEmitter(port);

    await emit("accountsChanged", [], {
      changedOrigin: "https://evil.example",
      connectedSites: TWO_SITES,
    });

    expect(sent).toEqual([]);
    expect(port.query).not.toHaveBeenCalled();
  });

  it("sends nothing when the origin has no tabs open", async () => {
    const { port, sent } = fakeTabs({});
    const emit = createEventEmitter(port);

    await emit("accountsChanged", [], { changedOrigin: VERCEL, connectedSites: TWO_SITES });

    expect(sent).toEqual([]);
  });

  it("survives chrome.tabs.query throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const port: TabsPort = {
      query: vi.fn(async () => {
        throw new Error("tabs exploded");
      }),
      sendMessage: vi.fn(async () => undefined),
    };

    await expect(
      createEventEmitter(port)("accountsChanged", [], {
        changedOrigin: VERCEL,
        connectedSites: TWO_SITES,
      }),
    ).resolves.toBeUndefined();
    expect(port.sendMessage).not.toHaveBeenCalled();
  });
});

describe("chainChanged — a wallet-wide event", () => {
  /**
   * 🇪🇸 NOTA: la asimetría del modelo, y la razón de que los destinatarios los
   * decida `eventTargets` del contrato y no una lista escrita aquí. La RED es
   * una propiedad de la wallet, así que todo origen conectado se entera. La
   * CUENTA es una propiedad de la relación con un sitio concreto, así que solo
   * ese sitio se entera.
   */
  it("reaches every connected origin", async () => {
    const { port, sent } = fakeTabs({ [VERCEL]: [1], [LOCAL]: [2, 3] });
    const emit = createEventEmitter(port);

    await emit("chainChanged", "0xaa36a7", { changedOrigin: null, connectedSites: TWO_SITES });

    expect(sent.map((entry) => entry.tabId).sort()).toEqual([1, 2, 3]);
  });

  /** Global scope means every connected origin — not every open tab. */
  it("does not reach an origin that is not connected", async () => {
    const { port, sent } = fakeTabs({ [VERCEL]: [1], "https://evil.example": [9] });
    const emit = createEventEmitter(port);

    await emit("chainChanged", "0xaa36a7", { changedOrigin: null, connectedSites: TWO_SITES });

    expect(sent.map((entry) => entry.tabId)).not.toContain(9);
  });

  it("carries expectedOrigin per origin, not null", async () => {
    const { port, sent } = fakeTabs({ [VERCEL]: [1], [LOCAL]: [2] });
    const emit = createEventEmitter(port);

    await emit("chainChanged", "0xaa36a7", { changedOrigin: null, connectedSites: TWO_SITES });

    const byTab = new Map(sent.map((entry) => [entry.tabId, entry.message.expectedOrigin]));
    expect(byTab.get(1)).toBe(VERCEL);
    expect(byTab.get(2)).toBe(LOCAL);
  });

  it("sends nothing when no site is connected", async () => {
    const { port, sent } = fakeTabs({ [VERCEL]: [1] });
    const emit = createEventEmitter(port);

    await emit("chainChanged", "0xaa36a7", { changedOrigin: null, connectedSites: {} });

    expect(sent).toEqual([]);
  });
});

describe("origins that cannot be addressed", () => {
  it("skips an opaque origin instead of asking chrome for it", async () => {
    const { port, sent } = fakeTabs({});
    const emit = createEventEmitter(port);

    await emit("accountsChanged", [], {
      changedOrigin: "null",
      connectedSites: { null: site("null", 0) },
    });

    expect(port.query).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});

/**
 * ---------------------------------------------------------------------------
 * chainChanged: GLOBAL, SIN FILTRAR, Y A TODAS LAS PESTAÑAS
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: los dos tests de este bloque son los que la Fase 8 dejó en lugar del
 * escenario de Playwright, que se difiere a la Fase 10 (ver
 * `docs/e2e-backlog.md`). Lo que NO cubren es el tramo content-script → página;
 * lo que sí cubren es a quién se dirige el evento, que es donde vive la fuga.
 */
describe("chainChanged", () => {
  /**
   * ------------------------------------------------------------------------
   * DOS PESTAÑAS DEL MISMO ORIGEN
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: el caso se elige del mismo origen A PROPÓSITO. Con dos orígenes
   * distintos, un filtro por origen mal puesto pasaría el test igualmente,
   * porque cada uno recibiría el suyo. Con dos pestañas del mismo origen se caza
   * además el error clásico —quedarse con `tabs[0]`— y ése es exactamente el
   * fallo que deja una pestaña enseñando la red vieja mientras la otra ya
   * cambió: la wallet dice una cosa y la web dice otra.
   */
  it("reaches every tab of an origin, not just the first", async () => {
    const { port, sent } = fakeTabs({ [VERCEL]: [1, 2, 3] });
    const emit = createEventEmitter(port);

    await emit("chainChanged", "0xaa36a7", {
      changedOrigin: null,
      connectedSites: { [VERCEL]: site(VERCEL, 0) },
    });

    expect(sent.map((entry) => entry.tabId).sort()).toEqual([1, 2, 3]);
    for (const entry of sent) {
      expect(entry.message.eventName).toBe("chainChanged");
      expect(entry.message.data).toBe("0xaa36a7");
    }
  });

  /**
   * ------------------------------------------------------------------------
   * GLOBAL NO SIGNIFICA SIN CERRADURA
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: el contrato permite `expectedOrigin: null` y su comentario lo
   * describe como lo esperable para un evento global. El emisor pone el ORIGEN
   * igualmente, y eso es deliberado — los dos valores son legales y éste es el
   * estricto.
   *
   * El motivo es lo que pasa cuando una pestaña navega entre el
   * `chrome.tabs.query` y el `sendMessage`. Los tabId se reciclan y las pestañas
   * navegan; con `null`, el `chainChanged` aterriza en donde sea que esté ahora
   * esa pestaña — incluido un sitio NO conectado, que se enteraría de que existe
   * una wallet y de en qué red está sin haber pedido permiso a nadie. Es la
   * misma fuga que `eth_accounts` evita devolviendo `[]` a los desconocidos, en
   * pequeño.
   *
   * El precio es un falso negativo diminuto: una pestaña que navegue de una dApp
   * conectada a otra en esa ventana de milisegundos puede perderse ese evento y
   * quedarse con la red vieja hasta que recargue. Se prefiere no contarle nada a
   * un desconocido antes que no perder nunca un evento.
   *
   * El alcance —quién recibe— lo decide `eventTargets` del contrato y lo fija el
   * test de abajo. Esto es la segunda cerradura, y es independiente.
   */
  it("keeps the per-tab origin lock even for a global event", async () => {
    const { port, sent } = fakeTabs({ [VERCEL]: [1], [LOCAL]: [2] });
    const emit = createEventEmitter(port);

    await emit("chainChanged", "0xaa36a7", {
      changedOrigin: null,
      connectedSites: TWO_SITES,
    });

    expect(sent).toHaveLength(2);
    expect(sent.find((entry) => entry.tabId === 1)?.message.expectedOrigin).toBe(VERCEL);
    expect(sent.find((entry) => entry.tabId === 2)?.message.expectedOrigin).toBe(LOCAL);
  });

  /**
   * ------------------------------------------------------------------------
   * EL NEGATIVO DE CONTRASTE: LA ASIMETRÍA, LADO A LADO
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: éste es el test que define el modelo B desde el lado de los
   * eventos, y por eso las dos mitades van juntas en el mismo test en vez de en
   * dos: lo que importa no es cada una, es que sean DISTINTAS.
   *
   * La red es una propiedad de la wallet → la oyen todos.
   * La cuenta es una propiedad de la relación wallet-sitio → la oye uno solo.
   *
   * Si `accountsChanged` empezara a llegar a todos, la dApp A se enteraría de
   * qué cuenta usas en la dApp B. Y si `chainChanged` empezara a filtrarse por
   * origen, la mitad de tus pestañas se quedaría en la red anterior.
   *
   * El complemento de esto —que un cambio de red no EMITE `accountsChanged` en
   * absoluto— se fija en `network-rpc.test.ts`, sobre el handler.
   */
  it("goes everywhere, unlike accountsChanged", async () => {
    const { port, sent } = fakeTabs({ [VERCEL]: [1], [LOCAL]: [2] });
    const emit = createEventEmitter(port);

    await emit("chainChanged", "0xaa36a7", {
      changedOrigin: null,
      connectedSites: TWO_SITES,
    });
    const heardTheChain = sent.map((entry) => entry.tabId).sort();

    sent.length = 0;

    await emit("accountsChanged", ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"], {
      changedOrigin: VERCEL,
      connectedSites: TWO_SITES,
    });
    const heardTheAccount = sent.map((entry) => entry.tabId).sort();

    expect(heardTheChain).toEqual([1, 2]);
    expect(heardTheAccount).toEqual([1]);
  });
});
