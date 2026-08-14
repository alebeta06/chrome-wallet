import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_LOG_ENTRIES, type LogEntry } from "@/types/messages";
import {
  MAX_DETAIL_CHARS,
  QUOTA_KEPT_ENTRIES,
  TRUNCATION_SUFFIX,
  capDetail,
  createLogEntry,
  createLogWriter,
  sanitizeDetail,
} from "@/lib/logs";
import { createWalletStorage, type StorageArea } from "@/lib/storage";
import { createMemoryStorageArea, type MemoryStorageArea } from "./helpers/memory-storage-area";

const ORIGIN = "https://dapp.example";

/** The phrase a dApp must never be able to get written to disk. */
const SECRET_PHRASE = "test test test test test test test test test test test junk";

function setup(seed: Record<string, unknown> = {}) {
  const area = createMemoryStorageArea(seed);
  return { area, writer: createLogWriter(createWalletStorage(area)) };
}

function storedLogs(area: MemoryStorageArea): LogEntry[] {
  return (area.snapshot()["cc:logs"] as LogEntry[] | undefined) ?? [];
}

function seededLogs(count: number): LogEntry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `seed-${index}`,
    ts: index,
    level: "call" as const,
    label: `seeded-${index}`,
  }));
}

/**
 * A storage area whose `set` fails a given number of times before working.
 *
 * 🇪🇸 NOTA: falla las N PRIMERAS veces en vez de siempre, porque lo que hay que
 * distinguir es "reintentó una vez y funcionó" de "no reintentó". Un doble que
 * falle siempre no puede separar esos dos casos.
 */
function failingArea(
  failures: number,
  message: string,
  seed: Record<string, unknown> = {},
): MemoryStorageArea {
  // Seeded through the constructor: seeding with `set` would eat a failure.
  const area = createMemoryStorageArea(seed);
  let remaining = failures;
  const realSet = area.set.bind(area);

  return {
    ...area,
    async set(items: Record<string, unknown>): Promise<void> {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error(message);
      }
      return realSet(items);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLogEntry", () => {
  it("stamps an id and a timestamp", () => {
    const entry = createLogEntry("call", "eth_chainId");

    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.ts).toBeGreaterThan(0);
    expect(entry.level).toBe("call");
    expect(entry.label).toBe("eth_chainId");
  });

  it("gives every entry a distinct id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createLogEntry("call", "x").id));

    expect(ids.size).toBe(50);
  });

  it("omits origin and detail when there is nothing to record", () => {
    expect(createLogEntry("event", "chainChanged")).not.toHaveProperty("origin");
    expect(createLogEntry("event", "chainChanged")).not.toHaveProperty("detail");
  });

  it("records origin and detail when given", () => {
    const entry = createLogEntry("call", "eth_getBalance", ORIGIN, { chainId: "0x1" });

    expect(entry.origin).toBe(ORIGIN);
    expect(entry.detail).toEqual({ chainId: "0x1" });
  });
});

describe("sanitizeDetail", () => {
  it("keeps a flat object of scalars", () => {
    expect(sanitizeDetail({ method: "eth_call", accountIndex: 2, ok: false, gas: null })).toEqual({
      method: "eth_call",
      accountIndex: 2,
      ok: false,
      gas: null,
    });
  });

  it("drops the keys whose value is not a scalar", () => {
    expect(sanitizeDetail({ chainId: "0x1", nested: { secret: SECRET_PHRASE } })).toEqual({
      chainId: "0x1",
    });
  });

  it("returns undefined for anything that is not a plain object", () => {
    expect(sanitizeDetail(undefined)).toBeUndefined();
    expect(sanitizeDetail(null)).toBeUndefined();
    expect(sanitizeDetail("a bare string")).toBeUndefined();
    expect(sanitizeDetail([SECRET_PHRASE])).toBeUndefined();
  });

  it("returns undefined rather than an empty object", () => {
    expect(sanitizeDetail({ types: {}, message: {} })).toBeUndefined();
  });
});

describe("capDetail", () => {
  it("leaves a small detail as the object it was", () => {
    expect(capDetail({ chainId: "0x1" })).toEqual({ chainId: "0x1" });
  });

  it("falls back to a truncated string when the serialised form is too long", () => {
    const capped = capDetail({ note: "x".repeat(MAX_DETAIL_CHARS * 2) });

    expect(typeof capped).toBe("string");
    expect(capped as string).toHaveLength(MAX_DETAIL_CHARS);
    expect((capped as string).endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });
});

describe("createLogWriter", () => {
  it("creates the log on the first entry", async () => {
    const { area, writer } = setup();

    await writer.append(createLogEntry("call", "eth_chainId", ORIGIN));

    expect(storedLogs(area)).toHaveLength(1);
    expect(storedLogs(area)[0]?.label).toBe("eth_chainId");
  });

  it("appends in order, newest last, keeping what was there", async () => {
    const { area, writer } = setup({ "cc:logs": seededLogs(2) });

    await writer.append(createLogEntry("call", "first"));
    await writer.append(createLogEntry("call", "second"));

    expect(storedLogs(area).map((entry) => entry.label)).toEqual([
      "seeded-0",
      "seeded-1",
      "first",
      "second",
    ]);
  });

  it("caps at MAX_LOG_ENTRIES, dropping the oldest", async () => {
    const { area, writer } = setup({ "cc:logs": seededLogs(MAX_LOG_ENTRIES) });

    await writer.append(createLogEntry("call", "the newest"));

    const logs = storedLogs(area);
    expect(logs).toHaveLength(MAX_LOG_ENTRIES);
    expect(logs[0]?.label).toBe("seeded-1");
    expect(logs[MAX_LOG_ENTRIES - 1]?.label).toBe("the newest");
  });

  it("trims a log that is already over the cap", async () => {
    const { area, writer } = setup({ "cc:logs": seededLogs(MAX_LOG_ENTRIES + 40) });

    await writer.append(createLogEntry("call", "the newest"));

    expect(storedLogs(area)).toHaveLength(MAX_LOG_ENTRIES);
  });

  /**
   * ------------------------------------------------------------------------
   * THE TEST THE ALLOWLIST EXISTS FOR
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: el campo se llama `userBackupPhrase`, y el nombre es lo que se está
   * probando. Con la vieja denylist —`SECRET_PARAM_METHODS`— este test habría
   * pasado igual, porque `eth_signTypedData_v4` estaba en la lista: no habría
   * distinguido las dos implementaciones.
   *
   * Lo que lo hace válido es que el nombre del campo lo elige la dApp. Ninguna
   * lista de métodos ni de claves puede anticiparlo, así que lo único que
   * protege es que la ESTRUCTURA no pase: un payload de firma es anidado, y el
   * filtro solo deja escalares planos.
   */
  it("does not persist a secret buried in a dApp payload", async () => {
    const { area, writer } = setup();

    const payload = {
      types: { Foo: [{ name: "userBackupPhrase", type: "string" }] },
      domain: { name: "Evil dApp" },
      message: { userBackupPhrase: SECRET_PHRASE },
    };

    await writer.append(createLogEntry("call", "eth_signTypedData_v4", ORIGIN, payload as never));

    const written = JSON.stringify(area.snapshot());
    expect(written).not.toContain(SECRET_PHRASE);
    expect(written).not.toContain("userBackupPhrase");
    expect(storedLogs(area)[0]).not.toHaveProperty("detail");
  });

  it("keeps the scalars a caller built on purpose, and only those", async () => {
    const { area, writer } = setup();

    await writer.append(
      createLogEntry("call", "eth_sendTransaction", ORIGIN, {
        chainId: "0xaa36a7",
        accountIndex: 1,
      }),
    );

    expect(storedLogs(area)[0]?.detail).toEqual({ chainId: "0xaa36a7", accountIndex: 1 });
  });

  it("truncates a detail that is too long", async () => {
    const { area, writer } = setup();

    await writer.append(createLogEntry("call", "x", ORIGIN, { note: "y".repeat(5000) }));

    const detail = storedLogs(area)[0]?.detail;
    expect(typeof detail).toBe("string");
    expect(detail as string).toHaveLength(MAX_DETAIL_CHARS);
    expect((detail as string).endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it("copies only the known fields of an entry", async () => {
    const { area, writer } = setup();

    const smuggled = {
      ...createLogEntry("call", "eth_chainId", ORIGIN),
      phrase: SECRET_PHRASE,
    } as LogEntry;

    await writer.append(smuggled);

    expect(Object.keys(storedLogs(area)[0] ?? {}).sort()).toEqual([
      "id",
      "label",
      "level",
      "origin",
      "ts",
    ]);
    expect(JSON.stringify(area.snapshot())).not.toContain(SECRET_PHRASE);
  });

  /**
   * ------------------------------------------------------------------------
   * TRULY CONCURRENT: NO await BETWEEN THE CALLS
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: un `await` intermedio serializaría el test a mano y comprobaría un
   * escenario que el navegador no produce. `chrome.runtime.onMessage` despacha
   * concurrente, así que las llamadas salen a la vez y se espera al final.
   */
  it("does not lose an entry when several are appended at once", async () => {
    const { area, writer } = setup();

    await Promise.all([
      writer.append(createLogEntry("call", "one")),
      writer.append(createLogEntry("call", "two")),
      writer.append(createLogEntry("call", "three")),
      writer.append(createLogEntry("call", "four")),
    ]);

    expect(storedLogs(area).map((entry) => entry.label).sort()).toEqual([
      "four",
      "one",
      "three",
      "two",
    ]);
  });

  /**
   * 🇪🇸 NOTA: este test guarda EL TOPE, no la cadena, y el nombre lo dice para
   * que nadie lo lea como prueba de serialización. Medido: quitando la cadena
   * sigue verde, porque perder entradas también mantiene el log bajo el tope. El
   * que prueba la cadena es el de arriba.
   */
  it("never overshoots the cap, however many land at once", async () => {
    const { area, writer } = setup({ "cc:logs": seededLogs(MAX_LOG_ENTRIES) });

    await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        writer.append(createLogEntry("call", `burst-${index}`)),
      ),
    );

    expect(storedLogs(area)).toHaveLength(MAX_LOG_ENTRIES);
  });
});

describe("createLogWriter when storage refuses the write", () => {
  it("prunes to the last entries and retries once when the quota is hit", async () => {
    const area = failingArea(1, "QUOTA_BYTES quota exceeded", {
      "cc:logs": seededLogs(MAX_LOG_ENTRIES),
    });
    const writer = createLogWriter(createWalletStorage(area));

    await writer.append(createLogEntry("call", "the one that overflowed"));

    const logs = storedLogs(area);
    expect(logs).toHaveLength(QUOTA_KEPT_ENTRIES);
    expect(logs[QUOTA_KEPT_ENTRIES - 1]?.label).toBe("the one that overflowed");
  });

  /**
   * 🇪🇸 NOTA: ésta es la aserción que importa de verdad. El registro es
   * diagnóstico: si una escritura de log pudiera rechazar, una firma correcta se
   * convertiría en un error para la dApp por haberse quedado sin espacio.
   */
  it("never rejects, so the operation that produced the log survives", async () => {
    const alwaysFails = failingArea(Number.MAX_SAFE_INTEGER, "QUOTA_BYTES quota exceeded");
    const writer = createLogWriter(createWalletStorage(alwaysFails));
    const complain = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(writer.append(createLogEntry("call", "doomed"))).resolves.toBeUndefined();
    expect(complain).toHaveBeenCalled();
  });

  it("does not prune when the failure has nothing to do with the quota", async () => {
    const area = failingArea(1, "the disk caught fire", { "cc:logs": seededLogs(10) });
    const writer = createLogWriter(createWalletStorage(area));
    const complain = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(writer.append(createLogEntry("call", "lost"))).resolves.toBeUndefined();

    // Untouched: one failed attempt, no retry, and the old entries still there.
    expect(storedLogs(area)).toHaveLength(10);
    expect(complain).toHaveBeenCalled();
  });

  it("keeps writing after a failed append", async () => {
    const area = failingArea(1, "the disk caught fire");
    const writer = createLogWriter(createWalletStorage(area));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await writer.append(createLogEntry("call", "lost"));
    await writer.append(createLogEntry("call", "written anyway"));

    expect(storedLogs(area).map((entry) => entry.label)).toEqual(["written anyway"]);
  });
});

/** Guards the type surface the dispatcher depends on. */
describe("the writer's contract", () => {
  it("is built from a WalletStorage and exposes only append", () => {
    const area: StorageArea = createMemoryStorageArea();
    const writer = createLogWriter(createWalletStorage(area));

    expect(Object.keys(writer)).toEqual(["append"]);
  });
});
