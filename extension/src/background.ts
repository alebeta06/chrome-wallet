/**
 * @file background.ts
 * @description Service worker. Phase 0 stub: it only proves the contract
 * compiles and runs from the most privileged context.
 *
 * This is the ONE script that is an ES module (`"type": "module"` in the
 * manifest), so it is allowed to keep `import` statements after bundling.
 *
 * 🇪🇸 NOTA: aquí es donde vivirán el mnemonic y las claves privadas a partir de
 * la Fase 2. Nada de lo que se escriba en este archivo puede filtrarse a una
 * página web salvo que lo devuelva explícitamente un método público.
 */

import {
  PROTOCOL,
  PROTOCOL_VERSION,
  classifySender,
  type RuntimeMessage,
} from "@/types/messages";

console.log(`[${PROTOCOL}] background service worker alive — protocol v${PROTOCOL_VERSION}`);

/**
 * Phase 0 does not answer anything: it classifies the sender and logs it, so we
 * can see the trust boundary working before there is any logic behind it.
 *
 * 🇪🇸 NOTA: `classifySender` devuelve null si el mensaje no viene de nuestra
 * propia extensión, y marca `fromPage: true` cuando el emisor es un content
 * script. A partir de la Fase 4 ese booleano es lo único que separa
 * `wallet_importMnemonic` de cualquier web que visites.
 */
chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender) => {
  const context = classifySender(sender, chrome.runtime.id);

  if (context === null) {
    console.warn(`[${PROTOCOL}] background dropped a message from a foreign sender`);
    return false;
  }

  console.log(`[${PROTOCOL}] background received ${message.type}`, context);

  // No async response in phase 0.
  return false;
});
