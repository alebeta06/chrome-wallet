/**
 * @file lib/network-rpc.ts
 * @description The network RPC methods, kept out of dispatch.ts.
 *
 * 🇪🇸 NOTA: esto vive aparte porque `dispatch.ts` ya pasa de las mil líneas y el
 * proyecto pide archivos por debajo de quinientas. El despachador se queda con
 * un `case` fino por método y la decisión está aquí, donde además se prueba sin
 * construir un despachador entero.
 */

import {
  ErrorCode,
  ProviderErrors,
  type AddEthereumChainParameter,
  type Hex,
  type NetworkConfig,
  type Origin,
} from "@/types/messages";

import type { ApprovalCoordinator } from "./approvals";
import type { ChainIdReader } from "./chain";
import { ProviderError, invalidParams } from "./errors";
import type { NetworkStore } from "./network-store";
import {
  canonicalChainId,
  draftFromParameter,
  findNetwork,
  isBuiltIn,
  toNetworkConfig,
  type NetworkDraft,
  type RemovalRefusal,
} from "./networks";
import {
  hasPermissionFor,
  isRpcUrlAllowed,
  originPatternFromRpcUrl,
  revoke,
  type PermissionsPort,
} from "./permissions";

export interface SwitchChainDeps {
  networks: NetworkStore;
  permissions: PermissionsPort;
}

export interface FinaliseDeps extends SwitchChainDeps {
  readChainId: ChainIdReader;
}

export interface AddChainDeps extends FinaliseDeps {
  approvals: ApprovalCoordinator;
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
 *
 * ---------------------------------------------------------------------------
 * THE MESSAGE HAS TO SAY WHAT TO DO
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: "esa red no está disponible" no es un mensaje, es un callejón. La
 * red SÍ está en el catálogo; lo que falta es el permiso, y el usuario no tiene
 * forma de adivinar eso ni de saber que se arregla volviendo a conceder.
 *
 * Se le dice explícitamente que hace falta reconceder el permiso, y a la dApp se
 * le nombra `wallet_addEthereumChain` como la vía — que es lo mismo que ofrece
 * el otro 4902, y por eso los dos comparten código. Para que esa vía funcione de
 * verdad, el alta NO puede cortocircuitar por idempotencia cuando el permiso
 * falta: ver `addChain`.
 */
function unreachableChain(network: NetworkConfig): ProviderError {
  return new ProviderError({
    code: ErrorCode.UNRECOGNIZED_CHAIN,
    message:
      `CodeCrypto Wallet has "${network.name}" but is no longer allowed to reach its RPC ` +
      `endpoint: that permission was revoked. Grant it again — call ` +
      `wallet_addEthereumChain for this chain, or re-add it from the wallet — to use this network.`,
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
  { networks, permissions }: SwitchChainDeps,
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

// ============================================================================
// wallet_addEthereumChain
// ============================================================================

/**
 * Turns the EIP-3085 parameter into something we are willing to store, or
 * refuses with a message naming the field.
 *
 * 🇪🇸 NOTA: todo esto pasa ANTES de tocar el catálogo, la red o una ventana.
 * Una ventana que aparece para algo que la wallet ya sabe que va a rechazar
 * enseña a la gente a cerrar ventanas sin leerlas, y esa costumbre es lo que
 * hace que el phishing funcione. Mismo orden que `eth_sendTransaction`.
 */
function parseAddChainParams(params: unknown[]): NetworkDraft {
  const [raw] = params;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidParams("wallet_addEthereumChain expects a single object parameter.");
  }

  const param = raw as AddEthereumChainParameter;
  const draft = draftFromParameter(param);

  if (draft === null) {
    throw invalidParams(
      'wallet_addEthereumChain needs a hex "chainId", a non-empty "chainName", at least one ' +
        '"rpcUrls" entry, and a "nativeCurrency" with a "symbol" and integer "decimals".',
    );
  }

  /**
   * 🇪🇸 NOTA: la política del RPC va aparte del parseo y con su propio mensaje.
   * "Falta un campo" y "ese campo es http contra internet" son dos errores
   * distintos para quien depura una dApp, y colapsarlos en un -32602 genérico
   * obliga a adivinar cuál de los dos fue.
   */
  if (!isRpcUrlAllowed(draft.rpcUrl)) {
    throw invalidParams(
      'wallet_addEthereumChain requires the first "rpcUrls" entry to be https, or plain http ' +
        "only on localhost or 127.0.0.1.",
    );
  }

  return draft;
}

/** The parameter as it will be persisted, for the window to render. */
function normalisedParameter(draft: NetworkDraft): AddEthereumChainParameter {
  return {
    chainId: draft.chainId,
    chainName: draft.name,
    rpcUrls: [draft.rpcUrl],
    nativeCurrency: { ...draft.nativeCurrency },
    ...(draft.explorerUrl === null ? {} : { blockExplorerUrls: [draft.explorerUrl] }),
  };
}

/**
 * Adds a network, after the user says so and the endpoint proves who it is.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCE IS ABOUT THE DESIRED STATE, NOT ABOUT THE INPUT
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: la trampa está en la fila que no es obvia. "Mismo chainId y mismo
 * rpcUrl → devuelve null sin ventana" parece la definición de idempotente, pero
 * si el permiso está revocado la red NO está operativa: no hay nada que
 * cortocircuitar, porque el estado deseado no se ha alcanzado.
 *
 * Y el atajo cerraba un ciclo: `wallet_switchEthereumChain` responde 4902
 * diciendo "vuelve a añadirla", y el alta devolvía `null` sin reconceder nada.
 * La dApp hacía exactamente lo que se le pedía y volvía al mismo 4902 para
 * siempre. Con la reconcesión, ese consejo lleva a algún sitio.
 */
export async function addChain(
  { networks, permissions, approvals, readChainId }: AddChainDeps,
  params: unknown[],
  context: { origin: Origin; tabId?: number },
): Promise<null> {
  const draft = parseAddChainParams(params);
  const { networks: catalogue } = await networks.read();
  const existing = findNetwork(catalogue, draft.chainId);

  /**
   * ------------------------------------------------------------------------
   * A BUILT-IN IS NEVER REPOINTED, AND SAYING SO IS PART OF THE JOB
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: se rechaza en la validación, sin ventana y sin pedir permiso. Que
   * una dApp pueda hacer aparecer un diálogo nativo de Chrome con un intento
   * que no va a prosperar es ruido que no tiene por qué poder provocar.
   *
   * Y se rechaza con -32602 en vez de devolver `null` en silencio como hace
   * MetaMask: `upsertNetwork` ya lo bloquea de todas formas, así que un `null`
   * le diría a la dApp que su RPC quedó configurado cuando no es verdad. Un
   * error que se entiende vale más que un éxito que miente.
   *
   * El `console.warn` es deliberado: un intento de reapuntar "Sepolia" a otro
   * nodo es exactamente lo que se quiere ver en el registro, y es lo único que
   * distingue una dApp mal configurada de una hostil.
   */
  if (isBuiltIn(draft.chainId) && existing !== undefined) {
    if (existing.rpcUrl === draft.rpcUrl) return null;

    console.warn(
      `[codecrypto] ${context.origin} tried to repoint the built-in ${existing.name} ` +
        `at ${draft.rpcUrl}`,
    );
    throw invalidParams(
      `"${existing.name}" is built into CodeCrypto Wallet and its RPC endpoint cannot be changed.`,
    );
  }

  const permitted = await hasPermissionFor(permissions, draft.rpcUrl);

  // Already exactly what was asked for, and reachable. Nothing to decide.
  if (existing !== undefined && existing.rpcUrl === draft.rpcUrl && permitted) return null;

  /**
   * 🇪🇸 NOTA: alta, sobrescritura y reconcesión abren la MISMA ventana y
   * persisten la misma solicitud. Cuál de las tres es lo deduce la ventana
   * comparando el parámetro con `wallet_getState` —que ya le dice si la red
   * existe y si su permiso falta— así que no hace falta un campo nuevo en el
   * contrato para algo que se puede derivar de lo que ya viaja.
   */
  // Rejects with 4001 if the user says no, denies the native dialog, or closes
  // the window. The window is what calls chrome.permissions.request().
  await approvals.requestAddChain({
    origin: context.origin,
    chain: normalisedParameter(draft),
    ...(context.tabId === undefined ? {} : { tabId: context.tabId }),
  });

  await finaliseAdd({ networks, permissions, readChainId }, draft, context.origin);
  return null;
}

/**
 * Everything that has to be true before a network is stored, whoever asked.
 *
 * ---------------------------------------------------------------------------
 * WHO ASKS BRANCHES. WHAT IS VERIFIED DOES NOT
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: hay dos entradas para dar de alta una red —una dApp pidiéndolo, y el
 * usuario haciéndolo desde la propia wallet— y solo una de las dos necesita
 * ventana de aprobación. Lo que NO se bifurca es esto: que el permiso esté
 * concedido, que el endpoint demuestre qué cadena sirve, y que se le revoque el
 * permiso si mintió. Las dos rutas terminan aquí.
 *
 * Duplicar estas veinte líneas sería la vía rápida a que una de las dos se salte
 * la verificación, y la que se la saltaría es justo la que no abre ventana.
 */
export async function finaliseAdd(
  { networks, permissions, readChainId }: FinaliseDeps,
  draft: NetworkDraft,
  /**
   * Who asked, for the forensic line in `revokeAfterLie`. Required on purpose:
   * a lie has to be attributable, and an optional parameter would quietly
   * default to "nobody" at the call site that forgot it.
   */
  requester: string,
): Promise<NetworkConfig> {
  /**
   * 🇪🇸 NOTA: se pregunta por el permiso aunque quien llama crea tenerlo. Es la
   * única fuente que el spike de la Fase 8 demostró fiable, y entre la concesión
   * y este punto ha habido un salto de proceso — de la ventana al worker. Si
   * faltara, seguir adelante sería llamar al RPC sin permiso y devolver un 4901
   * que culparía al nodo de un problema nuestro.
   */
  if (!(await hasPermissionFor(permissions, draft.rpcUrl))) {
    throw new ProviderError(
      ProviderErrors.userRejected("The permission to reach that RPC endpoint was not granted."),
    );
  }

  const candidate = toNetworkConfig(draft, Date.now(), false);

  /**
   * 🇪🇸 NOTA: si el nodo no contesta se propaga el 4901 y el permiso SE
   * CONSERVA. No sabemos nada malo del endpoint —solo que ahora mismo no está—
   * y revocar por un parpadeo obligaría al usuario a pasar otra vez por el
   * diálogo nativo entero. Reintentar más tarde funciona sin segundo diálogo.
   */
  const reported = await readChainId(candidate);

  if (canonicalChainId(reported) !== draft.chainId) {
    await revokeAfterLie(permissions, draft, reported, requester);

    throw invalidParams(
      `That endpoint reports chain ${String(reported)}, not ${draft.chainId}. ` +
        "The network was not added.",
    );
  }

  await networks.upsert(candidate);

  /**
   * 🇪🇸 NOTA: NO se cambia de red y NO se emite `chainChanged`. Añadir una red
   * es ponerla en la lista, no meter al usuario en ella — MetaMask lo pregunta
   * aparte, y aquí basta con que use el selector. Cambiar de red como efecto
   * secundario de un alta movería al usuario a una cadena recién aprobada sin
   * que lo haya pedido.
   */
  return candidate;
}

/**
 * The wallet's own add: same verification, no approval window.
 *
 * ---------------------------------------------------------------------------
 * THE OWNER OF THE WALLET DOES NOT APPROVE THEMSELVES
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: no falta una ventana aquí, sobra. Cuando quien pide es una dApp, la
 * ventana existe para nombrar a un tercero y darle al usuario la opción de decir
 * que no. Cuando quien pide es el usuario desde la UI de la wallet no hay
 * tercero, no hay nada que él no sepa ya, y la respuesta es sí por construcción.
 *
 * Y una aprobación que no puede acabar en "no" no es gratis: enseña a pulsar sin
 * leer, y ese hábito se lo lleva puesto después la ventana que sí importaba.
 *
 * Lo que NO sobra —el permiso de Chrome, que necesita un gesto de usuario, y la
 * verificación del chainId— sigue estando: el permiso lo pide `network.html` en
 * su propio botón, y la verificación es `finaliseAdd`.
 */
export async function addNetworkFromWallet(
  deps: FinaliseDeps,
  params: unknown[],
): Promise<NetworkConfig[]> {
  const draft = parseAddChainParams(params);
  const { networks: catalogue } = await deps.networks.read();

  const existing = findNetwork(catalogue, draft.chainId);
  if (isBuiltIn(draft.chainId) && existing !== undefined) {
    if (existing.rpcUrl === draft.rpcUrl) return catalogue;

    throw invalidParams(
      `"${existing.name}" is built into CodeCrypto Wallet and its RPC endpoint cannot be changed.`,
    );
  }

  /**
   * 🇪🇸 NOTA: no es un `Origin` y por eso no lo parece. Aquí no hay tercero: lo
   * pidió el usuario desde `network.html`. Escribirlo como si fuera un origen
   * —`"wallet"`, o peor, el de la extensión— haría que un log de un endpoint
   * mentiroso se leyera como si una dApp lo hubiera pedido.
   */
  await finaliseAdd(deps, draft, "the wallet's own network form");
  return (await deps.networks.read()).networks;
}

/**
 * The one case where the wallet takes a permission back on its own — and, in
 * Chrome, the one case where it cannot.
 *
 * ---------------------------------------------------------------------------
 * ESTE HUÉRFANO NO ES COMO LOS OTROS CUATRO
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: en Chrome la revocación NO puede tomar —ver la cabecera de
 * `lib/permissions.ts`, medido en la comprobación 79—, así que el permiso se
 * queda concedido para un host que acaba de mentir sobre su identidad.
 *
 * Eso **no** es lo mismo que los cuatro permisos huérfanos que el proyecto ya
 * acepta. Los otros cuatro —el usuario rechaza, cierra con la X, el nodo no
 * responde, el worker muere antes de verificar— son hosts de los que no sabemos
 * nada malo: sobra un permiso y ya. Éste es el único caso en que el endpoint
 * **mintió** sobre qué cadena sirve y la wallet decidió que no lo quería. Que se
 * quede es una **degradación de seguridad real**, no residuo equivalente. Quien
 * lea esto no debe concluir que da lo mismo, porque no da lo mismo.
 *
 * Lo único que sobrevive del intento de engaño es este `console.error`, y por
 * eso lleva los cuatro datos: quién lo pidió, la `rpcUrl`, la cadena declarada y
 * la que reportó el nodo. Sin los cuatro no sirve de nada a posteriori.
 *
 * Y la llamada falla IGUAL: no se da de alta una red que mintió solo porque no
 * pudimos limpiar el permiso detrás.
 */
async function revokeAfterLie(
  permissions: PermissionsPort,
  draft: NetworkDraft,
  reported: unknown,
  requester: string,
): Promise<void> {
  const revoked = await revoke(permissions, draft.rpcUrl);

  console.error(
    `[codecrypto] ${requester} asked to add chain ${draft.chainId} at ${draft.rpcUrl}, ` +
      `and that endpoint reports ${String(reported)}. The network was NOT added. ` +
      (revoked
        ? "Its host permission was revoked."
        : "Its host permission is STILL GRANTED: Chrome cannot revoke it while this " +
          "extension injects a content script into every site. Remove it by hand at " +
          "chrome://extensions."),
  );
}

// ============================================================================
// wallet_removeNetwork
// ============================================================================

/**
 * 🇪🇸 NOTA: los tres motivos llegan a la UI como tres mensajes, no como un
 * "no se pudo borrar" genérico. Cada uno es una situación distinta para el
 * usuario, y solo uno de ellos tiene arreglo — por eso es el único que dice qué
 * hacer. Mismo criterio que el 4902 del permiso revocado: un mensaje que
 * describe el problema sin dar salida es un callejón.
 */
function explainRefusal(reason: RemovalRefusal, chainId: Hex, name: string | undefined): string {
  switch (reason) {
    case "built-in":
      return `"${name ?? chainId}" comes with CodeCrypto Wallet and cannot be removed.`;
    case "active":
      return (
        `"${name ?? chainId}" is the network you are on. Switch to another one before ` +
        "removing it."
      );
    case "not-found":
      return `That network is no longer in the wallet.`;
  }
}

/**
 * Removes a user network, and takes its host permission with it — but only if
 * nothing else needs it.
 *
 * ---------------------------------------------------------------------------
 * THE CONDITION IS THE PATTERN, NOT THE HOST
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: el spike de la Fase 8 midió que Chrome guarda el puerto DENTRO del
 * permiso, así que la comparación tiene que ser por patrón de origen completo.
 * Por host se equivocaría en las dos direcciones:
 *
 *   localhost:8545 y localhost:8546   mismo host, patrones distintos
 *       → borrar una NO puede revocar la otra: son grants independientes, y
 *         hacerlo dejaría la otra red inalcanzable sin que nadie la tocara.
 *
 *   https://x.com/a y https://x.com/b  mismo host Y mismo patrón (la ruta no
 *       → borrar una NO debe revocar nada       cuenta en un match pattern)
 *
 * Comparar patrones acierta en los dos casos con una sola regla.
 *
 * Y el cálculo va DENTRO del turno serializado del borrado, por el callback. Eso
 * garantiza que se cuenta contra el catálogo ya sin la red, y que dos borrados
 * que comparten patrón vean el efecto del otro en vez de esperarse mutuamente y
 * no revocar ninguno. Ver la NOTA de `remove` en `network-store.ts`, que también
 * dice lo que esto NO cierra.
 */
export async function removeNetworkRpc(
  { networks, permissions }: SwitchChainDeps,
  params: unknown[],
): Promise<NetworkConfig[]> {
  const chainId = parseChainIdParam(params, "wallet_removeNetwork");
  const before = await networks.read();
  const doomed = findNetwork(before.networks, chainId);

  const result = await networks.remove(chainId, async (removed, remaining) => {
    const pattern = originPatternFromRpcUrl(removed.rpcUrl);
    if (pattern === null) return;

    const stillUsed = remaining.some(
      (entry) => originPatternFromRpcUrl(entry.rpcUrl) === pattern,
    );
    if (stillUsed) return;

    /**
     * 🇪🇸 NOTA: en Chrome esta revocación NUNCA toma —ver la cabecera de
     * `lib/permissions.ts`— y la red se queda borrada IGUAL. Borrar es lo que el
     * usuario pidió; revocar es aseo, y no se le deshace una petición porque no
     * supimos limpiar detrás.
     *
     * El huérfano que queda aquí sí es de los benignos: el usuario borró una red
     * suya y del host no sabemos nada malo. Es otra cosa que el de
     * `revokeAfterLie`, donde el endpoint mintió — no se mezclan.
     *
     * Y `stillUsed` se sigue calculando aunque hoy su respuesta no pueda tener
     * efecto: lo que se preserva es la DECISIÓN —revocar solo si ninguna otra
     * red comparte el patrón—, que es la parte cara de razonar y la que los
     * tests fijan. Si Chrome cambia, esto funciona solo.
     */
    if (!(await revoke(permissions, removed.rpcUrl))) {
      console.warn(
        `[codecrypto] removed ${removed.name}; its host permission for ${pattern} stays granted`,
      );
    }
  });

  if (!result.ok) throw invalidParams(explainRefusal(result.reason, chainId, doomed?.name));

  return result.networks;
}
