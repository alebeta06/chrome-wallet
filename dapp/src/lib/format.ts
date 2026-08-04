/**
 * @file lib/format.ts
 * @description Display helpers. No dependencies, on purpose.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `import { formatEther } from "ethers"`
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: ethers pesa ~150 kB y esta página lo único que necesita es dividir
 * entre 10^18. La conversión con BigInt es además la forma CORRECTA: los wei no
 * caben en un `number` de JavaScript, y `Number(10n ** 22n)` ya pierde
 * precisión. La dApp añadirá ethers en la Fase 7, cuando `verifyTypedData` sea
 * algo que de verdad no se puede escribir a mano.
 *
 * La extensión tiene su propia copia de estas funciones. Son veinticinco líneas
 * puras: montar un paquete compartido para eso cuesta más que duplicarlas, y
 * cada lado las tiene cubiertas por su propio test.
 */

const WEI_PER_ETH = 10n ** 18n;
const ETH_DECIMALS = 18;
const DISPLAY_DECIMALS = 4;

const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Wei (as a hex quantity) to a fixed 4-decimal ETH string. Truncates.
 *
 * 🇪🇸 NOTA: el `padStart(18, "0")` es el paso que parece redundante y no lo es.
 * La parte fraccionaria es un número, así que pierde sus ceros a la izquierda:
 * 10^15 wei (0.001 ETH) deja un resto de 1000000000000000 — 16 dígitos, no 18.
 * Cortar los cuatro primeros de esa cadena da "1000" → 0.1000, CIEN VECES el
 * saldo real. Hay que rellenar hasta 18 antes de truncar.
 *
 * Contra Anvil no se ve, porque sus 10000 ETH son exactos y no tienen
 * decimales: el fallo aparece la primera vez que alguien recibe una cantidad
 * pequeña. Hay un test con ese caso concreto.
 *
 * Trunca en vez de redondear: un saldo nunca debe mostrarse mayor de lo que es,
 * así que 0.99999 se lee 0.9999 y no 1.0000.
 */
export function formatEther(weiHex: string): string {
  const value = BigInt(weiHex);
  const whole = value / WEI_PER_ETH;
  const fraction = (value % WEI_PER_ETH)
    .toString()
    .padStart(ETH_DECIMALS, "0")
    .slice(0, DISPLAY_DECIMALS);

  return `${whole.toString()}.${fraction}`;
}

/** `0xf39Fd6…92266` → `0xf39F…2266`. Keeps checksum casing intact. */
export function shortenAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Is this worth sending to the wallet as an address?
 *
 * 🇪🇸 NOTA: no valida el checksum EIP-55, y es deliberado. Esto solo evita
 * mandar basura evidente y poder decirlo en la propia página en vez de esperar
 * un -32602 de vuelta. La validación que cuenta la hace la wallet, que es quien
 * no puede fiarse de la página.
 */
export function looksLikeAddress(value: string): boolean {
  return ADDRESS.test(value.trim());
}

/** Guards `formatEther` against a wallet that answers with something odd. */
export function isHexQuantity(value: unknown): value is string {
  return typeof value === "string" && HEX_QUANTITY.test(value);
}

/**
 * An ETH amount typed by a human, to a wei hex quantity. null when unusable.
 *
 * 🇪🇸 NOTA: se parte la cadena por el punto y se rellena a 18 dígitos en vez de
 * multiplicar por 10^18 en coma flotante. `0.1 * 1e18` da 100000000000000000 —
 * que parece bien— pero `2.675 * 1e18` da 2674999999999999700: la wallet
 * enviaría una cantidad distinta de la que el usuario escribió, y por un error
 * que solo aparece con ciertos decimales.
 */
export function toWeiHex(amount: string): string | null {
  const trimmed = amount.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;

  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > ETH_DECIMALS) return null;

  const wei = BigInt(whole) * WEI_PER_ETH + BigInt(fraction.padEnd(ETH_DECIMALS, "0") || "0");
  return `0x${wei.toString(16)}`;
}
