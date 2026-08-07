import { createServer, type Server } from "node:http";

import { JsonRpcProvider, Network } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NetworkConfig } from "@/types/messages";
import { createRpcProvider } from "@/lib/chain";

/**
 * ---------------------------------------------------------------------------
 * THIS TEST COUNTS REQUESTS ON THE WIRE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: no hay mocks aquí a propósito. Lo que se comprueba es cuántas
 * peticiones HTTP salen de verdad, y eso no se puede afirmar espiando a ethers:
 * la detección de red vive dentro de `JsonRpcApiProvider` y cambia entre
 * versiones. Un servidor local que cuenta cuerpos JSON-RPC es la única forma de
 * medir el comportamiento real de la versión instalada.
 *
 * Existe porque las dos opciones del provider parecen redundantes y no lo son:
 * `staticNetwork: true` sin red en el constructor NO evita el `eth_chainId`, y
 * la red en el constructor sin `staticNetwork` lo empeora — uno por llamada.
 * Sin este test, el primero que "simplifique" el constructor devuelve la wallet
 * a una ida y vuelta extra por cada consulta de saldo, cada 5 s, sin romper
 * ningún otro test.
 */

const CHAIN_ID = "0x7a69";

let server: Server;
let url: string;
let methods: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const payload: unknown = JSON.parse(body);
      const batch = Array.isArray(payload) ? payload : [payload];

      const answers = batch.map((entry) => {
        const call = entry as { id: number; method: string };
        methods.push(call.method);

        return {
          jsonrpc: "2.0",
          id: call.id,
          result: call.method === "eth_chainId" ? CHAIN_ID : "0x0",
        };
      });

      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(payload) ? answers : answers[0]));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function network(): NetworkConfig {
  return {
    chainId: CHAIN_ID,
    name: "Local probe",
    rpcUrl: url,
    symbol: "ETH",
    explorerUrl: null,
    builtIn: false,
  };
}

/**
 * 🇪🇸 NOTA: DOS direcciones distintas, y no la misma dos veces. Ethers cachea
 * las peticiones idénticas durante `cacheTimeout` (250 ms por defecto), así que
 * dos `getBalance` a la misma dirección salen como UNA sola al cable. Con la
 * misma dirección este test mediría la caché de ethers en vez de lo que dice
 * medir, y contaría de menos justo en el caso que tiene que detectar.
 */
const SOMEBODY = "0x0000000000000000000000000000000000000001";
const SOMEBODY_ELSE = "0x0000000000000000000000000000000000000002";

/** Two reads, so a per-call detection is visible as two extra requests. */
async function countMethods(provider: JsonRpcProvider): Promise<string[]> {
  methods = [];
  try {
    await provider.getBalance(SOMEBODY);
    await provider.getBalance(SOMEBODY_ELSE);
  } finally {
    provider.destroy();
  }
  return methods;
}

describe("createRpcProvider", () => {
  it("asks the node nothing but the balances", async () => {
    const seen = await countMethods(createRpcProvider(network()));

    expect(seen).toEqual(["eth_getBalance", "eth_getBalance"]);
    expect(seen.filter((method) => method === "eth_chainId")).toHaveLength(0);
  });

  /**
   * 🇪🇸 NOTA: los dos contraejemplos van en el mismo archivo y no en un
   * comentario porque un comentario no falla cuando deja de ser verdad. Si una
   * versión futura de ethers cambiara el comportamiento, estas dos expectativas
   * se ponen en rojo y alguien lee la NOTA de `chain.ts` antes de tocar nada.
   */
  it("would pay an eth_chainId without the network in the constructor", async () => {
    const seen = await countMethods(
      new JsonRpcProvider(url, undefined, { batchMaxCount: 1, staticNetwork: true }),
    );

    expect(seen.filter((method) => method === "eth_chainId")).toHaveLength(1);
  });

  it("would pay one eth_chainId per call without staticNetwork", async () => {
    const seen = await countMethods(
      new JsonRpcProvider(url, Network.from(BigInt(CHAIN_ID)), { batchMaxCount: 1 }),
    );

    expect(seen.filter((method) => method === "eth_chainId")).toHaveLength(2);
  });

  /**
   * 🇪🇸 NOTA: `Network.from` con un chainId que no está en el registro de ethers
   * devuelve una red "unknown" en vez de lanzar. Es lo que permite que una red
   * añadida en runtime funcione igual que las dos que vienen de serie.
   */
  it("works for a chain id ethers has never heard of", async () => {
    const exotic = { ...network(), chainId: "0x4d2" as const };
    const seen = await countMethods(createRpcProvider(exotic));

    expect(seen).toEqual(["eth_getBalance", "eth_getBalance"]);
  });

  /** dRPC rejects batches, so two concurrent reads must go out as two requests. */
  it("never batches", async () => {
    const provider = createRpcProvider(network());
    methods = [];

    try {
      await Promise.all([provider.getBalance(SOMEBODY), provider.getBalance(SOMEBODY_ELSE)]);
    } finally {
      provider.destroy();
    }

    expect(methods).toEqual(["eth_getBalance", "eth_getBalance"]);
  });
});
