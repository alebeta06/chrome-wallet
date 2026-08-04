import { describe, expect, it, vi } from "vitest";

import { ErrorCode, type Address, type Hex, type NetworkConfig } from "@/types/messages";
import { ProviderError } from "@/lib/errors";
import { ANVIL_CHAIN_ID } from "@/lib/networks";
import { createTransactionSender, type ChainWriter } from "@/lib/signer";
import type { ParsedTransaction } from "@/lib/tx";

const PHRASE = "test test test test test test test test test test test junk";
const ANVIL_FIRST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const ANVIL_SECOND = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

const ANVIL: NetworkConfig = {
  chainId: ANVIL_CHAIN_ID,
  name: "Anvil Local",
  rpcUrl: "http://localhost:8545",
  symbol: "ETH",
  explorerUrl: null,
  builtIn: true,
};

function transaction(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    from: ANVIL_FIRST,
    to: ANVIL_SECOND,
    value: "0xde0b6b3a7640000",
    data: "0x",
    ...overrides,
  };
}

interface WriterOptions {
  nonce?: number;
  maxFeePerGas?: bigint | null;
  maxPriorityFeePerGas?: bigint | null;
  broadcastDelayMs?: number;
  failWith?: unknown;
}

/**
 * A fake node. Records the order in which transactions were broadcast, which is
 * what the queue is for.
 */
function fakeChain(options: WriterOptions = {}) {
  const broadcast: string[] = [];
  const noncesAsked: number[] = [];
  let nextNonce = options.nonce ?? 0;
  let destroyed = 0;

  const writer: ChainWriter = {
    getTransactionCount: vi.fn(async () => {
      noncesAsked.push(nextNonce);
      return nextNonce;
    }),
    getFeeData: vi.fn(async () => ({
      maxFeePerGas: options.maxFeePerGas === undefined ? 2_000_000_000n : options.maxFeePerGas,
      maxPriorityFeePerGas:
        options.maxPriorityFeePerGas === undefined ? 1_000_000_000n : options.maxPriorityFeePerGas,
    })),
    estimateGas: vi.fn(async () => 21_000n),
    broadcast: vi.fn(async (signed: string) => {
      if (options.failWith !== undefined) throw options.failWith;
      if (options.broadcastDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.broadcastDelayMs));
      }
      broadcast.push(signed);
      // A broadcast transaction is in the mempool, so "pending" moves on.
      nextNonce += 1;
      return { hash: `0xhash${broadcast.length}` } as never;
    }),
    destroy: vi.fn(() => {
      destroyed += 1;
    }),
  };

  return {
    writer,
    broadcast,
    noncesAsked,
    destroyed: () => destroyed,
    sender: createTransactionSender(() => writer),
  };
}

async function expectCode(promise: Promise<unknown>, code: number): Promise<ProviderError> {
  const outcome: unknown = await promise.then(
    (value) => value,
    (cause: unknown) => cause,
  );

  if (!(outcome instanceof ProviderError)) {
    throw new Error(`expected a ProviderError, got ${String(outcome)}`);
  }
  expect(outcome.serialized.code).toBe(code);
  return outcome;
}

const send = (sender: ReturnType<typeof fakeChain>["sender"], tx = transaction()) =>
  sender.send({ network: ANVIL, phrase: PHRASE, accountIndex: 0, transaction: tx });

describe("signing and sending", () => {
  it("returns the transaction hash", async () => {
    const { sender } = fakeChain();

    expect(await send(sender)).toBe("0xhash1");
  });

  /**
   * 🇪🇸 NOTA: `type: 2` explícito, no confiado a la inferencia de ethers. Suele
   * acertar, pero "suele" no es garantía: una transacción legacy en una red
   * EIP-1559 paga de más y puede quedarse atascada. Se comprueba además en el
   * recibo durante las comprobaciones manuales.
   */
  it("signs an EIP-1559 transaction, not a legacy one", async () => {
    const { sender, broadcast } = fakeChain();

    await send(sender);

    // A type-2 envelope is RLP prefixed with 0x02.
    expect(broadcast[0].startsWith("0x02")).toBe(true);
  });

  it("releases the provider even on the happy path", async () => {
    const { sender, destroyed } = fakeChain();

    await send(sender);

    expect(destroyed()).toBe(1);
  });

  it("releases the provider when the send fails", async () => {
    const { sender, destroyed } = fakeChain({ failWith: { code: "SERVER_ERROR" } });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expectCode(send(sender), ErrorCode.CHAIN_DISCONNECTED);

    expect(destroyed()).toBe(1);
  });

  /**
   * 🇪🇸 NOTA: barato y cierra el caso en el que un índice equivocado —por un
   * `connectedSites` corrupto o un bug futuro— firmaría con otra cuenta sin que
   * nada lo notara. El `from` ya está autorizado; esto comprueba que la CLAVE
   * derivada es de verdad la suya.
   */
  it("refuses when the derived key is not the authorised address", async () => {
    const { sender, broadcast } = fakeChain();
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Account index 1 derives ANVIL_SECOND, but the transaction says ANVIL_FIRST.
    await expectCode(
      sender.send({ network: ANVIL, phrase: PHRASE, accountIndex: 1, transaction: transaction() }),
      ErrorCode.INTERNAL,
    );

    expect(broadcast).toEqual([]);
  });
});

describe("fees", () => {
  it("takes the node's fee data when the dApp sent none", async () => {
    const { sender, writer } = fakeChain();

    await send(sender);

    expect(writer.getFeeData).toHaveBeenCalled();
  });

  /**
   * 🇪🇸 NOTA: si la dApp manda las fees, se respetan. Es una petición legítima —
   * puede querer acelerar una transacción — y sobrescribirlas en silencio haría
   * que la wallet enviara algo distinto de lo que se le pidió.
   */
  it("respects fees the dApp set explicitly", async () => {
    const { sender, writer } = fakeChain();

    await send(
      sender,
      transaction({ maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x3b9aca00" }),
    );

    // Still asked, but the answer is not what got signed — see the next test.
    expect(writer.estimateGas).toHaveBeenCalled();
  });

  it("estimates gas only when the dApp did not set it", async () => {
    const { sender, writer } = fakeChain();

    await send(sender, transaction({ gas: "0x5208" }));

    expect(writer.estimateGas).not.toHaveBeenCalled();
  });

  /**
   * 🇪🇸 NOTA: 4901 y no -32603. Un nodo que no sabe decir el precio del gas es
   * un problema de red, no un bug de la wallet, y la dApp tiene que poder
   * distinguirlo para decir "reintenta" en vez de "algo se ha roto".
   */
  it("answers 4901 when the node has no gas price to give", async () => {
    const { sender } = fakeChain({ maxFeePerGas: null, maxPriorityFeePerGas: null });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expectCode(send(sender), ErrorCode.CHAIN_DISCONNECTED);
  });

  it("still signs when the node gives no price but the dApp did", async () => {
    const { sender } = fakeChain({ maxFeePerGas: null, maxPriorityFeePerGas: null });

    const hash = await send(
      sender,
      transaction({ maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x3b9aca00" }),
    );

    expect(hash).toBe("0xhash1");
  });
});

describe("the nonce", () => {
  it("asks the node for the pending nonce", async () => {
    const { sender, writer } = fakeChain({ nonce: 7 });

    await send(sender);

    expect(writer.getTransactionCount).toHaveBeenCalledWith(ANVIL_FIRST, "pending");
  });

  it("uses an explicit nonce without asking", async () => {
    const { sender, writer } = fakeChain();

    await send(sender, transaction({ nonce: "0x9" }));

    expect(writer.getTransactionCount).not.toHaveBeenCalled();
  });

  /**
   * ------------------------------------------------------------------------
   * THE BUG THE QUEUE EXISTS TO NOT HAVE
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: sin serializar, las dos llamadas piden el nonce ANTES de que
   * ninguna haya difundido, las dos leen el mismo, y la segunda muere con
   * `replacement transaction underpriced`. El envío lleva un retardo a propósito
   * para que el solapamiento sea real y no una casualidad del scheduler.
   */
  it("does not reuse a nonce across two overlapping sends", async () => {
    const { sender, noncesAsked } = fakeChain({ nonce: 5, broadcastDelayMs: 10 });

    await Promise.all([send(sender), send(sender)]);

    expect(noncesAsked).toEqual([5, 6]);
  });

  it("keeps the order of three overlapping sends", async () => {
    const { sender, noncesAsked, broadcast } = fakeChain({ nonce: 0, broadcastDelayMs: 5 });

    await Promise.all([send(sender), send(sender), send(sender)]);

    expect(noncesAsked).toEqual([0, 1, 2]);
    expect(broadcast).toHaveLength(3);
  });

  /**
   * 🇪🇸 NOTA: un envío que falla no puede atascar la cola. Si el `.then` de
   * error no volviera a lanzar la tarea, la primera transacción rechazada
   * dejaría la wallet incapaz de enviar nada más hasta reiniciar la extensión.
   */
  it("keeps working after a failed send", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let failNext = true;

    const writer: ChainWriter = {
      getTransactionCount: async () => 3,
      getFeeData: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      estimateGas: async () => 21_000n,
      broadcast: async () => {
        if (failNext) {
          failNext = false;
          throw { code: "INSUFFICIENT_FUNDS" };
        }
        return { hash: "0xafterwards" } as never;
      },
      destroy: () => {},
    };
    const sender = createTransactionSender(() => writer);

    await expectCode(send(sender), ErrorCode.INTERNAL);
    expect(await send(sender)).toBe("0xafterwards");
  });
});

describe("what the dApp is told when a send fails", () => {
  /**
   * ------------------------------------------------------------------------
   * A FAILED SEND IS NEVER 4001
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: el usuario YA aprobó. Si esto llegara como 4001, la dApp enseñaría
   * "cancelaste la transacción" a alguien que la aprobó y se quedó sin fondos:
   * le culpa de algo que no hizo y esconde la causa real. 4001 queda reservado
   * en exclusiva a "el humano dijo que no".
   */
  it.each([
    ["INSUFFICIENT_FUNDS", ErrorCode.INTERNAL, "Not enough ETH"],
    ["NONCE_EXPIRED", ErrorCode.INTERNAL, "already in flight"],
    ["REPLACEMENT_UNDERPRICED", ErrorCode.INTERNAL, "already in flight"],
    ["CALL_EXCEPTION", ErrorCode.INTERNAL, "would fail on-chain"],
    ["NETWORK_ERROR", ErrorCode.CHAIN_DISCONNECTED, "Cannot reach"],
    ["SERVER_ERROR", ErrorCode.CHAIN_DISCONNECTED, "Cannot reach"],
    ["TIMEOUT", ErrorCode.CHAIN_DISCONNECTED, "Cannot reach"],
  ])("maps %s to %i", async (ethersCode, code, fragment) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sender } = fakeChain({ failWith: { code: ethersCode } });

    const error = await expectCode(send(sender), code);

    expect(error.serialized.code).not.toBe(ErrorCode.USER_REJECTED);
    expect(error.serialized.message).toContain(fragment);
  });

  it("falls back to -32603 for an error it does not recognise", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sender } = fakeChain({ failWith: new Error("something new") });

    await expectCode(send(sender), ErrorCode.INTERNAL);
  });

  /**
   * 🇪🇸 NOTA: los mensajes se escriben en `signer.ts` y no se reenvía el de
   * ethers, porque un error de ethers puede llevar dentro la rpcUrl con su API
   * key — y ese objeto cruzaría hasta la dApp.
   */
  it("does not leak the rpc url into the error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sender } = fakeChain({
      failWith: new Error("could not reach http://localhost:8545?apiKey=secret"),
    });

    const error = await expectCode(send(sender), ErrorCode.INTERNAL);

    expect(JSON.stringify(error.serialized)).not.toContain("apiKey");
    expect(JSON.stringify(error.serialized)).not.toContain("8545");
  });
});

describe("estimate", () => {
  it("gives the approval window its numbers", async () => {
    const { sender } = fakeChain();

    const estimate = await sender.estimate({ network: ANVIL, transaction: transaction() });

    expect(estimate).toEqual({
      maxFeePerGas: "0x77359400",
      maxPriorityFeePerGas: "0x3b9aca00",
      gas: "0x5208",
    });
  });

  /**
   * 🇪🇸 NOTA: devuelve null, no lanza. Esto solo alimenta la ventana, y no poder
   * estimar no puede impedir firmar: si fue un parpadeo del nodo, el envío
   * funciona igual. La ventana enseña "no se pudo estimar" en vez de un número
   * inventado, que sería mucho peor que no enseñar nada.
   */
  it("returns null instead of throwing when the node is down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const writer: ChainWriter = {
      getTransactionCount: async () => 0,
      getFeeData: async () => {
        throw new Error("node is down");
      },
      estimateGas: async () => 21_000n,
      broadcast: async () => ({ hash: "0x" }) as never,
      destroy: () => {},
    };

    const estimate = await createTransactionSender(() => writer).estimate({
      network: ANVIL,
      transaction: transaction(),
    });

    expect(estimate).toBeNull();
  });

  it("never runs through the send queue", async () => {
    const { sender, broadcast } = fakeChain();

    await sender.estimate({ network: ANVIL, transaction: transaction() });

    expect(broadcast).toEqual([]);
  });
});

describe("value and calldata reach the signature", () => {
  it("signs a contract call with its data", async () => {
    const { sender, broadcast } = fakeChain();
    const data = "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead" as Hex;

    await send(sender, transaction({ value: "0x0", data }));

    // The calldata is inside the RLP payload.
    expect(broadcast[0].includes("a9059cbb")).toBe(true);
  });
});
