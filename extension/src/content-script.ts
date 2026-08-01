/**
 * @file content-script.ts
 * @description The relay between the page and the service worker.
 *
 * Runs in the ISOLATED world: it shares the DOM with the page but not its
 * JavaScript globals, and it is the only one of the three scripts that can talk
 * both to `window` and to `chrome.runtime`. Nothing decides anything here — it
 * forwards, it validates, and it translates one envelope into the other.
 *
 * Built as a CLASSIC script (see vite.config.scripts.ts) — no `import` survives
 * bundling, everything it uses from the contract is inlined.
 */

import {
  PROTOCOL,
  ProviderErrors,
  type PageRequestMessage,
  type RpcRequestMessage,
  type RpcResponseMessage,
  type RuntimeMessage,
  type SerializedProviderError,
} from "@/types/messages";

import {
  PROVIDER_UUID_DATASET_KEY,
  PROVIDER_UUID_EVENT,
  isTrustedPageMessage,
  isWellFormedPageRequest,
  pageEvent,
  pageFailure,
  pageSuccess,
  shouldDeliverTabEvent,
} from "@/lib/page-protocol";

console.log(`[${PROTOCOL}] content script loaded at ${location.origin}`);

// ============================================================================
// 1. Inject the provider — synchronously, before anything else
// ============================================================================

/**
 * Injects inject.js into the page's own JavaScript world.
 *
 * 🇪🇸 NOTA: el content script NO puede escribir `window.codecrypto` para la
 * página: su `window` es otro objeto. La única vía es meter un <script> en el
 * DOM, que sí ejecuta el navegador en el contexto de la página. Y por eso
 * inject.js tiene que estar en `web_accessible_resources`: sin eso la página no
 * tiene permiso para cargar un archivo desde el origen chrome-extension://.
 */
function injectPageScript(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.async = false;
  // At document_start <head> may not exist yet; <html> always does.
  script.onload = () => script.remove();
  (document.head ?? document.documentElement).appendChild(script);
}

/**
 * 🇪🇸 NOTA: esta llamada va la PRIMERA y sin ningún `await` delante, y ése es
 * el detalle de diseño de la fase. `run_at: "document_start"` existe para que
 * `window.codecrypto` esté antes del primer script de la dApp; si aquí se
 * esperara al uuid de EIP-6963 (abajo), el provider aparecería unos
 * milisegundos tarde y una dApp que lo busque en su primer script no lo
 * encontraría. El uuid llega después por su cuenta: EIP-6963 sí tolera un
 * anuncio tardío, `window.codecrypto` no tolera una aparición tardía.
 */
injectPageScript();

// ============================================================================
// 2. The EIP-6963 uuid handoff
// ============================================================================

/**
 * Hands the provider uuid to the page world.
 *
 * 🇪🇸 NOTA: el atributo PRIMERO y el evento DESPUÉS, en este orden. Cubren los
 * dos órdenes de llegada posibles: si inject.js ya se evaluó, lo despierta el
 * evento; si aún no, leerá el atributo en cuanto lo haga. Poner el evento antes
 * dejaría una ventana en la que un inject.js que arranca justo entonces no ve
 * ninguna de las dos cosas.
 *
 * Que el uuid quede en el DOM no expone nada nuevo: la dApp lo va a ver en el
 * anuncio de EIP-6963, y `window.codecrypto` ya delata que la wallet está
 * instalada.
 */
function publishProviderUuid(uuid: string): void {
  document.documentElement.dataset[PROVIDER_UUID_DATASET_KEY] = uuid;
  window.dispatchEvent(new CustomEvent(PROVIDER_UUID_EVENT, { detail: uuid }));
}

function readUuid(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The one place where the content script reads storage instead of relaying.
 *
 * 🇪🇸 NOTA: sí, rompe el papel de "puro relay", y es deliberado. El uuid tiene
 * que ser estable durante toda la instalación —uno nuevo en cada carga haría que
 * la dApp viese dos wallets distintas al recargar— así que vive en
 * `cc:providerUuid` y lo genera el background. Pero `messages.ts` es INMUTABLE y
 * no define ningún método RPC para pedirlo: la alternativa era inventar una
 * forma de mensaje fuera del contrato. Leer una clave pública de storage es la
 * desviación pequeña; tocar el contrato era la grande.
 */
async function deliverProviderUuid(): Promise<void> {
  const items = await chrome.storage.local.get(["cc:providerUuid"]);
  const uuid = readUuid(items["cc:providerUuid"]);

  if (uuid !== undefined) {
    publishProviderUuid(uuid);
    return;
  }

  /**
   * 🇪🇸 NOTA: el hueco es real aunque sea estrecho. El background siembra el
   * uuid al arrancar el worker, pero en una instalación recién hecha esta
   * lectura puede ganarle la carrera. Sin esta suscripción, esa pestaña se queda
   * sin anuncio de EIP-6963 hasta que se recargue, y el usuario ve una wallet
   * que "a veces no aparece".
   */
  const onChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local") return;
    const pending = readUuid(changes["cc:providerUuid"]?.newValue);
    if (pending === undefined) return;
    chrome.storage.onChanged.removeListener(onChanged);
    publishProviderUuid(pending);
  };

  chrome.storage.onChanged.addListener(onChanged);
}

void deliverProviderUuid().catch((cause: unknown) => {
  // A missing uuid costs the EIP-6963 announcement, nothing else. The provider
  // still works, so this is a debug line and not a thrown error.
  console.debug(`[${PROTOCOL}] could not resolve the provider uuid:`, cause);
});

// ============================================================================
// 3. Page -> background
// ============================================================================

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isTrustedPageMessage(event, window, "CODECRYPTO_REQUEST")) return;

  const data = event.data;
  if (!isWellFormedPageRequest(data)) {
    // No usable id means there is nobody to answer, so a malformed message is
    // dropped rather than replied to.
    console.debug(`[${PROTOCOL}] dropped a malformed CODECRYPTO_REQUEST`, data);
    return;
  }

  void relayToBackground(data);
});

/**
 * 🇪🇸 NOTA: la promesa del lado de la página NO puede quedarse colgada. Tiene
 * un timeout de 150 s, así que una petición perdida no cuelga para siempre —
 * pero deja a la dApp esperando dos minutos y medio por algo que ya sabemos que
 * ha fallado. Los dos modos de fallo de `sendMessage` se contestan al instante.
 */
async function relayToBackground(request: PageRequestMessage): Promise<void> {
  const rpc: RpcRequestMessage = {
    type: "CODECRYPTO_RPC",
    id: request.id,
    method: request.method,
    params: request.params,
  };

  let response: RpcResponseMessage | undefined;

  try {
    response = await chrome.runtime.sendMessage<RpcRequestMessage, RpcResponseMessage | undefined>(
      rpc,
    );
  } catch {
    /**
     * 🇪🇸 NOTA: que el service worker esté dormido NO es este caso — Chrome lo
     * despierta solo y la petición llega. Esto es el otro: la extensión se está
     * recargando o se ha desinstalado, y no hay receptor al que despertar.
     * 4900 (DISCONNECTED) es exactamente eso, y le dice a la dApp que reintente
     * en vez de tratarlo como un bug de su propio código.
     */
    reply(request.id, ProviderErrors.disconnected("The wallet is not reachable. Reload the page and try again."));
    return;
  }

  // sendMessage also RESOLVES with undefined when the channel closed before an
  // answer — a different failure that surfaces as neither a throw nor an ok:false.
  if (response === undefined) {
    reply(request.id, ProviderErrors.disconnected("The wallet closed the channel without answering."));
    return;
  }

  window.postMessage(
    response.ok ? pageSuccess(request.id, response.result) : pageFailure(request.id, response.error),
    "*",
  );
}

function reply(id: string, error: SerializedProviderError): void {
  window.postMessage(pageFailure(id, error), "*");
}

// ============================================================================
// 4. Background -> page
// ============================================================================

chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
  if (message?.type !== "CODECRYPTO_TAB_EVENT") return false;

  /**
   * 🇪🇸 NOTA: el segundo cerrojo. El background ya eligió esta pestaña, pero los
   * tabId se reciclan y entre el `chrome.tabs.query` y el `sendMessage` la
   * pestaña puede haber navegado de la dApp A a la dApp B. Sin esta línea el
   * evento aterriza en el sitio equivocado y le filtras a B qué cuenta usas en
   * A. Ventana de milisegundos, fuga real, comprobación de una línea.
   *
   * En un iframe about:blank (`match_about_blank`) `location.origin` es la
   * cadena "null", que no coincide con ningún origen real: los eventos globales
   * (expectedOrigin === null) sí entran ahí y los de origen no, que es justo lo
   * que se quiere.
   */
  if (!shouldDeliverTabEvent(message.expectedOrigin, location.origin)) return false;

  window.postMessage(pageEvent(message.eventName, message.data), "*");

  // No response travels back on this channel: returning false closes it now
  // instead of leaving it open until it times out.
  return false;
});
