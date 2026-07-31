/**
 * @file lib/format.ts
 * @description Pure display helpers, shared by the background and the UI.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE MUST NOT IMPORT ethers
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: es el único módulo de lib/ que importa la UI, así que un
 * `import { formatEther } from "ethers"` aquí metería los ~150 kB de ethers en
 * los bundles del popup y rompería la regla de la fase. La conversión se hace
 * con BigInt, que además es la forma correcta: los wei no caben en un `number`
 * y `Number(10n ** 22n)` ya pierde precisión.
 */

import type { Address, Hex } from "@/types/messages";

const WEI_PER_ETH = 10n ** 18n;
const ETH_DECIMALS = 18;
const DISPLAY_DECIMALS = 4;

/**
 * Wei to a fixed 4-decimal ETH string. Truncates, never rounds.
 *
 * 🇪🇸 NOTA: el `padStart(18, "0")` es el paso que parece redundante y no lo es.
 * La parte fraccionaria es un número, así que pierde sus ceros a la izquierda:
 * 10^15 wei (0.001 ETH) da un resto de 1000000000000000, que son 16 dígitos, no
 * 18. Cortar los cuatro primeros de esa cadena da "1000" -> 0.1000, cien veces
 * el saldo real. Hay que rellenar hasta 18 ANTES de truncar.
 *
 * No se ve contra Anvil porque sus 10000 ETH son exactos y no tienen decimales:
 * el fallo aparece la primera vez que alguien recibe una cantidad pequeña.
 *
 * Se trunca en vez de redondear porque un saldo nunca debe mostrarse mayor de
 * lo que es: 0.99999 tiene que leerse 0.9999, no 1.0000.
 */
export function formatEther(wei: Hex): string {
  const value = BigInt(wei);
  const whole = value / WEI_PER_ETH;
  const fraction = (value % WEI_PER_ETH)
    .toString()
    .padStart(ETH_DECIMALS, "0")
    .slice(0, DISPLAY_DECIMALS);

  return `${whole.toString()}.${fraction}`;
}

/** `0xf39Fd6…92266` -> `0xf39F…2266`. Keeps the checksum casing intact. */
export function shortenAddress(address: Address): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Zero-width characters: not whitespace as far as `\s` is concerned, and
 * invisible on screen. Password managers and web pages inject them on copy.
 */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/**
 * Cleans a pasted recovery phrase into its canonical form.
 *
 * 🇪🇸 NOTA: éste es el bug de soporte clásico. El usuario pega una frase
 * perfectamente válida desde su gestor de contraseñas, la wallet dice "mnemonic
 * inválido", y en pantalla las doce palabras se ven bien. La culpa es de un
 * salto de línea al final, un espacio doble, o un carácter de ancho cero que no
 * se ve ni seleccionándolo.
 *
 * `\s` de JavaScript sí cubre \n, \t y el espacio duro ( ), pero NO los de
 * ancho cero: ésos hay que quitarlos aparte, y por eso van en su propio paso.
 */
export function normalizeMnemonicInput(raw: string): string {
  return raw
    .replace(ZERO_WIDTH, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
