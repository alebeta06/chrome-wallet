/**
 * @file lib/validators.ts
 * @description Input rules for the extension's own forms (spec 26).
 *
 * ---------------------------------------------------------------------------
 * COMPOSITION, NOT A SECOND CATALOGUE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: casi nada de esto es nuevo, y ése es el punto. Las reglas ya existían
 * repartidas porque las fases anteriores las necesitaron; lo que faltaba era un
 * sitio donde la UI pudiera preguntarlas con una respuesta uniforme.
 *
 *   chainId       -> `canonicalChainId` (networks.ts), de la Fase 8
 *   URL de RPC    -> `isRpcUrlAllowed` (permissions.ts), de la Fase 8
 *   nombre de red -> `isValidNetworkName` (networks.ts)
 *   dirección     -> `isValidAddress` (tx.ts), de la Fase 6
 *
 * Reimplementarlas aquí habría creado dos versiones de cada una, y el día que
 * una cambiara —el rango de chainId, la política de http en local— la otra se
 * quedaría atrás sin que nada fallara: la wallet aceptaría por un camino lo que
 * rechaza por el otro.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE MNEMONIC RULE IS, AND WHY IT IS NOT HERE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: la validación del mnemonic es `isValidMnemonic` en `hd-wallet.ts`, y
 * se queda ahí a propósito. Necesita la wordlist y el checksum BIP-39, o sea
 * ethers, y este módulo lo importa la UI: traerla aquí metería ethers en el
 * bundle del popup, que es una regla fija del proyecto.
 *
 * No es una regla que falte, es una regla que vive del lado del background y se
 * comprueba al importar. Se dice aquí para que quien busque el catálogo completo
 * no concluya que se olvidó.
 *
 * ---------------------------------------------------------------------------
 * NO ethers, NO chrome, NO react
 * ---------------------------------------------------------------------------
 * Todo lo que importa este módulo es UI-safe y ya lo importaba el popup.
 */

import { ErrorCode, type Hex } from "@/types/messages";

import { canonicalChainId, isValidNetworkName } from "./networks";
import { isRpcUrlAllowed } from "./permissions";
import { isValidAddress } from "./tx";

/**
 * 🇪🇸 NOTA: `code` es un número del catálogo EIP-1193 que ya existe, no una
 * cadena propia. Dos espacios de códigos en el mismo proyecto se desincronizan,
 * y además esto tiene que poder convertirse en la respuesta que ve una dApp sin
 * traducir nada por el camino. Todos los fallos de aquí son -32602: la petición
 * está mal formada, no es que la wallet no pueda.
 */
export type ValidationResult = { ok: true } | { ok: false; code: number; message: string };

const VALID: ValidationResult = { ok: true };

function invalid(message: string): ValidationResult {
  return { ok: false, code: ErrorCode.INVALID_PARAMS, message };
}

export function validateAddress(value: unknown): ValidationResult {
  return isValidAddress(value)
    ? VALID
    : invalid("Enter a 40-character address starting with 0x.");
}

export function validateChainId(value: unknown): ValidationResult {
  return canonicalChainId(value) === null
    ? invalid('Enter a chain id in hexadecimal, like "0x1".')
    : VALID;
}

export function validateRpcUrl(value: unknown): ValidationResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid("Enter the URL of an RPC endpoint.");
  }

  return isRpcUrlAllowed(value.trim())
    ? VALID
    : invalid("The endpoint must use https, or http only on localhost.");
}

export function validateNetworkName(value: unknown): ValidationResult {
  return isValidNetworkName(value) ? VALID : invalid("Give the network a name.");
}

// ============================================================================
// The amount — the only rule this module actually adds
// ============================================================================

const WEI_PER_ETH = 10n ** 18n;
export const ETH_DECIMALS = 18;

/**
 * 🇪🇸 NOTA: dígitos, un punto opcional, y más dígitos. Nada más, y cada exclusión
 * está elegida:
 *
 *   - sin signo: un importe negativo no es un importe pequeño, es otra cosa.
 *   - sin notación exponencial: `1e18` es ambiguo a la vista y quien lo escriba
 *     casi seguro quería otra cosa.
 *   - sin `.5` ni `5.`: se aceptan y luego hay que decidir qué significan. Es más
 *     barato pedir la forma canónica que adivinar.
 */
const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * A decimal ETH string to wei, or null if it is not one.
 *
 * ---------------------------------------------------------------------------
 * BigInt ALL THE WAY DOWN, LIKE formatEther
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: nada de `Number` en ningún paso. Un `parseFloat("0.1") * 1e18` da
 * 100000000000000000 aproximadamente, con el error escondido en los últimos
 * dígitos — y ahí es donde vive la diferencia entre "gasta todo tu saldo" y
 * "gasta un wei más del que tienes". Los wei no caben en un `number`.
 *
 * El `padEnd` es el espejo del `padStart` de `formatEther` y falla igual de
 * silenciosamente si falta: "0.1" tiene una parte fraccionaria de un dígito, y
 * sin rellenar por la DERECHA hasta 18 se convertiría en 1 wei en vez de 10^17.
 */
export function parseAmount(input: string): bigint | null {
  const trimmed = input.trim();
  if (!DECIMAL.test(trimmed)) return null;

  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > ETH_DECIMALS) return null;

  return BigInt(whole) * WEI_PER_ETH + BigInt(fraction.padEnd(ETH_DECIMALS, "0"));
}

export interface AmountLimits {
  /** The account's balance, in wei. */
  balanceWei: bigint;
  /** What the network will take for this transaction, in wei. */
  feeWei: bigint;
}

/**
 * ---------------------------------------------------------------------------
 * THE CEILING IS BALANCE MINUS FEE, AND THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: validar contra el saldo a secas es el error clásico, y es peor de lo
 * que parece: el usuario pulsa "enviar todo", la wallet lo acepta, y el nodo
 * rechaza la transacción por fondos insuficientes DESPUÉS de haberle enseñado
 * una ventana de firma. El coste no es solo la confusión — es que enseñar
 * ventanas para cosas que van a fallar enseña a aprobarlas sin leerlas.
 *
 * El borde es INCLUSIVO: gastar exactamente saldo menos fee es correcto y deja
 * la cuenta a cero, que es una cosa que la gente hace a propósito.
 *
 * Y hay un caso que merece su propio mensaje: cuando la fee sola se come el
 * saldo, no hay ninguna cantidad válida. Decir "excede el máximo" ahí sería
 * cierto y no ayudaría a nadie.
 */
export function validateAmount(input: string, { balanceWei, feeWei }: AmountLimits): ValidationResult {
  const wei = parseAmount(input);

  if (wei === null) {
    return invalid(`Enter an amount in ETH, with at most ${ETH_DECIMALS} decimals.`);
  }
  if (wei === 0n) return invalid("Enter an amount greater than zero.");

  const spendable = balanceWei - feeWei;
  if (spendable <= 0n) {
    return invalid("This account cannot cover the network fee on its own.");
  }
  if (wei > spendable) {
    return invalid("That is more than this account can send once the fee is taken out.");
  }

  return VALID;
}

/** Convenience for callers holding a Hex balance, which is most of them. */
export function toWei(value: Hex): bigint {
  return BigInt(value);
}
