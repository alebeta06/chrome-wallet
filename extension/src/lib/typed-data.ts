/**
 * @file lib/typed-data.ts
 * @description Validating an EIP-712 payload, and turning it into something a
 * person can read before they sign it.
 *
 * Pure: no ethers, no storage, no chrome. The payload arrives as a JSON STRING
 * written by a web page, which makes every field in it hostile input.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DESERVES MORE CARE THAN A TRANSACTION
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: una firma EIP-712 no cuesta gas, no aparece en el explorador y no
 * mueve nada en el momento de firmarla. Por eso se percibe como inofensiva — y
 * por eso es el vector preferido. Un `Permit` firmado da permiso a un tercero
 * para mover tus tokens sin que haya ninguna transacción de por medio: la
 * víctima no ve nada raro hasta que los fondos ya no están.
 *
 * Lo que separa firmar un login de firmar una autorización de gasto es el
 * `domain` —sobre todo el `verifyingContract`— y el `primaryType`. De ahí que
 * este módulo exista para que la ventana pueda enseñar los dos.
 */

import {
  ProviderErrors,
  type Address,
  type Hex,
  type TypedDataPayload,
} from "@/types/messages";

import { ProviderError, invalidParams } from "./errors";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * How deep the renderer will walk before giving up and showing raw JSON.
 *
 * 🇪🇸 NOTA: no es una decisión estética. `types` lo escribe una web, y dos tipos
 * que se referencien mutuamente —`A` con un campo de tipo `B`, `B` con un campo
 * de tipo `A`— harían que el recorrido no terminara nunca. Un tope convierte un
 * cuelgue de la ventana de firma en una línea de JSON fea.
 */
export const MAX_RENDER_DEPTH = 4;

export interface ParsedTypedData {
  /** The account this origin is allowed to sign with. */
  address: Address;
  /** The payload exactly as it arrived, EIP712Domain included if it was there. */
  payload: TypedDataPayload;
  /** The original JSON string, which is what ethers is given to sign. */
  raw: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses and authorises an eth_signTypedData_v4 request.
 *
 * 🇪🇸 NOTA: el mismo control del `from` de la Fase 6, y por el mismo motivo. Una
 * dApp conectada a tu cuenta 0 no puede pedirte que firmes como la cuenta 3: el
 * permiso que diste era para UNA cuenta. Se rechaza con 4100 y sin abrir
 * ventana.
 */
export function parseTypedDataParams(
  params: unknown[],
  authorisedAccount: Address,
): ParsedTypedData {
  const [address, raw] = params;

  if (typeof address !== "string" || !ADDRESS.test(address)) {
    throw invalidParams("eth_signTypedData_v4 expects [address, typedData].");
  }

  if (address.toLowerCase() !== authorisedAccount.toLowerCase()) {
    throw new ProviderError(
      ProviderErrors.unauthorized(`This site may only sign as ${authorisedAccount}.`),
    );
  }

  /**
   * 🇪🇸 NOTA: el payload llega como CADENA JSON, no como objeto — así lo define
   * el método y así lo mandan las dApps. `JSON.parse` sobre basura lanza un
   * `SyntaxError`, que sin este try acabaría redactado a un -32603 genérico por
   * `toSerializedError`: "error interno de la wallet" cuando el problema es que
   * la dApp mandó JSON roto.
   */
  if (typeof raw !== "string") {
    throw invalidParams("eth_signTypedData_v4 expects the typed data as a JSON string.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidParams("The typed data is not valid JSON.");
  }

  return { address: authorisedAccount, payload: assertPayload(parsed), raw };
}

function assertPayload(parsed: unknown): TypedDataPayload {
  if (!isRecord(parsed)) {
    throw invalidParams("The typed data must be an object.");
  }

  const { domain, types, primaryType, message } = parsed;

  if (!isRecord(domain)) throw invalidParams('The typed data needs a "domain" object.');
  if (!isRecord(types)) throw invalidParams('The typed data needs a "types" object.');
  if (!isRecord(message)) throw invalidParams('The typed data needs a "message" object.');

  if (typeof primaryType !== "string" || primaryType.length === 0) {
    throw invalidParams('The typed data needs a "primaryType" string.');
  }

  /**
   * 🇪🇸 NOTA: un `primaryType` que no está declarado en `types` es un payload
   * roto, y ethers lo rechazaría igual — pero mucho más adelante, después de
   * haberle enseñado al usuario una ventana de firma para algo que nunca se iba
   * a poder firmar. Mejor cortarlo antes de molestar a nadie.
   */
  const fields = types[primaryType];
  if (!Array.isArray(fields)) {
    throw invalidParams(`"${primaryType}" is not declared in the typed data's types.`);
  }

  for (const [name, declared] of Object.entries(types)) {
    if (!Array.isArray(declared)) {
      throw invalidParams(`Type "${name}" must be an array of fields.`);
    }
    for (const field of declared) {
      if (!isRecord(field) || typeof field.name !== "string" || typeof field.type !== "string") {
        throw invalidParams(`Type "${name}" has a field without a name and a type.`);
      }
    }
  }

  return parsed as unknown as TypedDataPayload;
}

/**
 * The chain this signature would be valid on, if the domain names one.
 *
 * 🇪🇸 NOTA: `domain.chainId` es opcional en EIP-712 y llega como número o como
 * hex según la dApp. Un dominio sin chainId es legal —un login que vale en
 * cualquier red— y no hay nada que comparar.
 */
export function domainChainId(payload: TypedDataPayload): Hex | null {
  const { chainId } = payload.domain;
  if (chainId === undefined || chainId === null) return null;

  try {
    if (typeof chainId === "number") {
      return Number.isInteger(chainId) && chainId >= 0 ? (`0x${chainId.toString(16)}` as Hex) : null;
    }
    if (typeof chainId === "string") {
      return `0x${BigInt(chainId).toString(16)}` as Hex;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * The types ethers will accept, which is not the types that arrived.
 *
 * ---------------------------------------------------------------------------
 * THE EIP712Domain GOTCHA
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: el estándar define `EIP712Domain` como un tipo más, así que la
 * mayoría de las dApps lo incluyen en `types` — con razón. Pero ethers v6 lo
 * construye SOLO a partir del `domain`, y si además se lo pasas en `types`
 * revienta con `ambiguous primary types or unused types`. Comprobado, no
 * supuesto.
 *
 * Se borra sobre una COPIA. El objeto original se guarda en la solicitud
 * pendiente para que la ventana pueda mostrar el payload tal y como llegó: si se
 * mutara aquí, el usuario vería algo distinto de lo que su dApp envió.
 */
export function signableTypes(
  payload: TypedDataPayload,
): Record<string, Array<{ name: string; type: string }>> {
  const types = { ...payload.types };
  delete types.EIP712Domain;
  return types;
}

// ============================================================================
// Rendering
// ============================================================================

export interface RenderedField {
  label: string;
  type: string;
  /** Present for a leaf. Structs and arrays carry `children` instead. */
  value?: string;
  children?: RenderedField[];
  /** True when the depth cap stopped the walk and `value` is raw JSON. */
  truncated?: boolean;
}

/** `Person[]` -> `Person`, `Person[2]` -> `Person`, `string` -> null. */
function arrayElementType(type: string): string | null {
  const match = /^(.+)\[\d*\]$/.exec(type);
  return match === null ? null : match[1];
}

function leaf(label: string, type: string, value: unknown): RenderedField {
  return { label, type, value: formatScalar(value) };
}

/**
 * 🇪🇸 NOTA: nada de `JSON.stringify` sobre el valor entero. Los tipos están
 * declarados, así que se puede enseñar campo a campo con su nombre — que es la
 * diferencia entre "aquí hay un objeto" y "esto autoriza a 0xCcCc… a gastar".
 */
function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Turns a message into a labelled tree, following the declared types. */
export function describeMessage(
  payload: TypedDataPayload,
  depth = MAX_RENDER_DEPTH,
): RenderedField[] {
  return describeStruct(payload.types, payload.primaryType, payload.message, depth);
}

function describeStruct(
  types: TypedDataPayload["types"],
  typeName: string,
  value: unknown,
  depth: number,
): RenderedField[] {
  const fields = types[typeName];
  if (fields === undefined || !isRecord(value)) {
    return [{ label: typeName, type: typeName, value: formatScalar(value) }];
  }

  return fields.map((field) => describeField(types, field.name, field.type, value[field.name], depth));
}

function describeField(
  types: TypedDataPayload["types"],
  label: string,
  type: string,
  value: unknown,
  depth: number,
): RenderedField {
  if (depth <= 0) {
    return { label, type, value: JSON.stringify(value) ?? "—", truncated: true };
  }

  const element = arrayElementType(type);
  if (element !== null) {
    if (!Array.isArray(value)) return leaf(label, type, value);

    return {
      label,
      type,
      children: value.map((entry, index) =>
        describeField(types, `${label}[${index}]`, element, entry, depth - 1),
      ),
    };
  }

  if (types[type] !== undefined) {
    return { label, type, children: describeStruct(types, type, value, depth - 1) };
  }

  return leaf(label, type, value);
}

/** The domain, as ordered rows. Only the fields that are actually present. */
export function describeDomain(payload: TypedDataPayload): RenderedField[] {
  const order = ["name", "version", "chainId", "verifyingContract", "salt"] as const;
  const domain = payload.domain as Record<string, unknown>;

  return order
    .filter((key) => domain[key] !== undefined && domain[key] !== null)
    .map((key) => leaf(key, "", domain[key]));
}
