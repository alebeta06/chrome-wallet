/**
 * @file background.ts
 * @description Service worker. Thin adapter over chrome.runtime — every
 * decision lives in lib/dispatch.ts, which is testable without a browser.
 *
 * This is the only script that is an ES module, and the only place the mnemonic
 * and private keys ever exist.
 */

import { PROTOCOL, type RuntimeMessage } from "@/types/messages";

import { createDispatcher } from "@/lib/dispatch";
import { createWalletStorage } from "@/lib/storage";

const dispatch = createDispatcher({ storage: createWalletStorage() });

console.log(`[${PROTOCOL}] background service worker alive`);

/**
 * 🇪🇸 NOTA: el gotcha de MV3 en Chrome. Esto NO funciona:
 *
 *   chrome.runtime.onMessage.addListener(async (msg) => handle(msg));
 *
 * Devolver una Promise desde el listener es la API de Firefox. Chrome la
 * ignora, cierra el canal al volver el listener y el emisor recibe `undefined`
 * sin ningún error. La forma correcta es `sendResponse` + `return true`, que le
 * dice a Chrome "voy a responder más tarde, no cierres el canal".
 *
 * `return false` para todo lo que no sea nuestro: devolver `true` sin intención
 * de responder deja el canal colgado hasta que expira.
 */
chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message?.type !== "CODECRYPTO_RPC") return false;

  void dispatch(message, sender, chrome.runtime.id).then(sendResponse);
  return true;
});
