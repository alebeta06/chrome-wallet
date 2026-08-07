/**
 * @file lib/network-rpc.ts
 * @description The network RPC methods, kept out of dispatch.ts.
 *
 * 🇪🇸 NOTA: esto vive aparte porque `dispatch.ts` ya pasa de las mil líneas y el
 * proyecto pide archivos por debajo de quinientas. El despachador se queda con
 * un `case` fino por método y la decisión está aquí, donde además se prueba sin
 * construir un despachador entero.
 */

import { ErrorCode, ProviderErrors, type Hex, type NetworkConfig } from "@/types/messages";

import { ProviderError, invalidParams } from "./errors";
import type { NetworkStore } from "./network-store";
import { canonicalChainId, findNetwork } from "./networks";
import { hasPermissionFor, type PermissionsPort } from "./permissions";

export interface NetworkRpcDeps {
  networks: NetworkStore;
  permissions: PermissionsPort;
}

/**
 * Reads the `chainId` out of `[{ chainId }]`.
 *
 * ---------------------------------------------------------------------------
 * A NON-CANONICAL SPELLING IS ACCEPTED, NOT REFUSED
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: `0x01` se canonicaliza a `0x1` y se busca así, en vez de responder
 * -32602. Es la misma cadena, y una dApp que la escriba con un cero delante no
 * está pidiendo nada raro — está escribiendo el mismo número de otra forma.
 * Rechazarla obligaría a la dApp a conocer nuestra forma canónica, que es un
 * detalle nuestro y no del estándar.
 *
 * El -32602 se reserva para lo que de verdad no es un chain id: sin `0x`, con
 * dígitos que no son hex, un número en vez de una cadena, o el cero.
 */
function parseChainIdParam(params: unknown[], method: string): Hex {
  const [raw] = params;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidParams(`${method} expects a single object parameter.`);
  }

  const { chainId } = raw as { chainId?: unknown };
  const canonical = canonicalChainId(chainId);

  if (canonical === null) {
    throw invalidParams(
      `${method} requires a "chainId" as a 0x-prefixed hexadecimal string, like "0xaa36a7".`,
    );
  }

  return canonical;
}

/**
 * 4902 for a chain we do not have, and 4902 for one we cannot reach.
 *
 * ---------------------------------------------------------------------------
 * SAME CODE, DIFFERENT MESSAGE, AND THE DIFFERENCE IS THE POINT
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: los dos son 4902 porque para la dApp la reacción correcta es la
 * misma —ofrecer `wallet_addEthereumChain`— y un código propio para el segundo
 * caso haría que las dApps que ya ramifican por 4902 no supieran qué hacer con
 * él. Lo que cambia es el mensaje, porque la causa que el usuario tiene que
 * entender es distinta: "esa red no la tengo" no se arregla igual que "esa red
 * la tengo pero me quitaste el permiso para hablar con su nodo".
 *
 * El mensaje lleva el NOMBRE de la red, nunca la rpcUrl: una URL con API key
 * dentro no tiene por qué acabar en un objeto de error que cruza hasta una
 * dApp. Mismo criterio que `chain.ts` y `signer.ts`.
 */
function unreachableChain(network: NetworkConfig): ProviderError {
  return new ProviderError({
    code: ErrorCode.UNRECOGNIZED_CHAIN,
    message:
      `CodeCrypto Wallet cannot reach "${network.name}": permission to use its RPC host ` +
      `was revoked. Add the network again to restore it.`,
  });
}

/**
 * Switches the active network. Backs both `wallet_switchEthereumChain` (from a
 * dApp) and `wallet_setActiveNetwork` (from the popup).
 *
 * 🇪🇸 NOTA: el mismo handler para los dos, igual que `handleDisconnect` sirve a
 * `wallet_revokePermissions` y a `wallet_disconnectSite`. El efecto es idéntico
 * y la diferencia —quién puede pedirlo— ya la resuelve `assertSenderMayCall` una
 * capa más arriba. Duplicarlo sería la vía rápida a que una de las dos ramas se
 * olvide de comprobar el permiso.
 *
 * ---------------------------------------------------------------------------
 * THIS DOES NOT TOUCH ACCOUNTS
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: cambiar de red no cambia ni las cuentas ni los permisos por origen,
 * así que NO se emite `accountsChanged`. En el modelo por origen la cuenta es
 * una propiedad de la relación wallet-sitio y la red es una propiedad de la
 * wallet: son ejes independientes. Emitir aquí haría que cada cambio de red
 * pareciera un cambio de cuenta y las dApps repintarían su sesión entera sin
 * motivo. Hay un test que lo fija.
 */
export async function switchChain(
  { networks, permissions }: NetworkRpcDeps,
  params: unknown[],
  method: string,
): Promise<null> {
  const chainId = parseChainIdParam(params, method);
  const { networks: catalogue } = await networks.read();

  const target = findNetwork(catalogue, chainId);
  if (target === undefined) throw new ProviderError(ProviderErrors.unrecognizedChain(chainId));

  /**
   * 🇪🇸 NOTA: el permiso se comprueba ANTES de escribir nada. Cambiar primero y
   * descubrir después que no se puede hablar con el nodo dejaría al usuario en
   * una red muerta por una llamada que además falló — y con un `chainChanged`
   * ya emitido a todas las dApps.
   */
  if (!(await hasPermissionFor(permissions, target.rpcUrl))) throw unreachableChain(target);

  /**
   * 🇪🇸 NOTA: el `false` aquí solo puede venir de que la red desapareciera entre
   * el `read()` y el `setActive()` — otra pestaña borrándola a la vez. Es la
   * misma respuesta que si no hubiera estado nunca, que es lo que la dApp
   * observa de todas formas.
   */
  if (!(await networks.setActive(chainId))) {
    throw new ProviderError(ProviderErrors.unrecognizedChain(chainId));
  }

  return null;
}
