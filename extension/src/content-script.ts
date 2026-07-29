/**
 * @file content-script.ts
 * @description Bridge between the page and the service worker. Phase 0 stub.
 *
 * Runs in the ISOLATED world: it shares the DOM with the page but not its
 * JavaScript globals, and it is the only one of the three scripts that can talk
 * both to `window` and to `chrome.runtime`.
 *
 * Built as a CLASSIC script (see vite.config.scripts.ts) — no `import` survives
 * bundling, everything it uses from the contract is inlined.
 */

import { PROTOCOL, isPageMessage } from "@/types/messages";

console.log(`[${PROTOCOL}] content script loaded at ${location.origin}`);

/**
 * Injects inject.js into the page's own JavaScript world.
 *
 * 🇪🇸 NOTA: el content script NO puede escribir `window.ethereum` para la
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

injectPageScript();

/**
 * 🇪🇸 NOTA: window.postMessage es un bus público — la propia página, otros
 * iframes y otras extensiones escriben en él. Las dos comprobaciones de abajo
 * no son opcionales: `event.source === window` descarta lo que venga de un
 * iframe, e `isPageMessage` descarta lo que no lleve nuestro marcador de
 * protocolo. Sin ellas, cualquiera puede fabricar una respuesta falsa.
 */
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window) return;
  if (!isPageMessage(event.data)) return;

  console.log(`[${PROTOCOL}] content script saw a protocol message: ${event.data.type}`);
});
