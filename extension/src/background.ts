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
  type PendingKind,
  type RequestId,
  type RuntimeMessage,
} from "@/types/messages";

import { createApprovalCoordinator, type ApprovalWindows } from "@/lib/approvals";
import { pendingBadgeText } from "@/lib/badge";
import { createDispatcher } from "@/lib/dispatch";
import { createEventEmitter, type TabsPort } from "@/lib/events";
import { createNetworkStore } from "@/lib/network-store";
import { createTransactionSender } from "@/lib/signer";
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

const APPROVAL_WINDOW = { width: 420, height: 660 } as const;

/** Which surface renders each kind of request. */
const APPROVAL_PAGE: Record<PendingKind, string> = {
  connect: "connect.html",
  signature: "notification.html",
  // Phase 8. Until then nothing creates one, so this is never reached.
  "add-chain": "notification.html",
};

const NOTIFICATION_TEXT: Record<PendingKind, { title: string; message: string }> = {
  connect: { title: "Connection request", message: "A site wants to connect to your wallet." },
  signature: { title: "Signature request", message: "A site is asking you to sign a transaction." },
  "add-chain": { title: "Network request", message: "A site wants to add a network." },
};

/**
 * 🇪🇸 NOTA: PNG, nunca el SVG. `chrome.notifications` falla EN SILENCIO con un
 * SVG — sin excepción, sin notificación y sin nada en consola. Los PNG los
 * genera `pnpm icons` desde la Fase 0 y están en `dist/icons/`.
 */
const NOTIFICATION_ICON = "icons/icon-128.png";

const windows: ApprovalWindows = {
  /**
   * 🇪🇸 NOTA: aquí se abre la ventana Y se dispara la notificación de escritorio.
   * No es mezclar dos cosas: este método es "preséntale esto al usuario", y es
   * el único punto que se ejecuta exactamente una vez por solicitud nueva.
   * Colgar la notificación de un listener de storage la repetiría en cada cambio.
   */
  async open(requestId: RequestId, kind: PendingKind) {
    const page = APPROVAL_PAGE[kind];
    const url = `${chrome.runtime.getURL(page)}?requestId=${encodeURIComponent(requestId)}`;

    const created = await chrome.windows.create({
      url,
      type: "popup",
      focused: true,
      ...APPROVAL_WINDOW,
    });

    notify(requestId, kind);

    return created?.id;
  },

  async close(windowId: number) {
    await chrome.windows.remove(windowId);
  },
};

function notify(requestId: RequestId, kind: PendingKind): void {
  const { title, message } = NOTIFICATION_TEXT[kind];

  // Fire and forget: a wallet that cannot show a toast still works perfectly.
  chrome.notifications.create(`codecrypto:${requestId}`, {
    type: "basic",
    iconUrl: NOTIFICATION_ICON,
    title,
    message,
    priority: 2,
  });
}

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
const sender = createTransactionSender();

/**
 * 🇪🇸 NOTA: UNA instancia, creada aquí y pasada al despachador. El store lleva
 * dentro la cadena que serializa las escrituras de `cc:networks`, y dos
 * instancias serían dos cadenas que no se ven entre sí — que es exactamente no
 * tener cadena. Es la misma razón por la que el coordinador de aprobaciones
 * también se construye una sola vez.
 */
const networks = createNetworkStore(storage);

const dispatch = createDispatcher({ storage, approvals, emit, sender, activeOrigin, networks });

console.log(`[${PROTOCOL}] background service worker alive`);

/**
 * ---------------------------------------------------------------------------
 * THE CATALOGUE IS BROUGHT UP TO SHAPE ON EVERY START, AND WRITES NOTHING WHEN
 * THERE IS NOTHING TO CHANGE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: mismo patrón que `ensureProviderUuid` de abajo, y por el mismo
 * motivo: el service worker arranca de cero constantemente, así que lo que se
 * haga "al instalar" tiene que poder ejecutarse cien veces sin efecto. La
 * migración es idempotente y solo escribe si algo cambió — si escribiera
 * siempre, cada despertar del worker dispararía `chrome.storage.onChanged` y
 * refrescaría la UI abierta sin motivo.
 *
 * Que falle no puede impedir que el worker arranque: `read()` migra al vuelo de
 * todas formas, así que la wallet sigue funcionando y lo único que se pierde es
 * dejarlo persistido hasta el siguiente arranque.
 */
void networks.migrate().catch((cause: unknown) => {
  console.error(`[${PROTOCOL}] could not migrate the network catalogue:`, cause);
});

// ============================================================================
// The badge (spec 32)
// ============================================================================

/**
 * ---------------------------------------------------------------------------
 * THE BADGE IS DERIVED, NOT COUNTED
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: no hay ningún contador que sumar y restar. Se recalcula desde
 * `cc:pendingRequests` en dos momentos, y con esos dos basta:
 *
 *   - al arrancar el worker, que es lo que lo deja correcto DESPUÉS DE DORMIR;
 *   - en cada cambio de esa clave, que cubre crear, resolver y caducar sin que
 *     ninguna rama tenga que acordarse de avisar.
 *
 * Un contador en memoria fallaría exactamente en el caso que más importa: el
 * usuario tiene una ventana de aprobación abierta, el worker se duerme, y al
 * despertar el badge dice que no hay nada pendiente.
 */
async function refreshBadge(): Promise<void> {
  const text = pendingBadgeText(await storage.get("cc:pendingRequests"), Date.now());

  await chrome.action.setBadgeText({ text });
  if (text.length > 0) await chrome.action.setBadgeBackgroundColor({ color: "#7c5cff" });
}

void refreshBadge().catch((cause: unknown) => {
  console.error(`[${PROTOCOL}] could not restore the badge:`, cause);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || changes["cc:pendingRequests"] === undefined) return;

  void refreshBadge().catch((cause: unknown) => {
    console.error(`[${PROTOCOL}] could not refresh the badge:`, cause);
  });
});

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

    /**
     * 🇪🇸 NOTA: se le pasa el mensaje ENTERO al coordinador en vez de extraer
     * aquí lo que necesita. Una firma aprobada no lleva índice de cuenta y una
     * conexión sí; desempaquetarlo en el background obligaría a este listener a
     * conocer la forma de cada tipo de aprobación, y a crecer con cada fase.
     */
    void (message.approved
      ? approvals.settle(message.requestId, message)
      : approvals.reject(message.requestId, message.error));

    return false;
  }

  return false;
});
