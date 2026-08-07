/**
 * @file lib/permissions.ts
 * @description Which RPC endpoints the wallet is willing to talk to, and how
 * that maps onto a Chrome host permission.
 *
 * Pure with respect to chrome.*: the API surface is injected, exactly like
 * `StorageArea` in storage.ts and `TabsPort` in events.ts, so the policy can be
 * tested without a browser.
 *
 * ---------------------------------------------------------------------------
 * A GRANT IS PER ORIGIN INCLUDING THE PORT. MEASURED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: esto se midió en Chrome con un spike antes de escribir una línea,
 * porque la respuesta decide el código y las dos opciones eran plausibles.
 *
 * Con `http://localhost:8546/*` concedido y nada más:
 *
 *   contains("http://localhost:8547/*")  → false
 *   contains("http://localhost/*")       → false
 *
 * Y sobre un host que no aparece en el manifest, con solo el puerto concedido:
 *
 *   contains("https://…publicnode.com/*")      → false
 *   contains("https://…publicnode.com:9999/*") → false
 *
 * O sea: **Chrome guarda el patrón con el puerto dentro**. No agrupa por
 * hostname. Dos redes en `localhost:8545` y `localhost:8546` son dos permisos
 * independientes que se conceden y se revocan por separado, y no existe ninguna
 * "clave de host" bajo la que agruparlas — por eso aquí solo hay una función de
 * patrón y no dos.
 *
 * La dirección contraria sí agrupa: teniendo el host SIN puerto, una petición
 * con puerto se da por concedida sin abrir diálogo. Pero la wallet nunca pide
 * el host suelto, así que ese caso no se da.
 */

/** The two things this module uses from chrome.permissions. */
export interface PermissionsPort {
  contains(pattern: string): Promise<boolean>;
  /** Chrome resolves false when it refuses; see `revoke` for why that matters. */
  remove(pattern: string): Promise<boolean>;
}

/**
 * @param api defaults to chrome.permissions, resolved at call time so that
 *            importing this module outside an extension context is harmless.
 */
export function createPermissionsPort(api: typeof chrome.permissions = chrome.permissions): PermissionsPort {
  return {
    contains: (pattern) => api.contains({ origins: [pattern] }),
    remove: (pattern) => api.remove({ origins: [pattern] }),
  };
}

/**
 * Hosts allowed to speak plain http.
 *
 * 🇪🇸 NOTA: los dos, y son DOS. Un patrón de host no resuelve nombres:
 * `http://localhost/*` no casa con `http://127.0.0.1:8545` por mucho que
 * apunten a la misma máquina. Por eso el manifest declara los dos en
 * `optional_host_permissions` y por eso esta lista tiene dos entradas.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/**
 * Is this a URL the wallet will accept as an RPC endpoint?
 *
 * ---------------------------------------------------------------------------
 * HTTPS, EXCEPT ON YOUR OWN MACHINE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: un RPC por http en internet es un intermediario que ve —y puede
 * reescribir— cada respuesta: el saldo que enseña la wallet, el nonce con el
 * que se firma, el recibo de una transacción. No hay nada que firmar mal ahí,
 * pero sí mucho que mentir.
 *
 * El loopback es la excepción y no es una concesión a la comodidad: el tráfico
 * no sale de la máquina, y Anvil no tiene certificado ni forma razonable de
 * tenerlo. Exigirle https dejaría fuera el caso que más se usa en este
 * proyecto.
 */
export function isRpcUrlAllowed(rpcUrl: string): boolean {
  const url = parse(rpcUrl);
  if (url === null) return false;

  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * The Chrome match pattern that covers this endpoint, or null if the URL is not
 * one the wallet accepts.
 *
 * 🇪🇸 NOTA: `url.host`, no `url.hostname`. `host` incluye el puerto cuando lo
 * hay, y el puerto es parte del permiso — ver la cabecera. `hostname` lo deja
 * fuera y produciría un patrón MÁS ANCHO que el que hace falta: pedirías todo
 * localhost para hablar con un nodo en el 8545.
 *
 * El puerto por defecto se normaliza solo: `new URL("https://x.com:443")` tiene
 * `host === "x.com"`, así que no hay dos patrones para el mismo sitio.
 *
 * La RUTA se descarta a propósito, y con ella cualquier API key que venga
 * dentro. Un patrón de permiso de host no distingue rutas de todas formas, y
 * `https://eth-sepolia.g.alchemy.com/v2/<clave>/*` acabaría con la clave a la
 * vista en el diálogo de Chrome y en `chrome://extensions`.
 */
export function originPatternFromRpcUrl(rpcUrl: string): string | null {
  if (!isRpcUrlAllowed(rpcUrl)) return null;

  // Non-null: isRpcUrlAllowed already parsed it.
  const url = parse(rpcUrl) as URL;
  return `${url.protocol}//${url.host}/*`;
}

/** Has the user granted this extension access to this endpoint? */
export async function hasPermissionFor(
  permissions: PermissionsPort,
  rpcUrl: string,
): Promise<boolean> {
  const pattern = originPatternFromRpcUrl(rpcUrl);
  if (pattern === null) return false;

  try {
    return await permissions.contains(pattern);
  } catch (cause) {
    /**
     * 🇪🇸 NOTA: un fallo consultando el permiso se trata como "no concedido".
     * Al revés —dar por buena una red que no se pudo comprobar— el usuario
     * elegiría una red que después no responde, sin explicación.
     */
    console.error(`[codecrypto] could not check the permission for ${pattern}:`, cause);
    return false;
  }
}

/**
 * Drops the permission for an endpoint, and CHECKS that it really went.
 *
 * ---------------------------------------------------------------------------
 * remove() CAN LIE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: `chrome.permissions.remove()` devuelve un booleano y hay navegadores
 * que lo resuelven a true sin revocar nada. Se detectó en Brave durante el
 * spike de la Fase 8: los permisos opcionales seguían concedidos después de
 * llamar, y además su ajuste de "acceso al sitio: en todos los sitios" ensuciaba
 * la medición entera. La extensión se desarrolla y se evalúa en **Chrome**.
 *
 * Por eso no basta con mirar el valor de retorno: se vuelve a preguntar con
 * `contains()`, que es la única fuente que ha demostrado no mentir. Devolver
 * true sin verificar dejaría a la UI diciendo "permiso revocado" con el permiso
 * intacto, que es la peor de las dos mentiras posibles.
 */
export async function revoke(
  permissions: PermissionsPort,
  rpcUrl: string,
): Promise<boolean> {
  const pattern = originPatternFromRpcUrl(rpcUrl);
  if (pattern === null) return false;

  try {
    await permissions.remove(pattern);
    return !(await permissions.contains(pattern));
  } catch (cause) {
    console.error(`[codecrypto] could not revoke ${pattern}:`, cause);
    return false;
  }
}

/** `new URL` throws on anything malformed; nothing here wants an exception. */
function parse(rpcUrl: string): URL | null {
  if (typeof rpcUrl !== "string" || rpcUrl.length === 0) return null;

  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return null;
  }

  /**
   * 🇪🇸 NOTA: credenciales en la URL se rechazan en vez de ignorarse. El patrón
   * de permiso las descartaría en silencio, así que el usuario vería un diálogo
   * para `https://host/*` mientras la wallet guarda una URL con usuario y
   * contraseña dentro — dos cosas distintas donde debería haber una.
   */
  if (url.username.length > 0 || url.password.length > 0) return null;

  // A wildcard host would turn one network into a permission over everything.
  if (url.hostname.length === 0 || url.hostname.includes("*")) return null;

  return url;
}
