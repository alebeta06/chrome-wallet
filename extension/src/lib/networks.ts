/**
 * @file lib/networks.ts
 * @description The network catalogue: canonical form, the two built-ins, and
 * the pure reducers that add, overwrite and remove entries.
 *
 * Pure: no storage, no chrome, no ethers. The persistence and the serialized
 * writes live in network-store.ts, which is what this file exists to keep
 * testable — every rule below can be checked without a browser.
 */

import type { AddEthereumChainParameter, Hex, NetworkConfig } from "@/types/messages";

/** Anvil's default chain id, 31337. */
export const ANVIL_CHAIN_ID: Hex = "0x7a69";

/** Sepolia, 11155111. */
export const SEPOLIA_CHAIN_ID: Hex = "0xaa36a7";

/** What a fresh wallet points at. Local first: no faucet, no rate limits. */
export const DEFAULT_CHAIN_ID: Hex = ANVIL_CHAIN_ID;

const ETHER = { name: "Ether", symbol: "ETH", decimals: 18 } as const;

/**
 * 🇪🇸 NOTA: `addedAt: 0` en las dos, y no `Date.now()`. Una builtin no se
 * "añadió": estaba. Poner una fecha real las mezclaría en la ordenación con las
 * que el usuario sí añadió, y además haría que el catálogo cambiara en cada
 * arranque del worker — con lo que la migración dejaría de ser idempotente y
 * escribiría en storage cada vez sin que nada hubiera cambiado.
 */

/**
 * ---------------------------------------------------------------------------
 * SI EL RPC DE UNA BUILTIN MUERE, SE ARREGLA AQUÍ. NO DÁNDOLA DE ALTA
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: esto ya pasó una vez. Sepolia apuntaba a `sepolia.drpc.org` y el 10
 * de agosto de 2026 dRPC metió la cadena entera detrás de su plan de pago: los
 * NUEVE métodos que la wallet usa devolvían *"chain is not available on free
 * plan"*. Se cambió a `publicnode`, medido en la comprobación 81.
 *
 * **La salida NO es reapuntar la red desde la wallet ni desde una dApp.** Eso se
 * rechaza con -32602 —`upsertNetwork` bloquea las builtin a propósito, para que
 * una dApp no pueda hacer que "Sepolia" hable con su propio nodo—, así que
 * intentarlo solo gasta tiempo.
 *
 * La salida es **cambiar la `rpcUrl` de aquí abajo y reconstruir**, más el
 * `host_permissions` de `manifest.ts`, que tiene que casar. Y eso arregla
 * también los perfiles que ya existen sin borrar storage: `migrateCatalogue`
 * siembra las builtin PRIMERO y descarta la entrada guardada que reclame el
 * mismo chainId, así que la definición de este archivo siempre gana sobre lo
 * persistido. Está en la NOTA de `migrateCatalogue`, al final del archivo.
 *
 * Antes de elegir sustituto, medir los nueve métodos y no solo `eth_chainId`:
 * en la comprobación 81, `1rpc.io/sepolia` pasó ocho y falló exactamente en
 * `eth_estimateGas`, que es el que hace falta para enviar. Un endpoint así se ve
 * perfecto —saldos, red, todo— y solo se cae al firmar.
 */
export const DEFAULT_NETWORKS: readonly NetworkConfig[] = [
  {
    chainId: ANVIL_CHAIN_ID,
    name: "Anvil Local",
    rpcUrl: "http://localhost:8545",
    symbol: ETHER.symbol,
    explorerUrl: null,
    builtIn: true,
    addedAt: 0,
    nativeCurrency: { ...ETHER },
  },
  {
    chainId: SEPOLIA_CHAIN_ID,
    name: "Sepolia",
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    symbol: ETHER.symbol,
    explorerUrl: "https://sepolia.etherscan.io",
    builtIn: true,
    addedAt: 0,
    nativeCurrency: { ...ETHER },
  },
];

/** A fresh, mutable copy — callers must not be able to edit the catalogue. */
export function defaultNetworks(): NetworkConfig[] {
  return DEFAULT_NETWORKS.map((network) => ({ ...network, nativeCurrency: { ...ETHER } }));
}

const BUILT_IN_IDS: ReadonlySet<string> = new Set(DEFAULT_NETWORKS.map((n) => n.chainId));

export function isBuiltIn(chainId: Hex): boolean {
  return BUILT_IN_IDS.has(chainId);
}

// ============================================================================
// Canonical form
// ============================================================================

const HEX_CHAIN_ID = /^0[xX][0-9a-fA-F]+$/;

/**
 * ---------------------------------------------------------------------------
 * THE CEILING IS A DECISION, NOT A SIDE EFFECT
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: EIP-155 no acota el chainId —en RLP es un entero sin tope— y EIP-3085
 * tampoco fija un máximo: solo pide que sea hexadecimal con `0x` y que "parse to
 * an integer number". Así que este techo lo ponemos nosotros y hay que decir qué
 * cuesta.
 *
 * **Qué se pierde:** una cadena con chainId por encima de 2^53-1 no se puede
 * añadir a esta wallet. Existen, sobre todo entre L3 y devnets que se generan el
 * id a partir de un hash.
 *
 * **Por qué se acepta perderlo.** El chainId sale de aquí como cadena hex, pero
 * no controlamos qué hace la dApp con él, y `parseInt`/`Number` sobre el
 * resultado de `eth_chainId` es lo que hace medio ecosistema. Por encima de
 * 2^53-1 esa conversión pierde precisión EN SILENCIO: la dApp cree estar en una
 * cadena y está en otra, y una firma hecha con esa suposición es válida donde no
 * debería. Rechazar el alta es visible y ocurre una vez; el redondeo silencioso
 * no se ve nunca.
 *
 * Internamente la wallet ya usa BigInt en todas partes (`signer.ts`,
 * `chain.ts`), así que subir el techo a 2^64-2 sería un cambio de una línea aquí
 * el día que haga falta de verdad. Lo que no se puede subir es lo que hará la
 * dApp del otro lado.
 */
const MAX_CHAIN_ID = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The one spelling of a chain id this wallet stores and compares.
 *
 * ---------------------------------------------------------------------------
 * THE SAME CHAIN CAN ARRIVE SPELLED THREE WAYS
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: `0x1`, `0x01` y `0X1` son la misma red y tres cadenas distintas. Sin
 * una forma canónica, `find(n => n.chainId === chainId)` falla para un usuario
 * que escribió el cero a la izquierda, la wallet decide que la red es
 * desconocida y responde 4902 a una red que tiene delante. Y peor: una dApp
 * podría dar de alta `0x01` teniendo ya `0x1` y acabarías con dos entradas para
 * la misma cadena, cada una con su RPC.
 *
 * El 0 se rechaza porque no es una red. Del techo se habla en MAX_CHAIN_ID.
 */
export function canonicalChainId(value: unknown): Hex | null {
  if (typeof value !== "string" || !HEX_CHAIN_ID.test(value)) return null;

  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > MAX_CHAIN_ID) return null;

  return `0x${parsed.toString(16)}`;
}

/**
 * 🇪🇸 NOTA: se quita la barra final al ESCRIBIR, no al leer. Guardado con barra,
 * cada sitio que construya un enlace tendría que acordarse de quitarla y el
 * primero que se olvide produce `https://sepolia.etherscan.io//address/0x…`,
 * que en Etherscan es un 404. Normalizar una vez en la escritura es un sitio;
 * normalizar al leer son todos los sitios.
 */
export function normalizeExplorerUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  } catch {
    return null;
  }

  return trimmed;
}

// ============================================================================
// Building an entry
// ============================================================================

export interface NetworkDraft {
  chainId: Hex;
  name: string;
  rpcUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  explorerUrl: string | null;
}

/**
 * The ONLY way a catalogue entry is built.
 *
 * ---------------------------------------------------------------------------
 * symbol IS DERIVED, NEVER PASSED
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: `symbol` y `nativeCurrency.symbol` son el mismo dato guardado dos
 * veces — el primero porque lo lee media UI desde la Fase 3, el segundo porque
 * es lo que dice EIP-3085. Dos campos que pueden discrepar acaban discrepando:
 * bastaría con que un sitio actualizara uno y no el otro para que la ventana de
 * firma dijese "0.5 ETH" y el popup "0.5 MATIC" para la misma red.
 *
 * Por eso no hay forma de pasar `symbol`: se deriva aquí y punto. Hay un test
 * que lo fija.
 */
export function toNetworkConfig(
  draft: NetworkDraft,
  addedAt: number,
  builtIn = false,
): NetworkConfig {
  return {
    chainId: draft.chainId,
    name: draft.name.trim(),
    rpcUrl: draft.rpcUrl,
    symbol: draft.nativeCurrency.symbol,
    explorerUrl: normalizeExplorerUrl(draft.explorerUrl),
    builtIn,
    addedAt,
    nativeCurrency: { ...draft.nativeCurrency },
  };
}

/** EIP-3085 on the wire to a draft. Shape only — the policy lives elsewhere. */
export function draftFromParameter(param: AddEthereumChainParameter): NetworkDraft | null {
  const chainId = canonicalChainId(param.chainId);
  if (chainId === null) return null;

  const rpcUrl = param.rpcUrls?.[0];
  if (typeof rpcUrl !== "string" || rpcUrl.length === 0) return null;
  if (typeof param.chainName !== "string" || param.chainName.trim().length === 0) return null;

  const currency = sanitizeCurrency(param.nativeCurrency);
  if (currency === null) return null;

  return {
    chainId,
    name: param.chainName,
    rpcUrl,
    nativeCurrency: currency,
    explorerUrl: param.blockExplorerUrls?.[0] ?? null,
  };
}

// ============================================================================
// Reducers
// ============================================================================

export function findNetwork(
  catalogue: readonly NetworkConfig[],
  chainId: Hex,
): NetworkConfig | undefined {
  return catalogue.find((entry) => entry.chainId === chainId);
}

/**
 * Adds an entry, or replaces the one with the same chain id in place.
 *
 * 🇪🇸 NOTA: "en su sitio" es intencionado. Reemplazar quitando y empujando al
 * final reordenaría el selector de red del popup cada vez que alguien cambia un
 * RPC, y una lista que se reordena sola es una lista en la que se pulsa la
 * entrada equivocada.
 *
 * Una builtin no se sobrescribe nunca: su definición está en el código, y
 * dejar que una dApp la cambiara sería dejar que apunte "Sepolia" a su propio
 * nodo.
 */
export function upsertNetwork(
  catalogue: readonly NetworkConfig[],
  entry: NetworkConfig,
): NetworkConfig[] {
  if (isBuiltIn(entry.chainId)) return [...catalogue];

  const index = catalogue.findIndex((candidate) => candidate.chainId === entry.chainId);
  if (index === -1) return [...catalogue, entry];

  const next = [...catalogue];
  next[index] = entry;
  return next;
}

export type RemovalRefusal = "not-found" | "built-in" | "active";

export type RemovalResult =
  | { ok: true; networks: NetworkConfig[] }
  | { ok: false; reason: RemovalRefusal };

/**
 * 🇪🇸 NOTA: los tres motivos de rechazo se devuelven, no se colapsan en un
 * booleano. Cada uno se le explica al usuario de una forma distinta —"esa red
 * viene con la wallet", "cambia de red antes de borrarla", "esa red ya no
 * está"— y un `false` pelado obligaría a quien llama a volver a deducir cuál
 * era, con la lógica duplicada y la ocasión de que se desincronice.
 *
 * Borrar la red activa se bloquea en vez de caer a Anvil automáticamente: mover
 * al usuario de red como efecto secundario de un botón de borrar es justo lo
 * que no espera nadie.
 */
export function removeNetwork(
  catalogue: readonly NetworkConfig[],
  chainId: Hex,
  activeChainId: Hex,
): RemovalResult {
  const existing = findNetwork(catalogue, chainId);

  if (existing === undefined) return { ok: false, reason: "not-found" };
  if (existing.builtIn || isBuiltIn(chainId)) return { ok: false, reason: "built-in" };
  if (chainId === activeChainId) return { ok: false, reason: "active" };

  return { ok: true, networks: catalogue.filter((entry) => entry.chainId !== chainId) };
}

// ============================================================================
// Migration
// ============================================================================

export interface MigratedCatalogue {
  networks: NetworkConfig[];
  chainId: Hex;
}

/**
 * Brings whatever is in storage to the current shape. Idempotent.
 *
 * ---------------------------------------------------------------------------
 * THE BUILT-INS ARE SEEDED FIRST, AND THAT IS THE WHOLE TRICK
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: el mapa arranca YA con las dos builtin puestas desde el código, y
 * solo después se recorre lo guardado. Con eso, una entrada custom que traiga
 * `0xaa36a7` no entra — no porque llegue "después", sino porque la clave ya
 * está ocupada por la definición buena.
 *
 * Es la diferencia entre una regla y una coincidencia. Un dedupe de "gana la
 * primera" sobre la lista mezclada daría el mismo resultado solo si las builtin
 * casualmente van delante en el array, y bastaría con que alguien reordenara o
 * con que una escritura vieja las dejara al final para que una red del usuario
 * pudiera apuntar "Sepolia" a su propio RPC. Hay un test que mete la custom
 * primero.
 *
 * `cc:networks` no se ha escrito nunca hasta esta fase, así que el caso real
 * más común es que llegue `undefined` — y la migración es entonces la siembra.
 */
export function migrateCatalogue(stored: unknown, storedChainId: unknown): MigratedCatalogue {
  const byChainId = new Map<Hex, NetworkConfig>();

  for (const builtIn of defaultNetworks()) byChainId.set(builtIn.chainId, builtIn);

  if (Array.isArray(stored)) {
    for (const raw of stored) {
      const entry = sanitizeEntry(raw);
      // Built-in keys are already taken; among customs, the first one wins.
      if (entry !== null && !byChainId.has(entry.chainId)) byChainId.set(entry.chainId, entry);
    }
  }

  const networks = [...byChainId.values()];

  /**
   * 🇪🇸 NOTA: aquí es donde "sin perder la red activa" se cumple de verdad. Si
   * estabas en Sepolia y reinicias Chrome, el id guardado sigue en el catálogo
   * y no se toca. Solo se cae a Anvil cuando la red activa ya no existe —
   * porque se borró, o porque nunca fue válida— y entonces caer es lo correcto:
   * la alternativa es una wallet apuntando a una red que no está.
   */
  const canonicalActive = canonicalChainId(storedChainId);
  const chainId =
    canonicalActive !== null && byChainId.has(canonicalActive)
      ? canonicalActive
      : DEFAULT_CHAIN_ID;

  return { networks, chainId };
}

/**
 * 🇪🇸 NOTA: se valida la FORMA, no la política. Una red guardada cuyo rpcUrl ya
 * no pasaría `isRpcUrlAllowed` se conserva: borrarle al usuario una red que él
 * añadió porque la política se endureció después es perder datos suyos sin
 * avisar. La política se aplica al dar de alta, y el permiso que falte se ve
 * como red no usable, que es reversible.
 */
function sanitizeEntry(raw: unknown): NetworkConfig | null {
  if (typeof raw !== "object" || raw === null) return null;

  const candidate = raw as Partial<NetworkConfig>;

  const chainId = canonicalChainId(candidate.chainId);
  if (chainId === null) return null;

  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) return null;
  if (typeof candidate.rpcUrl !== "string" || candidate.rpcUrl.length === 0) return null;

  /**
   * 🇪🇸 NOTA: una entrada anterior a la Fase 8 no tiene `nativeCurrency`, solo
   * `symbol`. Se sintetiza desde él en vez de descartarla, y así el invariante
   * "symbol === nativeCurrency.symbol" se cumple también para lo migrado.
   */
  const symbol =
    typeof candidate.symbol === "string" && candidate.symbol.trim().length > 0
      ? candidate.symbol.trim()
      : null;

  const currency =
    sanitizeCurrency(candidate.nativeCurrency) ??
    (symbol === null ? null : { name: symbol, symbol, decimals: 18 });

  if (currency === null) return null;

  return toNetworkConfig(
    {
      chainId,
      name: candidate.name,
      rpcUrl: candidate.rpcUrl,
      nativeCurrency: currency,
      explorerUrl: candidate.explorerUrl ?? null,
    },
    typeof candidate.addedAt === "number" && Number.isFinite(candidate.addedAt)
      ? candidate.addedAt
      : 0,
    false,
  );
}

/** EIP-3085 requires all three. `decimals` is an integer, and 18 is not assumed. */
function sanitizeCurrency(
  raw: unknown,
): { name: string; symbol: string; decimals: number } | null {
  if (typeof raw !== "object" || raw === null) return null;

  const candidate = raw as Partial<{ name: string; symbol: string; decimals: number }>;

  const symbol = typeof candidate.symbol === "string" ? candidate.symbol.trim() : "";
  if (symbol.length === 0 || symbol.length > 11) return null;

  const decimals = candidate.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return null;
  }

  const name = typeof candidate.name === "string" && candidate.name.trim().length > 0
    ? candidate.name.trim()
    : symbol;

  return { name, symbol, decimals };
}
