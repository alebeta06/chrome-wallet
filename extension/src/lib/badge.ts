/**
 * @file lib/badge.ts
 * @description How many requests are waiting for the user, as a badge string.
 *
 * ---------------------------------------------------------------------------
 * DERIVED FROM STORAGE, NEVER COUNTED BY HAND
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: la tentación es llevar un contador y sumarle uno al crear y restarle
 * uno al resolver. Eso tiene dos formas de romperse, y las dos pasan:
 *
 *   1. El service worker se duerme y se lleva el contador. Al despertar, el
 *      badge dice lo que dijera la última vez — normalmente nada — mientras hay
 *      una ventana de aprobación abierta esperando.
 *   2. Cualquier rama que resuelva una solicitud y se olvide de restar deja el
 *      badge con un número que no baja nunca.
 *
 * Derivarlo de `cc:pendingRequests` hace que las dos desaparezcan: es correcto
 * por construcción tras un despertar, y no hay ninguna rama que actualizar
 * porque el propio storage es lo que dispara el recálculo.
 */

import type { PendingRequest, RequestId } from "@/types/messages";

import type { WalletStorage } from "./storage";

/**
 * 🇪🇸 NOTA: cuenta solo las VIVAS. Una solicitud caducada sigue en storage hasta
 * que algo la lee y la descarta (ver `approvals.ts`), así que contarlas todas
 * dejaría el badge con un número fantasma después de un timeout.
 *
 * ---------------------------------------------------------------------------
 * LÍMITE CONOCIDO: ESTO ES CORRECTO Y AUN ASÍ EL BADGE SE QUEDA OBSOLETO
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: encontrado en la **comprobación manual 89** (Chrome, 18/08/2026). El
 * badge mostró `1` con CERO solicitudes vivas. Se reprodujo cerrando una ventana
 * de aprobación con el worker muerto: la solicitud no se rechazó, caducó a los
 * 120 s, y el badge se quedó con el número anterior.
 *
 * **La hipótesis natural es falsa, y se descartó midiendo.** No es que esta
 * función cuente mal las caducadas: se inyectó una entrada con `expiresAt: 0` y
 * el badge quedó **vacío**, no en `1`. La derivación de aquí es correcta.
 *
 * **El fallo está en el DISPARO, no en el cálculo.** `refreshBadge()` se invoca
 * desde `chrome.storage.onChanged` sobre `cc:pendingRequests` — y **una
 * caducidad no es una escritura**. El tiempo pasa, `expiresAt` se queda atrás,
 * nadie toca storage, no hay evento, y nadie recalcula.
 *
 * **Por qué no se arregla en la Fase 9.** Se autocorrige con cualquier escritura
 * posterior y al arrancar el worker, así que la ventana está acotada y el
 * síntoma es cosmético. Y las dos salidas cuestan:
 *
 *   - un temporizador que despierte al worker cuando expire la siguiente
 *     solicitud mete estado temporal exactamente donde MV3 más muerde — es la
 *     lección de la Fase 6 con otro disfraz;
 *   - recalcular al leer ya se hace, pero solo cuando alguien lee, que es
 *     justamente lo que no ocurre con el popup cerrado.
 *
 * No es una línea, así que no se improvisa al final de una fase. Queda escrito
 * aquí, que es donde lo va a leer quien toque esto.
 */
export function pendingBadgeText(
  pending: Record<RequestId, PendingRequest> | undefined,
  now: number,
): string {
  const live = Object.values(pending ?? {}).filter((request) => request.expiresAt > now);

  if (live.length === 0) return "";
  // Two digits is all the badge shows legibly at 19px.
  return live.length > 9 ? "9+" : String(live.length);
}

/** The two things this module uses from chrome.action. */
export interface BadgePort {
  setText(text: string): Promise<void>;
  setBackgroundColor(color: string): Promise<void>;
}

export const BADGE_COLOR = "#7c5cff";

export interface Badge {
  /** Recomputes the text from storage and writes it. */
  refresh(): Promise<void>;
  /** The colour. Called once when the worker starts, and never again. */
  paintBackground(): Promise<void>;
}

/**
 * ---------------------------------------------------------------------------
 * THE COLOUR IS NOT PART OF THE REFRESH, AND THE PORT IS NOT DECORATION
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: dos cosas que antes vivían sueltas en `background.ts`.
 *
 * El COLOR se pintaba dentro del refresco, condicionado a que hubiera texto. Es
 * una propiedad constante del badge: no depende de cuántas solicitudes haya, así
 * que se fija una vez al arrancar y ya. Colgarlo del refresco lo convierte en
 * una llamada a `chrome.*` en cada cambio de `cc:pendingRequests` para volver a
 * escribir exactamente el mismo valor.
 *
 * Y el PUERTO existe por lo mismo que `TabsPort` o `ApprovalWindows`: sin él,
 * "leer storage y derivar el texto" no era comprobable en ningún sitio. La
 * derivación pura tenía sus tests desde la Fase 6; lo que NADIE probaba era el
 * camino entero, que es justo el que importa al despertar el worker.
 *
 * El texto del badge es estado del NAVEGADOR y sobrevive a la muerte del service
 * worker. Si al arrancar nadie lo recalcula, se queda enseñando el número de
 * algo que se resolvió mientras el worker estaba dormido — la wallet diciendo
 * "tienes dos cosas esperando" sin que haya ninguna.
 */
export function createBadge(
  storage: WalletStorage,
  port: BadgePort,
  now: () => number = () => Date.now(),
): Badge {
  return {
    async refresh(): Promise<void> {
      await port.setText(pendingBadgeText(await storage.get("cc:pendingRequests"), now()));
    },

    async paintBackground(): Promise<void> {
      await port.setBackgroundColor(BADGE_COLOR);
    },
  };
}
