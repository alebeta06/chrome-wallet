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
import { createWalletStorage, type WalletStorage } from "@/lib/storage";

const storage = createWalletStorage();
const dispatch = createDispatcher({ storage });

console.log(`[${PROTOCOL}] background service worker alive`);

/**
 * Generates the EIP-6963 identity once, and only once.
 *
 * 🇪🇸 NOTA: el uuid tiene que ser ESTABLE durante toda la instalación. Uno nuevo
 * en cada carga de página haría que la dApp viese dos wallets distintas al
 * recargar, y un selector multi-wallet acumularía entradas duplicadas de la
 * misma extensión.
 *
 * Lo genera el background y no el content script por una razón concreta: hay un
 * content script por PESTAÑA, y varias pestañas abriéndose a la vez generarían
 * uuids distintos y competirían por escribirlos. El service worker es uno solo.
 *
 * Esto es una escritura en storage, no estado de módulo: al despertar el worker
 * vuelve a comprobarlo y no escribe nada si ya existe.
 */
async function ensureProviderUuid(area: WalletStorage): Promise<void> {
  if ((await area.get("cc:providerUuid")) !== undefined) return;
  await area.set("cc:providerUuid", crypto.randomUUID());
}

void ensureProviderUuid(storage).catch((cause: unknown) => {
  console.error(`[${PROTOCOL}] could not seed the provider uuid:`, cause);
});

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
