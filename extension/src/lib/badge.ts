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

/**
 * 🇪🇸 NOTA: cuenta solo las VIVAS. Una solicitud caducada sigue en storage hasta
 * que algo la lee y la descarta (ver `approvals.ts`), así que contarlas todas
 * dejaría el badge con un número fantasma después de un timeout.
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
