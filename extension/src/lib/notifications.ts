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

/** The request a notification belongs to, or null if the toast is not ours. */
export function requestIdFromNotification(notificationId: string): RequestId | null {
  return notificationId.startsWith(NOTIFICATION_PREFIX)
    ? notificationId.slice(NOTIFICATION_PREFIX.length)
    : null;
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
  };
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
};
