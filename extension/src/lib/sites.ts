/**
 * @file lib/sites.ts
 * @description The per-origin account model, as pure functions.
 *
 * 🇪🇸 NOTA: esto es el Modelo B —cuenta por origen— convertido en código. Cada
 * dApp conectada tiene SU cuenta, independiente de las demás y de la cuenta por
 * defecto de la wallet. Vercel puede estar en la cuenta 3 mientras localhost
 * está en la 1, a la vez, y ninguna de las dos se entera de la otra.
 *
 * Todo lo de aquí recibe el mapa de sitios y devuelve uno nuevo: nada lee
 * storage y nada escribe. Eso hace que el modelo entero se pueda probar sin
 * navegador, que es donde se comprueba que no se filtra nada entre orígenes.
 */

import {
  resolveAccountForOrigin,
  type ConnectedSite,
  type Origin,
} from "@/types/messages";

export type ConnectedSites = Record<Origin, ConnectedSite>;

/**
 * Which account index this origin sees, or null if it sees none.
 *
 * ---------------------------------------------------------------------------
 * AN OUT-OF-RANGE INDEX MEANS "NOT CONNECTED", NOT "ACCOUNT 0"
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: el caso es real — conectas un sitio a la cuenta 4, reseteas, y
 * reimportas con 2 cuentas. El índice guardado apunta a la nada.
 *
 * La tentación es acotarlo a 0, como hace `clampAccountIndex` con la cuenta por
 * defecto. Aquí sería un error grave, y la diferencia es QUÉ representa cada
 * índice. La cuenta por defecto es una preferencia interna: acotarla solo
 * cambia una preselección. El índice de un origen es una IDENTIDAD que una web
 * ya ha visto: la dApp enseñó "tu cuenta es 0x90F7…", y acotar a 0 la haría
 * operar como 0xf39F… sin que nada se lo dijera ni a ella ni al usuario.
 *
 * Devolver null obliga a reconectar. Es más molesto y es lo correcto: sustituir
 * una identidad en silencio es exactamente el fallo que el modelo por origen
 * existe para no tener.
 *
 * Y es una LECTURA: no borra el registro. Un `get` que muta storage convierte
 * cualquier consulta en una escritura, y con el service worker durmiéndose y
 * despertándose eso es una fuente de carreras que no hace falta tener.
 */
export function resolveSiteAccount(
  sites: ConnectedSites | undefined,
  origin: Origin,
  accountCount: number,
): number | null {
  const index = resolveAccountForOrigin(sites ?? {}, origin);

  if (index === null) return null;
  if (!Number.isInteger(index) || index < 0 || index >= accountCount) return null;

  return index;
}

/** Origins with a usable account right now. Used to decide who hears an event. */
export function usableSites(sites: ConnectedSites | undefined, accountCount: number): ConnectedSites {
  const usable: ConnectedSites = {};

  for (const [origin, site] of Object.entries(sites ?? {})) {
    if (resolveSiteAccount(sites, origin, accountCount) !== null) usable[origin] = site;
  }

  return usable;
}

/**
 * Connects an origin, or moves an already-connected one to another account.
 *
 * 🇪🇸 NOTA: `connectedAt` se conserva al reconectar; solo `lastUsedAt` se mueve.
 * Saber desde cuándo un sitio tiene acceso es justo el dato que uno quiere al
 * revisar la lista de sitios conectados, y pisarlo en cada cambio de cuenta lo
 * destruiría.
 */
export function connectSite(
  sites: ConnectedSites | undefined,
  origin: Origin,
  accountIndex: number,
  now: number,
): ConnectedSites {
  const existing = (sites ?? {})[origin];

  return {
    ...(sites ?? {}),
    [origin]: {
      origin,
      accountIndex,
      connectedAt: existing?.connectedAt ?? now,
      lastUsedAt: now,
    },
  };
}

/** Removes an origin. Returns the same object when there was nothing to remove. */
export function disconnectSite(
  sites: ConnectedSites | undefined,
  origin: Origin,
): ConnectedSites {
  const current = sites ?? {};
  if (!(origin in current)) return current;

  const next = { ...current };
  delete next[origin];
  return next;
}
