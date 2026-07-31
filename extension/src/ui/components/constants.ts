/** How many accounts a fresh wallet derives. */
export const DEFAULT_ACCOUNT_COUNT = 5;

/**
 * Anvil's public test phrase (spec 23).
 *
 * 🇪🇸 NOTA: está aquí en claro y no pasa nada, y conviene decir por qué: es la
 * frase que imprime Anvil en cada arranque, la conoce todo el mundo y sus
 * cuentas solo tienen fondos en redes locales. Es una comodidad de desarrollo,
 * y el botón que la usa lo dice explícitamente para que nadie la confunda con
 * algo que deba escribirse en una wallet con fondos reales.
 */
export const DEV_MNEMONIC = "test test test test test test test test test test test junk";

/** Word counts BIP-39 accepts. Anything else cannot be a valid phrase. */
export const VALID_WORD_COUNTS = [12, 15, 18, 21, 24];
