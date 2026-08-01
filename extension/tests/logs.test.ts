import { describe, expect, it } from "vitest";

import { MAX_LOG_ENTRIES, type LogEntry } from "@/types/messages";
import { appendLog, createLogEntry, redactParams } from "@/lib/logs";
import { createWalletStorage } from "@/lib/storage";
import { createMemoryStorageArea } from "./helpers/memory-storage-area";

const ANVIL_FIRST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ANVIL_PHRASE = "test test test test test test test test test test test junk";

function setup(seed: Record<string, unknown> = {}) {
  const area = createMemoryStorageArea(seed);
  return { area, storage: createWalletStorage(area) };
}

function storedLogs(area: ReturnType<typeof createMemoryStorageArea>): LogEntry[] {
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

describe("createLogEntry", () => {
  it("stamps an id and a timestamp", () => {
    const entry = createLogEntry("call", "eth_chainId");

    expect(entry.id).toHaveLength(36); // crypto.randomUUID()
    expect(entry.ts).toBeGreaterThan(0);
    expect(entry.level).toBe("call");
    expect(entry.label).toBe("eth_chainId");
  });

  it("gives every entry a distinct id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createLogEntry("call", "x").id));

    expect(ids.size).toBe(50);
  });

  /**
   * 🇪🇸 NOTA: `origin` y `detail` son opcionales en el contrato. Escribirlos
   * como `undefined` explícito los haría aparecer en el JSON serializado y en
   * cualquier `Object.keys`, que es justo lo que un campo opcional no debe
   * hacer cuando no hay valor.
   */
  it("omits origin and detail when there is nothing to record", () => {
    const entry = createLogEntry("operation", "wallet started");

    expect(Object.keys(entry).sort()).toEqual(["id", "label", "level", "ts"]);
  });

  it("records origin and detail when given", () => {
    const entry = createLogEntry("call", "eth_getBalance", "https://dapp.example", [ANVIL_FIRST]);

    expect(entry.origin).toBe("https://dapp.example");
    expect(entry.detail).toEqual([ANVIL_FIRST]);
  });
});

describe("redactParams", () => {
  /**
   * ------------------------------------------------------------------------
   * THE RULE, ESTABLISHED BEFORE THERE IS ANYTHING TO LEAK
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: en la Fase 3 no existe la firma. Ése es exactamente el motivo de
   * escribir esto hoy: cuando la Fase 6 implemente estos dos métodos, la regla
   * ya está puesta y fijada por un test, y nadie tiene que acordarse de ella
   * mientras escribe el código de firmar. Un registro es el sitio más fácil del
   * mundo para filtrar algo: se escribe una vez y se lee seis meses después.
   */
  it.each(["eth_sendTransaction", "eth_signTypedData_v4"])("redacts the params of %s", (method) => {
    const params = [{ from: ANVIL_FIRST, to: ANVIL_FIRST, value: "0xdeadbeef" }];

    expect(redactParams(method, params)).toBe("[redacted]");
  });

  /** Second lock: only page calls are logged today, so this cannot fire yet. */
  it("redacts the params of an internal method", () => {
    const redacted = redactParams("wallet_importMnemonic", [{ phrase: ANVIL_PHRASE, accountCount: 5 }]);

    expect(redacted).toBe("[redacted]");
    expect(JSON.stringify(redacted)).not.toContain("junk");
  });

  it("redacts an unknown method rather than trusting it", () => {
    expect(redactParams("wallet_somethingNobodyHasWrittenYet", ["secret"])).toBe("[redacted]");
  });

  /**
   * The control. A redaction test is worthless if the function redacts
   * everything: this proves it lets the harmless case through.
   */
  it("keeps the params of a harmless public method", () => {
    expect(redactParams("eth_getBalance", [ANVIL_FIRST, "latest"])).toEqual([ANVIL_FIRST, "latest"]);
    expect(redactParams("eth_chainId", [])).toEqual([]);
  });
});

describe("appendLog", () => {
  it("creates the log on the first entry", async () => {
    const { area, storage } = setup();

    await appendLog(storage, createLogEntry("call", "eth_chainId"));

    expect(storedLogs(area)).toHaveLength(1);
  });

  it("appends in order, newest last", async () => {
    const { area, storage } = setup();

    await appendLog(storage, createLogEntry("call", "first"));
    await appendLog(storage, createLogEntry("call", "second"));
    await appendLog(storage, createLogEntry("error", "third"));

    expect(storedLogs(area).map((entry) => entry.label)).toEqual(["first", "second", "third"]);
  });

  it("keeps existing entries", async () => {
    const { area, storage } = setup({ "cc:logs": seededLogs(3) });

    await appendLog(storage, createLogEntry("call", "new one"));

    expect(storedLogs(area).map((entry) => entry.label)).toEqual([
      "seeded-0",
      "seeded-1",
      "seeded-2",
      "new one",
    ]);
  });

  it("caps at MAX_LOG_ENTRIES, dropping the oldest", async () => {
    const { area, storage } = setup({ "cc:logs": seededLogs(MAX_LOG_ENTRIES) });

    await appendLog(storage, createLogEntry("call", "the newest"));

    const entries = storedLogs(area);
    expect(entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(entries[0].label).toBe("seeded-1");
    expect(entries[MAX_LOG_ENTRIES - 1].label).toBe("the newest");
  });

  /** An oversized log — say, from an older build — gets trimmed on the next write. */
  it("trims a log that is already over the cap", async () => {
    const { area, storage } = setup({ "cc:logs": seededLogs(MAX_LOG_ENTRIES + 50) });

    await appendLog(storage, createLogEntry("call", "the newest"));

    expect(storedLogs(area)).toHaveLength(MAX_LOG_ENTRIES);
  });

  it("stays exactly at the cap without dropping anything early", async () => {
    const { area, storage } = setup({ "cc:logs": seededLogs(MAX_LOG_ENTRIES - 1) });

    await appendLog(storage, createLogEntry("call", "the newest"));

    const entries = storedLogs(area);
    expect(entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(entries[0].label).toBe("seeded-0");
  });
});
