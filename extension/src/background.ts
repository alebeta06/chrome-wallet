/**
 * @file background.ts
 * @description Service worker. Thin adapter over chrome.* — every decision
 * lives in lib/, which is testable without a browser.
 *
 * This is the only script that is an ES module, and the only place the mnemonic
 * and private keys ever exist.
 */

import {
  PROTOCOL,
  ProviderErrors,
  parseApprovalPortName,
  type Origin,
  type RequestId,
  type RuntimeMessage,
} from "@/types/messages";

import { createApprovalCoordinator, type ApprovalWindows } from "@/lib/approvals";
import { createDispatcher } from "@/lib/dispatch";
import { createEventEmitter, type TabsPort } from "@/lib/events";
import { createWalletStorage, type WalletStorage } from "@/lib/storage";

const storage = createWalletStorage();

// ============================================================================
// chrome.* adapters — the only place these APIs are touched
// ============================================================================

/**
 * 🇪🇸 NOTA: `chrome.tabs` se envuelve en la superficie mínima que declara
 * `TabsPort` en vez de pasarse entero. Eso es lo que permite que toda la lógica
 * de a-quién-llega-un-evento se pruebe con un objeto de diez líneas, y ahí es
 * donde está el riesgo real: que un evento de cuenta aterrice en el origen
 * equivocado no rompe nada visiblemente, solo filtra.
 */
const tabs: TabsPort = {
  query: (queryInfo) => chrome.tabs.query(queryInfo),
  sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
};

const APPROVAL_WINDOW = { width: 420, height: 640 } as const;

const windows: ApprovalWindows = {
  async open(requestId: RequestId) {
    const url = `${chrome.runtime.getURL("connect.html")}?requestId=${encodeURIComponent(requestId)}`;

    const created = await chrome.windows.create({
      url,
      type: "popup",
      focused: true,
      ...APPROVAL_WINDOW,
    });

    return created?.id;
  },

  async close(windowId: number) {
    await chrome.windows.remove(windowId);
  },
};

/**
 * The origin of the tab the user is looking at, for WalletSnapshot.activeSite.
 *
 * 🇪🇸 NOTA: solo http/https. Una pestaña en `chrome://extensions`, en una página
 * de la propia extensión o en un `about:blank` no es un sitio conectable, y
 * devolver su "origen" haría que el popup enseñara una banda de sitio para algo
 * que no es un sitio.
 */
async function activeOrigin(): Promise<Origin | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url === undefined) return null;

  try {
    const url = new URL(tab.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Wiring
// ============================================================================

const approvals = createApprovalCoordinator({ storage, windows });
const emit = createEventEmitter(tabs);
const dispatch = createDispatcher({ storage, approvals, emit, activeOrigin });

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

// ============================================================================
// Boundary 4 — the keep-alive port
// ============================================================================

/**
 * ---------------------------------------------------------------------------
 * THE PORT DOES TWO JOBS, AND BOTH ARE LOAD-BEARING
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA:
 *
 *   1. Un puerto conectado mantiene vivo el service worker. Sin él, Chrome
 *      suspende el worker a los ~30 s y se lleva por delante la promesa que
 *      está esperando la decisión del usuario — justo mientras el usuario
 *      piensa, que es cuando más tarda.
 *
 *   2. `onDisconnect` es cómo nos enteramos de que la ventana se cerró con la X.
 *      Es más fiable que `chrome.windows.onRemoved` porque cubre además que la
 *      página crashee o navegue a otro sitio: en los tres casos el puerto cae.
 *
 * El nombre del puerto lleva el requestId dentro (`approvalPortName` en el
 * contrato), así que sabemos exactamente qué solicitud rechazar.
 */
chrome.runtime.onConnect.addListener((port) => {
  const requestId = parseApprovalPortName(port.name);
  if (requestId === null) return;

  port.onDisconnect.addListener(() => {
    /**
     * 🇪🇸 NOTA: esto se dispara TAMBIÉN en el camino feliz — el usuario aprueba,
     * el background cierra la ventana, y el puerto cae. No es un problema
     * porque `reject` es idempotente y la aprobación ya limpió la solicitud: al
     * llegar aquí no queda nada pendiente y la llamada no hace nada.
     *
     * Ese orden es la razón de que sea el BACKGROUND quien cierra la ventana y
     * no la propia UI. Si la cerrara la UI, el cierre podría llegar antes que
     * la decisión y un 4001 pisaría una aprobación.
     */
    void approvals.reject(
      requestId,
      ProviderErrors.userRejected("The approval window was closed."),
    );
  });
});

// ============================================================================
// Boundaries 2 & 3 — runtime messaging
// ============================================================================

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
  if (message?.type === "CODECRYPTO_RPC") {
    void dispatch(message, sender, chrome.runtime.id).then(sendResponse);
    return true;
  }

  if (message?.type === "CODECRYPTO_DECISION") {
    /**
     * 🇪🇸 NOTA: solo nuestras propias ventanas de aprobación pueden decidir. Sin
     * esta comprobación, una web podría mandar un CODECRYPTO_DECISION aprobando
     * su propia solicitud de conexión y saltarse la ventana entera — que es
     * exactamente el permiso que esta fase existe para pedir.
     */
    if (sender.id !== chrome.runtime.id || sender.origin !== `chrome-extension://${chrome.runtime.id}`) {
      return false;
    }

    void (message.approved
      ? approvals.settle(message.requestId, message.kind === "connect" ? message.accountIndex : 0)
      : approvals.reject(message.requestId, message.error));

    return false;
  }

  return false;
});
