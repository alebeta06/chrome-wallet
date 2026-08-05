/**
 * @file lib/typed-data-examples.ts
 * @description Ready-made EIP-712 payloads for the test page.
 *
 * 🇪🇸 NOTA: cada ejemplo es una comprobación manual que deja de necesitar un
 * snippet de consola. El de `EIP712Domain` y el del chainId equivocado son los
 * dos casos que más fácil se rompen y los que nadie prueba si hay que escribir
 * JSON a mano para hacerlo.
 */

const ANVIL_CHAIN_ID = 31337;

const PERSON = [
  { name: "name", type: "string" },
  { name: "wallet", type: "address" },
];

const DOMAIN = {
  name: "Ether Mail",
  version: "1",
  chainId: ANVIL_CHAIN_ID,
  verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
};

const MAIL = {
  domain: DOMAIN,
  types: {
    Person: PERSON,
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
};

export interface TypedDataExample {
  id: string;
  label: string;
  /** What this example is for, shown next to the button. */
  hint: string;
  json: string;
}

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

export const TYPED_DATA_EXAMPLES: readonly TypedDataExample[] = [
  {
    id: "mail",
    label: "Ether Mail",
    hint: "The canonical example from the EIP-712 spec.",
    json: pretty(MAIL),
  },
  {
    id: "with-domain-type",
    label: "With EIP712Domain",
    hint: "Most dApps declare it. ethers throws if it is not stripped first.",
    json: pretty({
      ...MAIL,
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        ...MAIL.types,
      },
    }),
  },
  {
    id: "arrays",
    label: "Nested arrays",
    hint: "An array of structs, to see the window walk the types.",
    json: pretty({
      domain: { name: "Orders", version: "1", chainId: ANVIL_CHAIN_ID },
      types: {
        Item: [
          { name: "sku", type: "string" },
          { name: "amount", type: "uint256" },
        ],
        Order: [
          { name: "buyer", type: "address" },
          { name: "items", type: "Item[]" },
        ],
      },
      primaryType: "Order",
      message: {
        buyer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        items: [
          { sku: "A-1", amount: 2 },
          { sku: "B-7", amount: 5 },
        ],
      },
    }),
  },
  {
    id: "wrong-chain",
    label: "Wrong chainId",
    hint: "Says mainnet while the wallet is on Anvil. Must be refused.",
    json: pretty({ ...MAIL, domain: { ...DOMAIN, chainId: 1 } }),
  },
];

export const DEFAULT_EXAMPLE = TYPED_DATA_EXAMPLES[0];
