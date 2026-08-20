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
import { createBadge } from "@/lib/badge";
import { createDispatcher } from "@/lib/dispatch";
import { createEventEmitter, type TabsPort } from "@/lib/events";
import { createLogWriter } from "@/lib/logs";
import { createNotifier, requestIdFromNotification } from "@/lib/notifications";
import { createPendingTxStore } from "@/lib/pending-txs";
import { TX_ALARM, createTxWatcher } from "@/lib/tx-watcher";
import { fetchReceipt } from "@/lib/chain";
import { createNetworkStore } from "@/lib/network-store";
import { createPermissionsPort, hasPermissionFor } from "@/lib/permissions";
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

/**
 * 🇪🇸 NOTA: PNG, nunca el SVG. `chrome.notifications` falla EN SILENCIO con un
 * SVG — sin excepción, sin notificación y sin nada en consola. Los PNG los
 * genera `pnpm icons` desde la Fase 0 y están en `dist/icons/`. La ruta y los
 * textos viven ahora en `lib/notifications.ts`, con el resto de la decisión.
 */
const notifier = createNotifier({
  create: async (id, options) => {
    await chrome.notifications.create(id, { type: "basic", priority: 2, ...options });
  },
  clear: async (id) => {
    await chrome.notifications.clear(id);
  },
});

const windows: ApprovalWindows = {
  /**
   * 🇪🇸 NOTA: esto ya SOLO abre la ventana. La notificación se disparaba aquí
   * dentro, y se ha movido al coordinador —que es quien sabe si la solicitud es
   * nueva o un duplicado enganchado— para que crear y cerrar el aviso vivan en
   * el mismo sitio. Con `create` aquí y `clear` allí, el día que una de las dos
   * cambie el id, el síntoma sería un aviso que no se cierra nunca.
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

    return created?.id;
  },

  async close(windowId: number) {
    await chrome.windows.remove(windowId);
  },

  async focus(windowId: number) {
    await chrome.windows.update(windowId, { focused: true });
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

const approvals = createApprovalCoordinator({ storage, windows, notifier });

/**
 * 🇪🇸 NOTA: UNA instancia, aquí, y pasada a todo lo que escribe en el registro.
 * El escritor lleva dentro la cadena que serializa las escrituras de `cc:logs`,
 * y dos instancias son dos cadenas ciegas la una a la otra — que es no tener
 * cadena, con el agravante de que el síntoma solo aparece bajo concurrencia.
 * Por eso `DispatcherDeps.logs` es obligatorio y ya no tiene valor por defecto:
 * así olvidarse de pasarlo no compila. Mismo motivo que `networks` y que el
 * coordinador de aprobaciones.
 */
const logs = createLogWriter(storage);

const emit = createEventEmitter(tabs, logs);
const sender = createTransactionSender();

/**
 * 🇪🇸 NOTA: UNA instancia, creada aquí y pasada al despachador. El store lleva
 * dentro la cadena que serializa las escrituras de `cc:networks`, y dos
 * instancias serían dos cadenas que no se ven entre sí — que es exactamente no
 * tener cadena. Es la misma razón por la que el coordinador de aprobaciones
 * también se construye una sola vez.
 */
const networks = createNetworkStore(storage, emit);
const permissions = createPermissionsPort();

/**
 * 🇪🇸 NOTA: UNA instancia, por lo mismo que el escritor de logs y el catálogo —
 * lleva dentro la cadena que serializa `cc:pendingTxs`. `networkFor` resuelve la
 * red por chainId contra el catálogo y devuelve null si el usuario la borró: sin
 * red no hay a quién preguntar por el recibo, y la entrada envejece hasta que el
 * descarte por antigüedad deja su línea.
 */
const pendingTxs = createPendingTxStore({
  storage,
  logs,
  notifier,
  readReceipt: fetchReceipt,
  networkFor: async (chainId) => {
    const { networks: catalogue } = await networks.read();
    return catalogue.find((entry) => entry.chainId === chainId) ?? null;
  },
});

const dispatch = createDispatcher({
  storage,
  approvals,
  emit,
  sender,
  activeOrigin,
  networks,
  logs,
  pendingTxs,
  permissions,
});

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

/**
 * ---------------------------------------------------------------------------
 * THE USER CAN REVOKE A HOST WITHOUT EVER OPENING THE WALLET
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: el camino que lo dispara es **el interruptor de Site access**, no una
 * revocación por host: `chrome://extensions` no da control por host, y la wallet
 * no puede revocar por código (comprobación 79). Mover el desplegable a "On
 * click" retira TODOS los permisos de golpe — los opcionales y también los
 * `host_permissions` del manifest.
 *
 * **Medido, no supuesto** (Chrome Stable, 10 de agosto de 2026, comprobación
 * 80): con Anvil Two activa, `contains()` pasó a false, este listener disparó y
 * el worker registró el aviso de abajo. No es código muerto.
 *
 * La wallet no participa en esa decisión — solo se entera por este evento, venga
 * de donde venga la retirada. Si
 * el revocado era el de la red activa, todo lo que consulte la red empieza a
 * fallar y el popup no tendría cómo explicarlo: las cuentas siguen ahí, la red
 * sigue en el selector, y los saldos simplemente no llegan.
 *
 * Que las redes afectadas se vean como no usables no necesita nada aquí: se
 * deriva al construir el snapshot. Lo que sí necesita una acción es la red
 * ACTIVA, porque dejarla puesta convierte la wallet en algo que no funciona sin
 * decir por qué.
 *
 * No se filtra por qué origen se revocó. `fallbackIfUnusable` vuelve a
 * preguntar por el permiso de la red activa, que es la única fuente que el
 * spike demostró fiable — el `permissions` que llega en el evento describe lo
 * que se quitó, no lo que queda.
 */
chrome.permissions.onRemoved.addListener((removed) => {
  if (removed.origins === undefined || removed.origins.length === 0) return;

  void networks
    .fallbackIfUnusable((network) => hasPermissionFor(permissions, network.rpcUrl))
    .then((movedTo) => {
      if (movedTo !== null) {
        console.warn(`[${PROTOCOL}] a revoked host permission moved the wallet to ${movedTo}`);
      }
    })
    .catch((cause: unknown) => {
      console.error(`[${PROTOCOL}] could not react to a revoked permission:`, cause);
    });
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
const badge = createBadge(storage, {
  setText: (text) => chrome.action.setBadgeText({ text }),
  setBackgroundColor: (color) => chrome.action.setBadgeBackgroundColor({ color }),
});

/**
 * 🇪🇸 NOTA: el color, UNA vez y aquí. Antes se pintaba dentro del refresco y solo
 * cuando había texto, así que se reescribía el mismo valor en cada cambio de
 * `cc:pendingRequests`. No depende de cuántas solicitudes haya: es constante.
 */
void badge.paintBackground().catch((cause: unknown) => {
  console.error(`[${PROTOCOL}] could not colour the badge:`, cause);
});

void badge.refresh().catch((cause: unknown) => {
  console.error(`[${PROTOCOL}] could not restore the badge:`, cause);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || changes["cc:pendingRequests"] === undefined) return;

  void badge.refresh().catch((cause: unknown) => {
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
// Pending transactions — the wait that lives on disk
// ============================================================================

const txWatcher = createTxWatcher({
  pendingTxs,
  alarms: {
    create: async (name, info) => {
      await chrome.alarms.create(name, info);
    },
    clear: async (name) => {
      await chrome.alarms.clear(name);
    },
  },
});

/**
 * ---------------------------------------------------------------------------
 * RE-ARMED ON EVERY START, BECAUSE ALARMS DO NOT RELIABLY SURVIVE THE WORKER
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: la documentación de Chrome lo dice sin rodeos — *"it is best to make
 * sure important alarms exist each time your service worker starts up"*. Una
 * alarma no es estado del que uno pueda fiarse entre reinicios del worker.
 *
 * Sin este barrido, un worker que muriera con transacciones en vuelo las dejaría
 * SIN VIGILAR PARA SIEMPRE: la alarma no vuelve sola, nadie pregunta por el
 * recibo, y el usuario no recibe el aviso de algo que sí se minó. Y no habría
 * ningún error en ninguna parte.
 *
 * `sweep` hace las dos mitades a la vez: pregunta por lo que hubiera pendiente
 * —que es justo el caso del despertar— y deja la alarma acorde con lo que quede.
 */
void txWatcher.sweep().catch((cause: unknown) => {
  console.error(`[${PROTOCOL}] could not resolve pending transactions on startup:`, cause);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TX_ALARM) return;

  void txWatcher.sweep().catch((cause: unknown) => {
    console.error(`[${PROTOCOL}] could not resolve pending transactions:`, cause);
  });
});

/**
 * 🇪🇸 NOTA: se cuelga del CAMBIO EN STORAGE y no de una llamada desde el
 * despachador, por el mismo motivo que el badge: es el punto por el que pasan
 * todos los caminos que crean trabajo nuevo, incluida la transferencia interna
 * de la Fase 9 y cualquier otro que aparezca después. Colgarlo del despachador
 * obligaría a cada camino nuevo a acordarse.
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || changes["cc:pendingTxs"] === undefined) return;

  const now = changes["cc:pendingTxs"].newValue as Record<string, unknown> | undefined;

  /**
   * 🇪🇸 NOTA: la clave se vació o desapareció. Pasa al resolverse la última
   * transacción —donde `sweep` ya habrá desarmado— pero TAMBIÉN al hacer un
   * reset, que borra la clave sin pasar por ninguna reconciliación. Sin esto, la
   * alarma seguía armada vigilando algo que ya no existe hasta que se disparaba
   * sola y se daba cuenta.
   */
  if (now === undefined || Object.keys(now).length === 0) {
    void txWatcher.standDown().catch((cause: unknown) => {
      console.error(`[${PROTOCOL}] could not stand down the transaction alarm:`, cause);
    });
    return;
  }

  void txWatcher.noteNewWork().catch((cause: unknown) => {
    console.error(`[${PROTOCOL}] could not start watching a transaction:`, cause);
  });
});

/**
 * ---------------------------------------------------------------------------
 * CLICKING THE TOAST FOCUSES. IT NEVER OPENS.
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: la ventana que corresponde a esa solicitud ya está abierta, así que
 * lo único que hay que hacer es traerla al frente. Crear una segunda para la
 * misma solicitud daría dos ventanas pidiendo la misma decisión, y aprobar en
 * una dejaría la otra huérfana diciendo que la solicitud ya no espera.
 *
 * Y si la solicitud YA NO ESTÁ —el usuario cerró la ventana, o caducó— el click
 * no hace nada. Cerrar la ventana ya la rechazó con 4001 (lo caza el
 * `onDisconnect` del puerto de abajo, no `windows.onRemoved`), así que
 * reabrirla sería pedirle al usuario que decida otra vez algo ya decidido.
 *
 * El aviso puede sobrevivir a su solicitud: `clear` se llama al resolver, pero
 * si el worker murió antes, el toast se queda en pantalla. Por eso este camino
 * tiene que tolerar que no haya nada al otro lado.
 */
chrome.notifications.onClicked.addListener((notificationId) => {
  const requestId = requestIdFromNotification(notificationId);
  if (requestId === null) return;

  void approvals.focusWindow(requestId).catch((cause: unknown) => {
    console.error(`[${PROTOCOL}] could not focus the window of a notification:`, cause);
  });
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
 *
 * ---------------------------------------------------------------------------
 * LÍMITE CONOCIDO: CON EL WORKER MUERTO, CERRAR LA VENTANA NO RECHAZA NADA
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: encontrado en la **comprobación manual 89** (Chrome, 18/08/2026).
 *
 * Este mecanismo depende de que haya un puerto vivo que se desconecte. Si Chrome
 * ya suspendió el worker, **no hay puerto que caiga**, así que cerrar
 * `notification.html` con la X no produce el `4001`. La solicitud se queda en
 * `cc:pendingRequests` hasta caducar.
 *
 * Y lo que lo hace peor que un residuo: **la dApp no recibe NADA**. Se comprobó
 * con los dos `.catch()` puestos en la página, y ninguno imprimió. Su promesa
 * queda colgada los 120 s completos, con la UI en "esperando confirmación" y sin
 * nada que la saque de ahí.
 *
 * El puerto sigue siendo la elección correcta —cubre además que la página
 * crashee o navegue, que `chrome.windows.onRemoved` no cubre— pero tiene este
 * suelo, y el suelo es el ciclo de vida del propio worker.
 *
 * ---------------------------------------------------------------------------
 * PREGUNTA ABIERTA, ANOTADA SIN RESPONDER
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: la caducidad limpia el estado interno —`approvals.read()` descarta lo
 * expirado— pero **no avisa a nadie**. ¿Debería la reconciliación de arranque
 * rechazar explícitamente las caducadas con `4001` en vez de descartarlas en
 * silencio?
 *
 * A favor: hoy la dApp espera 120 s sin recibir nada, y el worker que arranca
 * SABE que esa solicitud murió.
 * En contra: a los 120 s la dApp ya recibió su rechazo por el temporizador —
 * salvo que el worker muriera antes de que saltara, que es justo este caso.
 *
 * No se responde aquí porque depende de si el temporizador sobrevivió, y eso
 * hay que medirlo antes de decidir. Ver también la nota del código del timeout
 * en `lib/approvals.ts`, que es la otra mitad de este problema.
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
