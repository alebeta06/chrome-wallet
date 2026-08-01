/**
 * @file inject.ts
 * @description The EIP-1193 provider. Runs in the page's own JavaScript world.
 *
 * This is the only one of the three scripts that the dApp can touch, and the
 * only one with NO access to any `chrome.*` API whatsoever. Its single channel
 * out is `window.postMessage`, and the content script is on the other end.
 *
 * Built as a CLASSIC script (see vite.config.scripts.ts): if a single `import`
 * survives bundling, the page throws "Cannot use import statement outside a
 * module" and the wallet silently does not exist for that site.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It never touches `window.ethereum`. Grabbing that property is how wallets
 * start fighting each other, and the loser is usually the user, staring at a
 * dApp that cannot connect to either. EIP-6963 exists precisely so that several
 * wallets can coexist by announcing themselves instead of squatting a global.
 *
 * It also reports `isMetaMask: false`. Lying there is not a compatibility trick:
 * plenty of dApps branch on that flag and would take a code path written for a
 * different wallet's quirks.
 */

import {
  ErrorCode,
  PAGE_REQUEST_TIMEOUT_MS,
  PROTOCOL,
  ProviderErrors,
  type PageEventMessage,
  type PageResponseMessage,
  type RequestId,
} from "@/types/messages";

import {
  EIP6963_ANNOUNCE,
  EIP6963_REQUEST,
  PROVIDER_UUID_DATASET_KEY,
  PROVIDER_UUID_EVENT,
  buildProviderInfo,
  isTrustedPageMessage,
  notifyListeners,
  pageRequest,
  toInjectedError,
  type ProviderEventListener,
} from "@/lib/page-protocol";

/** The EIP-1193 argument object. */
export interface RequestArguments {
  method: string;
  params?: unknown[];
}

export interface CodeCryptoProvider {
  readonly isCodeCrypto: true;
  /** Honest by design — see the file header. */
  readonly isMetaMask: false;
  request(args: RequestArguments): Promise<unknown>;
  on(eventName: string, listener: ProviderEventListener): CodeCryptoProvider;
  removeListener(eventName: string, listener: ProviderEventListener): CodeCryptoProvider;
}

declare global {
  interface Window {
    codecrypto?: CodeCryptoProvider;
  }
}

/**
 * 🇪🇸 NOTA: el guard cubre el caso normal de doble ejecución (misma ventana,
 * dos inyecciones). NO cubre la carrera — ver el try/catch del final.
 */
if (window.codecrypto === undefined) {
  install();
}

function install(): void {
  // ==========================================================================
  // State. All of it lives in this closure, per page world.
  // ==========================================================================

  interface PendingCall {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: number;
  }

  /** In-flight requests, keyed by the id that travels on the wire. */
  const pending = new Map<RequestId, PendingCall>();

  /** EIP-1193 listeners, by event name. Keyed by string: a dApp may listen for anything. */
  const listeners = new Map<string, Set<ProviderEventListener>>();

  /**
   * The EIP-6963 identity, which arrives from the content script a millisecond
   * or two after this script runs. Until it does, there is nothing to announce.
   */
  let providerUuid: string | null = null;

  // ==========================================================================
  // Inbound: responses and events
  // ==========================================================================

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (isTrustedPageMessage(event, window, "CODECRYPTO_RESPONSE")) {
      settle(event.data as PageResponseMessage);
      return;
    }
    if (isTrustedPageMessage(event, window, "CODECRYPTO_EVENT")) {
      const message = event.data as PageEventMessage;
      notifyListeners(listeners.get(message.eventName) ?? [], message.data);
    }
  });

  /**
   * Matches a response to its request by id.
   *
   * An id we do not know is dropped without a sound. That covers a duplicate, a
   * response that lost the race against its own timeout, and — the reason the
   * guards in `isTrustedPageMessage` come first — anything a hostile frame threw
   * onto the bus hoping to hit a live id.
   */
  function settle(message: PageResponseMessage): void {
    const call = pending.get(message.id);
    if (call === undefined) return;

    clearTimeout(call.timer);
    pending.delete(message.id);

    if (message.ok) call.resolve(message.result);
    else call.reject(toInjectedError(message.error));
  }

  // ==========================================================================
  // Outbound: request()
  // ==========================================================================

  function request(args: RequestArguments): Promise<unknown> {
    // The caller is untyped JavaScript, so nothing here can be assumed.
    const candidate = args as unknown;
    if (typeof candidate !== "object" || candidate === null) {
      return Promise.reject(
        toInjectedError(ProviderErrors.invalidParams("request() expects an object with a `method`.")),
      );
    }

    const { method, params } = candidate as { method?: unknown; params?: unknown };

    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(
        toInjectedError(ProviderErrors.invalidParams("request() requires a non-empty `method` string.")),
      );
    }

    /**
     * 🇪🇸 NOTA: EIP-1193 admite `params` como array o como objeto. El contrato
     * de este proyecto lo fija como `unknown[]` (ver PageRequestMessage), así
     * que un objeto se rechaza aquí con -32602 en vez de cruzar el puente y
     * romperse más adentro, donde el error ya no diría de qué se queja.
     */
    if (params !== undefined && !Array.isArray(params)) {
      return Promise.reject(
        toInjectedError(ProviderErrors.invalidParams("request() requires `params` to be an array.")),
      );
    }

    const id = crypto.randomUUID();

    return new Promise<unknown>((resolve, reject) => {
      /**
       * 🇪🇸 NOTA: -32603 y no 4900. El 4900 significa "no se alcanza la wallet"
       * y lo emite el content script, que es quien sabe si `chrome.runtime`
       * respondió. Si llegamos aquí es que el background ACEPTÓ la petición y no
       * contestó en 150 s — más que el timeout de aprobación más largo del
       * contrato. Eso no es una desconexión, es un bug nuestro, y el código
       * tiene que decirlo.
       *
       * Limpiar la entrada del Map es la otra mitad: sin esto, cada petición
       * perdida deja un objeto vivo y una dApp de larga vida acumula fugas.
       */
      const timer = window.setTimeout(() => {
        pending.delete(id);
        reject(
          toInjectedError({
            code: ErrorCode.INTERNAL,
            message: `The wallet did not answer "${method}" within ${PAGE_REQUEST_TIMEOUT_MS} ms.`,
          }),
        );
      }, PAGE_REQUEST_TIMEOUT_MS);

      pending.set(id, { resolve, reject, timer });

      /**
       * 🇪🇸 NOTA: targetOrigin "*" y no location.origin. El mensaje no sale de
       * esta ventana — va al content script, que vive en el mundo aislado de la
       * MISMA pestaña — así que restringir el origen no protege de nada que no
       * pudiera leerse ya. Y `location.origin` es la cadena "null" en un iframe
       * about:blank, donde un targetOrigin estricto haría que el mensaje no se
       * entregase nunca. La seguridad está en las comprobaciones del receptor.
       */
      window.postMessage(pageRequest(id, method, params ?? []), "*");
    });
  }

  // ==========================================================================
  // Events: on / removeListener
  // ==========================================================================

  function on(eventName: string, listener: ProviderEventListener): CodeCryptoProvider {
    if (typeof listener !== "function") return provider;
    const set = listeners.get(eventName) ?? new Set<ProviderEventListener>();
    set.add(listener);
    listeners.set(eventName, set);
    return provider;
  }

  function removeListener(eventName: string, listener: ProviderEventListener): CodeCryptoProvider {
    const set = listeners.get(eventName);
    if (set !== undefined) {
      set.delete(listener);
      if (set.size === 0) listeners.delete(eventName);
    }
    return provider;
  }

  const provider: CodeCryptoProvider = Object.freeze({
    isCodeCrypto: true as const,
    isMetaMask: false as const,
    request,
    on,
    removeListener,
  });

  // ==========================================================================
  // EIP-6963
  // ==========================================================================

  /**
   * Announces the provider to whoever is listening.
   *
   * 🇪🇸 NOTA: el estándar exige `Object.freeze` sobre el `detail`. El evento lo
   * reciben TODOS los listeners de la página, incluidas otras wallets y la
   * propia dApp; sin congelarlo, el primero que lo reciba puede reescribir el
   * `info` (o cambiar el `provider`) antes de que lo vean los demás.
   */
  function announce(): void {
    // No uuid yet: adoptUuid() will call this the moment it arrives, and that
    // single announcement satisfies every requestProvider that came in early.
    if (providerUuid === null) return;

    window.dispatchEvent(
      new CustomEvent(EIP6963_ANNOUNCE, {
        detail: Object.freeze({ info: buildProviderInfo(providerUuid), provider }),
      }),
    );
  }

  /**
   * 🇪🇸 NOTA: hay que anunciar DOS veces, y las dos son necesarias por motivos
   * distintos. Al cargar, para las dApps que ya estaban escuchando; y en cada
   * `eip6963:requestProvider`, para las que preguntan después. Con solo lo
   * primero desapareces de cualquier dApp que monte su selector más tarde; con
   * solo lo segundo, de las que escuchan desde el principio y no vuelven a
   * preguntar.
   */
  window.addEventListener(EIP6963_REQUEST, () => announce());

  function adoptUuid(uuid: unknown): void {
    if (providerUuid !== null) return;
    if (typeof uuid !== "string" || uuid.length === 0) return;
    providerUuid = uuid;
    announce();
  }

  // Path 1: the content script already resolved the uuid before this script ran.
  adoptUuid(document.documentElement.dataset[PROVIDER_UUID_DATASET_KEY]);

  /**
   * Path 2: it has not, and will tell us when it does.
   *
   * 🇪🇸 NOTA: se lee el `detail` Y, si no sirvió, el atributo. No es cinturón y
   * tirantes por gusto: el evento lo dispara el content script desde el MUNDO
   * AISLADO, y lo que se puede llevar en `detail` a través de esa frontera
   * depende del navegador. Una cadena cruza sin problema en Chrome, pero el
   * atributo del DOM no depende de eso en absoluto. `adoptUuid` es idempotente,
   * así que la segunda llamada no hace nada cuando la primera funcionó.
   */
  window.addEventListener(PROVIDER_UUID_EVENT, (event: Event) => {
    adoptUuid((event as CustomEvent<unknown>).detail);
    adoptUuid(document.documentElement.dataset[PROVIDER_UUID_DATASET_KEY]);
  });

  // ==========================================================================
  // Publish
  // ==========================================================================

  /**
   * 🇪🇸 NOTA: el try/catch NO es decorativo. El guard de arriba cubre la doble
   * ejecución normal, pero no la CARRERA: con `all_frames: true` y
   * `match_about_blank: true`, un iframe about:blank puede compartir contexto
   * con su padre y ejecutar inject.js dos veces sobre el mismo `window`. Si las
   * dos pasan el guard antes de que ninguna haya definido la propiedad, la
   * segunda `defineProperty` sobre algo `configurable: false` LANZA TypeError.
   *
   * Y una excepción sin capturar en document_start no falla en local: se lleva
   * por delante todo lo que venga después en el archivo. Aquí no queda nada
   * detrás, pero eso es cierto hoy y no lo será cuando alguien añada algo. El
   * catch es la diferencia entre "ya estaba definido, seguimos" y "la wallet no
   * existe en esta página y nadie sabe por qué".
   */
  try {
    Object.defineProperty(window, "codecrypto", {
      value: provider,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch (cause) {
    console.debug(`[${PROTOCOL}] window.codecrypto was already defined by another injection:`, cause);
  }
}
