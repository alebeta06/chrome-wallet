import { describe, expect, it, vi } from "vitest";

import { ErrorCode, type Address, type Hex } from "@/types/messages";
import { RpcError } from "@/ui/rpc";
import { createBalancePoller } from "@/ui/hooks/balance-poller";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

const balancesOf = (eth: number): Record<Address, Hex> => ({
  [ADDRESS]: `0x${(BigInt(eth) * 10n ** 18n).toString(16)}` as Hex,
});

/** A promise whose settling this test controls, so responses can be reordered. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-settled promise callback run before assertions. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const pending: Array<ReturnType<typeof deferred<Record<Address, Hex>>>> = [];
  const read = vi.fn(() => {
    const next = deferred<Record<Address, Hex>>();
    pending.push(next);
    return next.promise;
  });

  const onBalances = vi.fn();
  const onError = vi.fn();
  const poller = createBalancePoller(read, { onBalances, onError });

  return { poller, pending, onBalances, onError };
}

describe("createBalancePoller", () => {
  it("reports a single successful read", async () => {
    const { poller, pending, onBalances } = setup();

    const run = poller.poll();
    pending[0].resolve(balancesOf(1));
    await run;

    expect(onBalances).toHaveBeenCalledExactlyOnceWith(balancesOf(1));
  });

  /**
   * 🇪🇸 NOTA: éste es el test por el que la coordinación vive fuera de React.
   *
   * El intervalo es de 5 s. Si una petición tarda 12, hay tres en vuelo a la vez
   * y nada garantiza que vuelvan en orden. Contra Anvil esto no pasa nunca
   * —responde en milisegundos— así que ni las pruebas manuales ni un test de
   * navegador lo ejercitan. Aquí se provoca a mano.
   */
  it("ignores a stale response that lands after a newer one", async () => {
    const { poller, pending, onBalances } = setup();

    const first = poller.poll();
    const second = poller.poll();
    const third = poller.poll();
    expect(pending).toHaveLength(3);

    // The newest answers first, then the two older ones straggle in.
    pending[2].resolve(balancesOf(3));
    await flush();
    pending[0].resolve(balancesOf(1));
    pending[1].resolve(balancesOf(2));
    await Promise.all([first, second, third]);

    expect(onBalances).toHaveBeenCalledExactlyOnceWith(balancesOf(3));
  });

  it("reports every response when they land in order", async () => {
    const { poller, pending, onBalances } = setup();

    const runs = [poller.poll(), poller.poll(), poller.poll()];
    for (const [index, entry] of pending.entries()) {
      entry.resolve(balancesOf(index + 1));
      await flush();
    }
    await Promise.all(runs);

    expect(onBalances).toHaveBeenCalledTimes(3);
    expect(onBalances).toHaveBeenLastCalledWith(balancesOf(3));
  });

  /**
   * 🇪🇸 NOTA: la variante que de verdad muerde. Si la petición #2 va bien y
   * después falla la #1, que salió antes, mostrar su error borraría un dato
   * correcto por culpa de uno viejo — y en pantalla se vería un banner de red
   * caída con la red perfectamente en pie. Un booleano `cancelled` no distingue
   * este caso; el contador sí.
   */
  it("ignores a stale failure that lands after a newer success", async () => {
    const { poller, pending, onBalances, onError } = setup();

    const first = poller.poll();
    const second = poller.poll();

    pending[1].resolve(balancesOf(2));
    await flush();
    pending[0].reject(new RpcError({ code: ErrorCode.CHAIN_DISCONNECTED, message: "stale" }));
    await Promise.all([first, second]);

    expect(onBalances).toHaveBeenCalledExactlyOnceWith(balancesOf(2));
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failure that is the newest response", async () => {
    const { poller, pending, onBalances, onError } = setup();

    const run = poller.poll();
    pending[0].reject(new RpcError({ code: ErrorCode.CHAIN_DISCONNECTED, message: "node down" }));
    await run;

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as RpcError).code).toBe(ErrorCode.CHAIN_DISCONNECTED);
    expect(onBalances).not.toHaveBeenCalled();
  });

  it("wraps a non-RpcError rejection", async () => {
    const { poller, pending, onError } = setup();

    const run = poller.poll();
    pending[0].reject(new Error("something else"));
    await run;

    expect((onError.mock.calls[0][0] as RpcError).code).toBe(ErrorCode.INTERNAL);
  });

  it("stops calling back once stopped, even for in-flight reads", async () => {
    const { poller, pending, onBalances, onError } = setup();

    const run = poller.poll();
    poller.stop();
    pending[0].resolve(balancesOf(1));
    await run;

    expect(onBalances).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("never rejects, so an interval callback cannot produce an unhandled rejection", async () => {
    const { poller, pending } = setup();

    const run = poller.poll();
    pending[0].reject(new Error("boom"));

    await expect(run).resolves.toBeUndefined();
  });
});
