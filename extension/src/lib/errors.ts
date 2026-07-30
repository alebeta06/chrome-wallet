/**
 * @file lib/errors.ts
 * @description The one place where a thrown value becomes a wire error.
 *
 * types/messages.ts defines errors as PLAIN OBJECTS on purpose: neither
 * chrome.runtime messaging nor window.postMessage preserve Error subclasses.
 * Inside the background, though, throwing is the natural control flow. This
 * module bridges the two: `ProviderError` to throw, `toSerializedError` to
 * translate at the boundary.
 */

import { ErrorCode, ProviderErrors, type SerializedProviderError } from "@/types/messages";

/** A failure that is already expressed in the protocol's own vocabulary. */
export class ProviderError extends Error {
  readonly serialized: SerializedProviderError;

  constructor(serialized: SerializedProviderError) {
    super(serialized.message);
    this.name = "ProviderError";
    this.serialized = serialized;
  }
}

/** Shorthand for the most common validation failure. */
export function invalidParams(message: string): ProviderError {
  return new ProviderError(ProviderErrors.invalidParams(message));
}

/**
 * A JSON-safe view of an unknown thrown value.
 *
 * 🇪🇸 NOTA: chrome.runtime serializa los mensajes a JSON, no hace structured
 * clone. Un objeto Error metido tal cual en `data` llega al otro lado como `{}`
 * — name, message y stack son propiedades no enumerables. Por eso se copian a
 * mano a un objeto plano en vez de reenviar el Error original.
 */
function describeUnknown(cause: unknown): { name: string; message: string; stack?: string } {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message, stack: cause.stack };
  }
  return { name: typeof cause, message: String(cause) };
}

/**
 * Translates anything thrown inside the background into a wire error.
 *
 * A `ProviderError` is already protocol vocabulary and passes through unchanged
 * in both directions. Anything else is a bug or an unexpected failure from a
 * dependency, and how much of it travels depends on WHO asked:
 *
 *   fromPage === true   a web page is asking. Generic -32603, no detail.
 *   fromPage === false  our own UI is asking. Real message plus a plain-object
 *                       copy of the original in `data`.
 *
 * 🇪🇸 NOTA: la asimetría es el punto. Redactar hacia una dApp es correcto —
 * el mensaje de un error interno puede describir estructura interna, rutas o
 * estado. Redactar hacia la UI propia solo consigue que el fallo se vea en una
 * consola y haya que ir a buscar la causa a otra. `classifySender` ya distingue
 * las dos, así que la distinción no cuesta nada.
 *
 * El console.error se hace SIEMPRE, en los dos casos: la consola del service
 * worker es el registro completo, pase lo que pase por el cable.
 */
export function toSerializedError(cause: unknown, fromPage: boolean): SerializedProviderError {
  if (cause instanceof ProviderError) return cause.serialized;

  console.error("[codecrypto] unexpected error while handling an RPC request:", cause);

  if (fromPage) return ProviderErrors.internal();

  const detail = describeUnknown(cause);
  return { code: ErrorCode.INTERNAL, message: detail.message, data: detail };
}
