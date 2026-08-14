/**
 * @file lib/notifications.ts
 * @description Desktop toasts for a request that is waiting for the user.
 *
 * ---------------------------------------------------------------------------
 * COURTESY, NEVER MECHANISM
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: esto es un aviso, no una pieza del flujo. **El mecanismo es la
 * ventana de aprobación**, que se abre siempre y por su cuenta.
 *
 * El motivo es concreto y comprobable: si el usuario tiene las notificaciones
 * desactivadas a nivel de SISTEMA OPERATIVO, `chrome.notifications.create` no
 * lanza ni devuelve error — no pasa nada y ya. No hay forma de saber desde aquí
 * si el aviso salió. Cualquier paso del flujo que dependiera de él estaría
 * dependiendo de algo que puede no ocurrir sin avisar de que no ocurrió.
 *
 * Consecuencia práctica: TODAS las llamadas van envueltas y ninguna propaga su
 * fallo. Que no se pueda avisar no puede impedir firmar.
 *
 * ---------------------------------------------------------------------------
 * THE ID IS THE REQUEST ID, AND THAT IS WHAT MAKES clear() POSSIBLE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: crear, cerrar y el click usan la MISMA función para construir el id.
 * Si cada sitio lo compusiera a mano, un día uno de los tres cambiaría el
 * prefijo y el síntoma sería una notificación que no se cierra nunca: la
 * solicitud se firma, el toast se queda en pantalla, y el usuario tiene avisos
 * de operaciones ya resueltas. Nada fallaría por eso.
 *
 * El prefijo existe porque el espacio de ids de `chrome.notifications` es de
 * toda la extensión. Sin él, un id nuestro podría chocar con uno de otra
 * funcionalidad futura.
 */

import type { PendingKind, RequestId } from "@/types/messages";

const NOTIFICATION_PREFIX = "codecrypto:";

/** PNG raster, never the SVG — see the note in `background.ts`. */
export const NOTIFICATION_ICON = "icons/icon-128.png";

export const NOTIFICATION_TEXT: Record<PendingKind, { title: string; message: string }> = {
  connect: { title: "Connection request", message: "A site wants to connect to your wallet." },
  signature: { title: "Signature request", message: "A site is asking you to sign a transaction." },
  "add-chain": { title: "Network request", message: "A site wants to add a network." },
};

export function notificationIdFor(requestId: RequestId): string {
  return `${NOTIFICATION_PREFIX}${requestId}`;
}

/**
 * 🇪🇸 NOTA: espacio de ids SEPARADO del de las solicitudes. Si un aviso de
 * minado compartiera espacio con uno de aprobación, el `clear` que se dispara al
 * resolver una solicitud podría llevarse por delante el de una transacción — y
 * al revés. Son dos ciclos de vida distintos: el de la solicitud lo cierra la
 * decisión del usuario, el del minado no lo cierra nadie.
 */
const TX_PREFIX = `${NOTIFICATION_PREFIX}tx:`;

export function transactionNotificationId(hash: string): string {
  return `${TX_PREFIX}${hash}`;
}

/**
 * The request a notification belongs to, or null if the toast is not ours.
 *
 * 🇪🇸 NOTA: los avisos de transacción se descartan EXPLÍCITAMENTE, y no es
 * cosmético: `codecrypto:tx:0x…` empieza por el mismo prefijo, así que sin esta
 * comprobación esta función devolvería `"tx:0x…"` como si fuera un requestId.
 * El síntoma sería mudo —`focusWindow` no encontraría esa solicitud y no haría
 * nada— que es justo el tipo de fallo que se queda años.
 */
export function requestIdFromNotification(notificationId: string): RequestId | null {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return null;
  if (notificationId.startsWith(TX_PREFIX)) return null;

  return notificationId.slice(NOTIFICATION_PREFIX.length);
}

/** What this module uses from chrome.notifications, and nothing more. */
export interface NotificationsPort {
  create(id: string, options: { title: string; message: string; iconUrl: string }): Promise<void>;
  clear(id: string): Promise<void>;
}

export interface Notifier {
  /** Announces a brand new request. Runs once per request, never for a duplicate. */
  announce(requestId: RequestId, kind: PendingKind): Promise<void>;
  /**
   * Takes the toast down once the request is settled, whichever way it settled.
   *
   * 🇪🇸 NOTA: sin esto quedan notificaciones huérfanas de operaciones ya
   * firmadas. Y se llama SIEMPRE al resolver, no solo cuando había ventana que
   * cerrar: si el worker murió antes de registrar el `windowId`, el toast existe
   * igual y nadie lo recogería.
   */
  dismiss(requestId: RequestId): Promise<void>;
  /**
   * Tells the user a transaction was mined, and whether it did what it was for.
   *
   * 🇪🇸 NOTA: una transacción REVERTIDA está minada. Gastó gas y está en la
   * cadena, así que el aviso no puede decir lo mismo que el de una que fue bien
   * — pero tampoco es un fallo de la wallet. Se avisa de las dos, con texto
   * distinto.
   */
  announceTransaction(hash: string, confirmed: boolean): Promise<void>;
}

export function createNotifier(port: NotificationsPort): Notifier {
  return {
    async announce(requestId, kind): Promise<void> {
      const { title, message } = NOTIFICATION_TEXT[kind];

      try {
        await port.create(notificationIdFor(requestId), {
          title,
          message,
          iconUrl: NOTIFICATION_ICON,
        });
      } catch (cause) {
        console.error("[codecrypto] could not show a notification:", cause);
      }
    },

    async dismiss(requestId): Promise<void> {
      try {
        await port.clear(notificationIdFor(requestId));
      } catch (cause) {
        console.error("[codecrypto] could not clear a notification:", cause);
      }
    },

    async announceTransaction(hash, confirmed): Promise<void> {
      const { title, message } = confirmed ? TX_CONFIRMED : TX_REVERTED;

      try {
        await port.create(transactionNotificationId(hash), {
          title,
          message: `${message} ${shortenHash(hash)}`,
          iconUrl: NOTIFICATION_ICON,
        });
      } catch (cause) {
        console.error("[codecrypto] could not announce a transaction:", cause);
      }
    },
  };
}

const TX_CONFIRMED = { title: "Transaction confirmed", message: "Mined successfully:" };

/**
 * 🇪🇸 NOTA: "reverted", no "failed". La transacción llegó a la cadena y se
 * ejecutó; lo que pasó es que revirtió. Decir "failed" mezclaría este caso con
 * "no se pudo enviar", que es otro problema con otra solución.
 */
const TX_REVERTED = { title: "Transaction reverted", message: "Mined, but it reverted:" };

/** A toast is not the place for 66 characters of hexadecimal. */
function shortenHash(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/**
 * Inert notifier, for tests that care about the approval mechanism.
 *
 * 🇪🇸 NOTA: igual que `NO_LOGS` en `events.ts`, **la inercia ES la propiedad**.
 * Este cuerpo está vacío y tiene que seguir estándolo: en el momento en que
 * haga algo —guardar ids, escribir en consola— deja de ser inofensivo como valor
 * por defecto y hay que pasarlo explícitamente. Si alguna vez necesita hacer
 * algo, la respuesta es quitar el valor por defecto, no rellenarlo.
 */
export const NO_NOTIFIER: Notifier = {
  announce: () => Promise.resolve(),
  dismiss: () => Promise.resolve(),
  announceTransaction: () => Promise.resolve(),
};
