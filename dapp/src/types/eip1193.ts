/**
 * @file types/eip1193.ts
 * @description What a dApp knows about a wallet: EIP-1193 and EIP-6963.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IMPORTED FROM THE EXTENSION
 * ---------------------------------------------------------------------------
 * The extension declares most of these shapes too, in its own contract file.
 * That is not duplication to be factored out: it is two independent
 * implementations of the same PUBLIC STANDARD, which is exactly how it works
 * with any wallet you did not write.
 *
 * 🇪🇸 NOTA: una dApp de verdad no comparte código con la wallet. Conoce
 * EIP-1193 y EIP-6963 —que son públicos— y nada más. Si esta dApp importara los
 * tipos internos de la extensión (`InternalRpcMap`, `PendingRequest`,
 * `StorageSchema`), el código estaría MINTIENDO sobre el acoplamiento real:
 * daría a entender que la página sabe cómo funciona la wallet por dentro,
 * cuando lo único que puede hacer es mandar `request()` y esperar.
 *
 * La prueba de que la separación es honesta: este archivo sería idéntico si la
 * dApp estuviera escrita contra MetaMask. Y si un día la superficie pública de
 * la extensión cambiara, esta dApp se rompería en runtime — que es justo lo que
 * pasaría con una wallet de terceros. El acoplamiento se ve porque no se
 * esconde detrás de un import.
 */

// ============================================================================
// EIP-6963 — multi-wallet discovery
// ============================================================================

/** https://eips.ethereum.org/EIPS/eip-6963 */
export interface EIP6963ProviderInfo {
  /** Stable per wallet installation. A new one on every page load means a bug. */
  uuid: string;
  name: string;
  /** Data URI. Rendered in an <img>, so a malformed one shows as a broken image. */
  icon: string;
  /** Reverse-DNS id of the wallet, e.g. "io.metamask". The stable identity. */
  rdns: string;
}

export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: EIP1193Provider;
}

export const EIP6963_ANNOUNCE = "eip6963:announceProvider";
export const EIP6963_REQUEST = "eip6963:requestProvider";

// ============================================================================
// EIP-1193 — the provider itself
// ============================================================================

export interface RequestArguments {
  method: string;
  params?: unknown[];
}

export type ProviderEventListener = (data: unknown) => void;

/** https://eips.ethereum.org/EIPS/eip-1193 */
export interface EIP1193Provider {
  request(args: RequestArguments): Promise<unknown>;
  on(eventName: string, listener: ProviderEventListener): unknown;
  removeListener(eventName: string, listener: ProviderEventListener): unknown;
}

/**
 * The events a provider may emit.
 *
 * 🇪🇸 NOTA: hasta la Fase 5 ninguno de estos llega, porque no hay permisos por
 * origen ni cambio de red desde la dApp. El panel se cablea igual: un canal que
 * se conecta el día que hay algo que enviar es un canal que nadie ha probado.
 */
export const PROVIDER_EVENTS = [
  "accountsChanged",
  "chainChanged",
  "connect",
  "disconnect",
] as const;

export type ProviderEventName = (typeof PROVIDER_EVENTS)[number];

/**
 * An EIP-1193 rejection: a real Error carrying a numeric `code`.
 *
 * 🇪🇸 NOTA: el `code` es el contrato de errores. Sin él una dApp no puede
 * distinguir "el usuario canceló" (4001) —que no es un fallo y no merece un
 * mensaje de error rojo— de "esto ha petado" (-32603).
 */
export interface ProviderRpcError extends Error {
  code: number;
  data?: unknown;
}

// ============================================================================
// The one thing this dApp knows about CodeCrypto specifically
// ============================================================================

/**
 * 🇪🇸 NOTA: una constante, no un import. Es el mismo conocimiento que tiene
 * cualquier dApp que escribe `io.metamask` para destacar MetaMask en su
 * selector: el rdns es público y forma parte del anuncio. Que sea un string
 * suelto y no un tipo importado es la diferencia entre "reconozco esta wallet"
 * y "estoy acoplado a su código".
 */
export const CODECRYPTO_RDNS = "academy.codecrypto.wallet";
