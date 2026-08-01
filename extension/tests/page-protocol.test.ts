import { describe, expect, it, vi } from "vitest";

import {
  PROTOCOL,
  PROTOCOL_VERSION,
  PROVIDER_NAME,
  PROVIDER_RDNS,
  ErrorCode,
} from "@/types/messages";

import {
  InjectedProviderError,
  buildProviderInfo,
  isTrustedPageMessage,
  isWellFormedPageRequest,
  notifyListeners,
  pageEvent,
  pageFailure,
  pageRequest,
  pageSuccess,
  shouldDeliverTabEvent,
  toInjectedError,
} from "@/lib/page-protocol";

/**
 * 🇪🇸 NOTA: todo este archivo corre en Node, sin DOM y sin navegador. Es posible
 * porque `page-protocol.ts` recibe el `source` y el `self` como argumentos en
 * vez de leer `window` por su cuenta. Esa decisión de diseño es lo único que
 * separa "el guard está probado" de "el guard se revisó a ojo una vez".
 *
 * Lo que NO se puede probar aquí es el circuito completo página →
 * content-script → background → página: necesita los dos mundos de JavaScript de
 * Chrome, que jsdom no modela. Eso es Playwright, en la Fase 10.
 */

/** The window object, as far as these tests are concerned. */
const SELF = { name: "the page window" };

function envelope(type: string, extra: Record<string, unknown> = {}): unknown {
  return { __codecrypto: PROTOCOL, v: PROTOCOL_VERSION, type, ...extra };
}

describe("isTrustedPageMessage", () => {
  it("accepts our own protocol message of the expected type", () => {
    const event = { source: SELF, data: envelope("CODECRYPTO_RESPONSE") };

    expect(isTrustedPageMessage(event, SELF, "CODECRYPTO_RESPONSE")).toBe(true);
  });

  /**
   * ------------------------------------------------------------------------
   * THE CHECK THAT ACTUALLY MATTERS
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: sin `source === self`, un iframe hostil dentro de la página puede
   * hacer `parent.postMessage` con una CODECRYPTO_RESPONSE perfectamente
   * formada, el id de una petición en vuelo y `ok: true`. La dApp se creería que
   * una transacción se firmó. El marcador de protocolo no protege de esto: es
   * público y se lee del propio bus.
   */
  it("rejects a message that another frame put on the bus", () => {
    const hostileFrame = { name: "an iframe" };
    const event = { source: hostileFrame, data: envelope("CODECRYPTO_RESPONSE") };

    expect(isTrustedPageMessage(event, SELF, "CODECRYPTO_RESPONSE")).toBe(false);
  });

  it.each([
    ["no marker at all", { type: "CODECRYPTO_RESPONSE" }],
    ["a foreign marker", { __codecrypto: "metamask", v: PROTOCOL_VERSION, type: "CODECRYPTO_RESPONSE" }],
    ["a different protocol version", { __codecrypto: PROTOCOL, v: 99, type: "CODECRYPTO_RESPONSE" }],
    ["a string instead of an object", "CODECRYPTO_RESPONSE"],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, data) => {
    expect(isTrustedPageMessage({ source: SELF, data }, SELF, "CODECRYPTO_RESPONSE")).toBe(false);
  });

  /**
   * 🇪🇸 NOTA: los dos extremos del puente escuchan el MISMO bus. Sin el filtro
   * por `type`, el content script trataría como petición la respuesta que él
   * mismo acaba de publicar, y se reenviaría al background en un bucle.
   */
  it("rejects a message of the wrong type, even if it is ours", () => {
    const event = { source: SELF, data: envelope("CODECRYPTO_REQUEST") };

    expect(isTrustedPageMessage(event, SELF, "CODECRYPTO_RESPONSE")).toBe(false);
  });
});

describe("isWellFormedPageRequest", () => {
  it("accepts a request built by the provider", () => {
    expect(isWellFormedPageRequest(pageRequest("id-1", "eth_chainId", []))).toBe(true);
  });

  /**
   * 🇪🇸 NOTA: el `request()` de inject.ts valida sus argumentos, pero una página
   * puede saltárselo y hacer `window.postMessage` a mano con el marcador
   * correcto. Sin este guard, un `params` que no sea array llega al background y
   * vuelve como un -32603 opaco cuando la respuesta honesta era -32602.
   */
  it.each([
    ["a missing id", { method: "eth_chainId", params: [] }],
    ["an empty id", { id: "", method: "eth_chainId", params: [] }],
    ["a numeric id", { id: 7, method: "eth_chainId", params: [] }],
    ["a missing method", { id: "id-1", params: [] }],
    ["an empty method", { id: "id-1", method: "", params: [] }],
    ["params that are not an array", { id: "id-1", method: "eth_chainId", params: null }],
    ["an object as params", { id: "id-1", method: "eth_chainId", params: { from: "0x0" } }],
  ])("rejects %s", (_label, data) => {
    expect(isWellFormedPageRequest(data)).toBe(false);
  });
});

describe("toInjectedError", () => {
  /**
   * 🇪🇸 NOTA: tiene que ser un Error DE VERDAD con `.code`. Es exactamente lo
   * que ethers y wagmi inspeccionan para distinguir "el usuario canceló" (4001)
   * de "esto ha petado" (-32603). Rechazar la promesa con el objeto plano tal
   * cual rompe el manejo de errores de la dApp.
   */
  it("rebuilds a real Error carrying the code", () => {
    const error = toInjectedError({ code: ErrorCode.USER_REJECTED, message: "User rejected the request." });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(InjectedProviderError);
    expect(error.code).toBe(ErrorCode.USER_REJECTED);
    expect(error.message).toBe("User rejected the request.");
  });

  it("carries the optional data through", () => {
    const error = toInjectedError({ code: ErrorCode.INTERNAL, message: "boom", data: { detail: 42 } });

    expect(error.data).toEqual({ detail: 42 });
  });

  it("leaves data undefined when there was none", () => {
    expect(toInjectedError({ code: ErrorCode.INTERNAL, message: "boom" }).data).toBeUndefined();
  });
});

describe("shouldDeliverTabEvent", () => {
  /**
   * 🇪🇸 NOTA: el segundo cerrojo contra el reciclado de tabId. Si la pestaña
   * navega de la dApp A a la dApp B entre el `chrome.tabs.query` y el
   * `sendMessage`, el evento aterriza en el sitio equivocado y le filtra a B qué
   * cuenta usas en A.
   */
  it("delivers an origin-scoped event only to that origin", () => {
    expect(shouldDeliverTabEvent("https://dapp.example", "https://dapp.example")).toBe(true);
    expect(shouldDeliverTabEvent("https://dapp.example", "https://evil.example")).toBe(false);
  });

  /** chainChanged is wallet-wide: every connected origin may see it. */
  it("delivers a global event anywhere", () => {
    expect(shouldDeliverTabEvent(null, "https://dapp.example")).toBe(true);
    expect(shouldDeliverTabEvent(null, "null")).toBe(true);
  });

  /**
   * An about:blank frame reports the string "null" as its origin, which matches
   * no real origin — so it sees global events and no per-origin ones.
   */
  it("does not match an opaque origin against a real one", () => {
    expect(shouldDeliverTabEvent("https://dapp.example", "null")).toBe(false);
  });

  it("does not match on a prefix", () => {
    expect(shouldDeliverTabEvent("https://dapp.example", "https://dapp.example.evil.com")).toBe(false);
  });
});

describe("the envelopes", () => {
  it("stamps every outgoing message with the protocol marker", () => {
    const messages = [
      pageRequest("id-1", "eth_chainId", []),
      pageSuccess("id-1", "0x7a69"),
      pageFailure("id-1", { code: ErrorCode.INTERNAL, message: "boom" }),
      pageEvent("chainChanged", "0x7a69"),
    ];

    for (const message of messages) {
      expect(message.__codecrypto).toBe(PROTOCOL);
      expect(message.v).toBe(PROTOCOL_VERSION);
    }
  });

  it("round-trips through isTrustedPageMessage", () => {
    const request = pageRequest("id-1", "eth_chainId", []);

    expect(isTrustedPageMessage({ source: SELF, data: request }, SELF, "CODECRYPTO_REQUEST")).toBe(true);
  });

  it("keeps success and failure distinguishable", () => {
    const ok = pageSuccess("id-1", "0x7a69");
    const bad = pageFailure("id-1", { code: ErrorCode.UNSUPPORTED_METHOD, message: "nope" });

    expect(ok.ok).toBe(true);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("expected a failure envelope");
    expect(bad.error.code).toBe(ErrorCode.UNSUPPORTED_METHOD);
  });
});

describe("buildProviderInfo", () => {
  it("uses the identity from the contract, not a local copy", () => {
    const info = buildProviderInfo("11111111-2222-3333-4444-555555555555");

    expect(info.uuid).toBe("11111111-2222-3333-4444-555555555555");
    expect(info.name).toBe(PROVIDER_NAME);
    expect(info.rdns).toBe(PROVIDER_RDNS);
  });

  /**
   * 🇪🇸 NOTA: los selectores multi-wallet meten esto en un <img>. Una cadena
   * inventada no falla en ningún test de tipos y se ve como un icono roto en la
   * única pantalla donde el usuario elige la wallet.
   */
  it("hands out a real, decodable SVG data URI", () => {
    const { icon } = buildProviderInfo("11111111-2222-3333-4444-555555555555");

    expect(icon.startsWith("data:image/svg+xml,")).toBe(true);

    const svg = decodeURIComponent(icon.slice("data:image/svg+xml,".length));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("does not invent a uuid of its own", () => {
    // Two calls with the same uuid must be identical: nothing random inside.
    expect(buildProviderInfo("same-uuid")).toEqual(buildProviderInfo("same-uuid"));
  });
});

describe("notifyListeners", () => {
  it("calls every listener with the event data", () => {
    const first = vi.fn();
    const second = vi.fn();

    notifyListeners([first, second], ["0xabc"]);

    expect(first).toHaveBeenCalledWith(["0xabc"]);
    expect(second).toHaveBeenCalledWith(["0xabc"]);
  });

  /**
   * 🇪🇸 NOTA: los listeners son código de la dApp, no nuestro. Un `for` desnudo
   * hace que el primero que lance se lleve por delante a todos los de detrás, y
   * el síntoma que ve el usuario es "la wallet no actualiza la cuenta en esta
   * web", sin ninguna pista de que la culpa fue del propio listener de la dApp.
   */
  it("keeps going when a listener throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exploding = vi.fn(() => {
      throw new Error("dApp listener bug");
    });
    const survivor = vi.fn();

    expect(() => notifyListeners([exploding, survivor], "0x7a69")).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there are no listeners", () => {
    expect(() => notifyListeners([], "0x7a69")).not.toThrow();
  });
});
