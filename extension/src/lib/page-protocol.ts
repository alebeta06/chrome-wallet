/**
 * @file lib/page-protocol.ts
 * @description The page boundary, reduced to pure functions.
 *
 * `inject.ts` and `content-script.ts` both live on the untrusted side of the
 * bridge and both have to validate exactly the same things. Everything that can
 * be decided without a DOM lives here, which is what makes the checks testable:
 * a test hands `isTrustedPageMessage` a plain object pretending to be a hostile
 * iframe and asserts the rejection, with no browser involved.
 *
 * ---------------------------------------------------------------------------
 * NO MODULE-LEVEL STATE — READ BEFORE ADDING ANYTHING
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: este módulo lo importan los DOS scripts clásicos, y cada uno se
 * compila en su propia pasada IIFE (ver vite.config.scripts.ts). Eso significa
 * que el código de aquí se inlinea DOS VECES, en dos bundles independientes. Una
 * constante es inofensiva; un `Map` o un contador a nivel de módulo serían dos
 * objetos distintos que se creerían el mismo, y el bug resultante solo aparece
 * en el navegador. Solo constantes y funciones puras.
 */

import {
  PROTOCOL,
  PROTOCOL_VERSION,
  PROVIDER_NAME,
  PROVIDER_RDNS,
  isPageMessage,
  type EIP6963ProviderInfo,
  type Origin,
  type PageEventMessage,
  type PageRequestMessage,
  type PageResponseMessage,
  type ProviderEventMap,
  type ProviderEventName,
  type RequestId,
  type SerializedProviderError,
} from "@/types/messages";

import { PROVIDER_ICON_DATA_URI } from "./provider-icon";

// ============================================================================
// 1. Channel names
// ============================================================================

/**
 * How the content script hands the EIP-6963 uuid to the page.
 *
 * 🇪🇸 NOTA: el uuid NO viaja por el bus de protocolo, y no es un descuido.
 * `messages.ts` es inmutable y no define ningún método RPC ni ningún tipo de
 * mensaje para pedirlo: meterlo en un `CODECRYPTO_REQUEST` obligaría a inventar
 * una forma de mensaje fuera del contrato. Un CustomEvent del DOM es un canal
 * distinto, no una extensión del protocolo, y el uuid es un identificador
 * público que la dApp va a ver de todas formas en el anuncio.
 *
 * Se entrega por DOS vías porque los dos órdenes de llegada son posibles:
 *  - el atributo, si inject.js se evalúa DESPUÉS de que el uuid ya esté resuelto
 *  - el evento, si se evalúa ANTES
 */
export const PROVIDER_UUID_EVENT = "codecrypto:providerUuid" as const;

/** `document.documentElement.dataset[PROVIDER_UUID_DATASET_KEY]`. */
export const PROVIDER_UUID_DATASET_KEY = "ccProviderUuid" as const;

export const EIP6963_ANNOUNCE = "eip6963:announceProvider" as const;
export const EIP6963_REQUEST = "eip6963:requestProvider" as const;

// ============================================================================
// 2. The guard
// ============================================================================

/** The parts of a MessageEvent this check needs. Narrow on purpose: it keeps the function testable. */
export interface IncomingPageMessage {
  source: unknown;
  data: unknown;
}

/**
 * The three checks that every `message` listener on this bridge must pass.
 *
 * 🇪🇸 NOTA: `window.postMessage` es un bus PÚBLICO. La propia página, cualquier
 * iframe, y cualquier otra extensión instalada escriben en él, y todos ven lo
 * que escribimos nosotros. Las tres comprobaciones no son celo:
 *
 *   1. `source === self`  — el mensaje lo puso ESTA ventana. Sin esto, un iframe
 *      hostil puede inyectar una CODECRYPTO_RESPONSE falsa con el id de una
 *      petición en vuelo y hacerle creer a la dApp que una transacción se firmó.
 *      Es la comprobación que de verdad importa y la que se olvida siempre.
 *   2. `isPageMessage`    — lleva nuestro marcador y nuestra versión de protocolo.
 *   3. `type`             — es el mensaje que este listener espera, y no otro del
 *      protocolo que le corresponde al de enfrente.
 */
export function isTrustedPageMessage(
  event: IncomingPageMessage,
  self: unknown,
  expectedType: string,
): boolean {
  if (event.source !== self) return false;
  if (!isPageMessage(event.data)) return false;
  return event.data.type === expectedType;
}

// ============================================================================
// 3. Errors across the bridge
// ============================================================================

/**
 * A wire error rebuilt into something a dApp can `catch` and branch on.
 *
 * 🇪🇸 NOTA: `postMessage` hace structured clone, que NO conserva subclases de
 * Error ni propiedades no enumerables. Por eso los errores cruzan como objetos
 * planos (`SerializedProviderError`) y se reconstruyen aquí. Y tiene que ser un
 * Error de verdad con `.code`: es exactamente lo que ethers y wagmi inspeccionan
 * para distinguir "el usuario canceló" (4001) de "esto ha petado" (-32603). Un
 * objeto plano rechazado tal cual rompe el manejo de errores de la dApp.
 */
export class InjectedProviderError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(serialized: SerializedProviderError) {
    super(serialized.message);
    this.name = "InjectedProviderError";
    this.code = serialized.code;
    if (serialized.data !== undefined) this.data = serialized.data;
  }
}

export function toInjectedError(serialized: SerializedProviderError): InjectedProviderError {
  return new InjectedProviderError(serialized);
}

// ============================================================================
// 4. Event targeting — the second lock
// ============================================================================

/**
 * Should this page deliver a CODECRYPTO_TAB_EVENT it just received?
 *
 * 🇪🇸 NOTA: el background ya eligió la pestaña con `chrome.tabs.query`, así que
 * esto parece redundante. No lo es. Los tabId se RECICLAN, y entre el query y el
 * sendMessage la pestaña puede haber navegado de la dApp A a la dApp B. En esa
 * ventana de milisegundos el evento aterriza en el sitio equivocado y le filtras
 * a B qué cuenta usas en A — que es justo la fuga que el modelo por origen
 * existe para evitar. El cerrojo cuesta una línea.
 *
 * `expectedOrigin === null` es el caso de los eventos globales (chainChanged):
 * la red es una propiedad de la wallet, no de la relación con un sitio, así que
 * todo origen conectado puede recibirla.
 */
export function shouldDeliverTabEvent(
  expectedOrigin: Origin | null,
  locationOrigin: string,
): boolean {
  if (expectedOrigin === null) return true;
  return expectedOrigin === locationOrigin;
}

// ============================================================================
// 5. Envelopes
// ============================================================================

/**
 * 🇪🇸 NOTA: `PageMessageBase` es privado dentro del contrato, así que el
 * marcador hay que escribirlo a mano. Se hace SOLO aquí: tres constructoras en
 * un archivo en vez de literales sueltos repartidos por los dos scripts, que es
 * como se acaba enviando un mensaje sin `v` y depurándolo media tarde.
 */
export function pageRequest(
  id: RequestId,
  method: string,
  params: unknown[],
): PageRequestMessage {
  return { __codecrypto: PROTOCOL, v: PROTOCOL_VERSION, type: "CODECRYPTO_REQUEST", id, method, params };
}

export function pageSuccess(id: RequestId, result: unknown): PageResponseMessage {
  return { __codecrypto: PROTOCOL, v: PROTOCOL_VERSION, type: "CODECRYPTO_RESPONSE", id, ok: true, result };
}

export function pageFailure(id: RequestId, error: SerializedProviderError): PageResponseMessage {
  return { __codecrypto: PROTOCOL, v: PROTOCOL_VERSION, type: "CODECRYPTO_RESPONSE", id, ok: false, error };
}

export function pageEvent(
  eventName: ProviderEventName,
  data: ProviderEventMap[ProviderEventName],
): PageEventMessage {
  return { __codecrypto: PROTOCOL, v: PROTOCOL_VERSION, type: "CODECRYPTO_EVENT", eventName, data };
}

/**
 * Is this a CODECRYPTO_REQUEST the relay can actually work with?
 *
 * 🇪🇸 NOTA: `isTrustedPageMessage` responde "esto es nuestro protocolo", no
 * "esto tiene sentido". El `request()` de inject.ts valida sus argumentos, pero
 * una página puede saltárselo y hacer `window.postMessage` a mano con el
 * marcador correcto y un `params` que sea `null`. El background acabaría
 * devolviendo un -32603 opaco por un `params[0]` sobre algo que no es un array,
 * cuando la respuesta honesta es -32602. Y sin un `id` que sea string no hay
 * forma de contestar a nadie: ese mensaje se descarta sin más.
 */
export function isWellFormedPageRequest(data: unknown): data is PageRequestMessage {
  const candidate = data as Partial<PageRequestMessage>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.method === "string" &&
    candidate.method.length > 0 &&
    Array.isArray(candidate.params)
  );
}

// ============================================================================
// 6. EIP-6963 identity
// ============================================================================

/**
 * The `info` half of an EIP-6963 announcement.
 *
 * 🇪🇸 NOTA: el `uuid` viene de fuera a propósito. Tiene que ser estable durante
 * toda la instalación (vive en `cc:providerUuid`), y generarlo aquí — es decir,
 * en cada carga de página — haría que la dApp viese una wallet distinta cada vez
 * que recargas. Esta función no puede inventarlo aunque quiera.
 */
export function buildProviderInfo(uuid: string): EIP6963ProviderInfo {
  return {
    uuid,
    name: PROVIDER_NAME,
    icon: PROVIDER_ICON_DATA_URI,
    rdns: PROVIDER_RDNS,
  };
}

// ============================================================================
// 7. Listener fan-out
// ============================================================================

export type ProviderEventListener = (data: unknown) => void;

/**
 * Calls every listener, even if one of them throws.
 *
 * 🇪🇸 NOTA: los listeners son código de la dApp, no nuestro. Un `for` desnudo
 * hace que el primero que lance se lleve por delante a todos los que vengan
 * detrás, y el síntoma que ve el usuario es "la wallet no actualiza la cuenta en
 * esta web" — sin ninguna pista de que la culpa fue del propio listener de la
 * dApp. Aislar cada llamada convierte un fallo silencioso y ajeno en un error de
 * consola atribuible.
 */
export function notifyListeners(
  listeners: Iterable<ProviderEventListener>,
  data: unknown,
): void {
  for (const listener of listeners) {
    try {
      listener(data);
    } catch (cause) {
      console.error(`[${PROTOCOL}] a provider event listener threw:`, cause);
    }
  }
}
