/**
 * @file lib/errors.ts
 * @description Turns an EIP-1193 rejection into something a person can read.
 *
 * 🇪🇸 NOTA: mostrar el JSON crudo del error es la salida fácil y es mala UX. El
 * usuario que cancela una firma no ha provocado un fallo —4001 es el sistema
 * funcionando— y merece leer "cancelaste la petición", no un objeto con un
 * número negativo dentro. El código se enseña igual, en pequeño, porque es lo
 * que hace falta para reportar un problema.
 *
 * Este mapa crece en cada fase: la 5 trae el 4001 y el 4100 de verdad, la 6 los
 * de firma, la 8 el 4902 al cambiar de red.
 */

import type { ProviderRpcError } from "@/types/eip1193";

export const PROVIDER_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  4001: "You rejected the request in your wallet.",
  4100: "This site has not been authorized to make that request.",
  4200: "This wallet does not support that method yet.",
  4900: "The wallet is disconnected. Reload the page and try again.",
  4901: "The wallet cannot reach that network's RPC endpoint.",
  4902: "The wallet does not recognise that network.",
  [-32602]: "The request was made with invalid parameters.",
  [-32603]: "The wallet ran into an internal error.",
};

export interface DisplayError {
  /** null when whatever was thrown carried no EIP-1193 code. */
  code: number | null;
  /** The human sentence. Always present. */
  title: string;
  /** What the wallet actually said. May repeat the title for unmapped codes. */
  detail: string;
}

/**
 * Did the user simply say no?
 *
 * 🇪🇸 NOTA: 4001 NO es un fallo y no merece un banner rojo. El usuario pulsó
 * "rechazar" y el sistema hizo exactamente lo que le pidió; enseñarle un error
 * por ello es culparle de haber usado bien la wallet. La dApp vuelve al botón de
 * conectar y no dice nada.
 *
 * El timeout de la ventana de aprobación también llega como 4001 —a propósito—
 * porque la reacción correcta es la misma.
 */
export function isUserRejection(cause: unknown): boolean {
  return describeProviderError(cause).code === 4001;
}

/**
 * 🇪🇸 NOTA: la comprobación es `typeof code === "number"` y no `instanceof
 * Error`. El error cruza dos boundaries antes de llegar aquí (el service worker
 * lo serializa, `inject.ts` lo reconstruye), y aunque la extensión sí devuelve
 * un Error de verdad, una dApp no puede darlo por hecho de ninguna wallet. Lo
 * que importa es que traiga un `code` numérico, no de qué clase sea.
 */
function readCode(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) return null;
  const { code } = cause as Partial<ProviderRpcError>;
  return typeof code === "number" ? code : null;
}

function readMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (typeof cause === "string" && cause.length > 0) return cause;
  return "The wallet gave no further detail.";
}

export function describeProviderError(cause: unknown): DisplayError {
  const code = readCode(cause);
  const detail = readMessage(cause);

  if (code === null) {
    return { code: null, title: "Something went wrong talking to the wallet.", detail };
  }

  return {
    code,
    // An unmapped code is still shown honestly rather than swallowed: a new
    // code appearing is information, not something to hide behind "unknown".
    title: PROVIDER_ERROR_MESSAGES[code] ?? `The wallet answered with code ${code}.`,
    detail,
  };
}
