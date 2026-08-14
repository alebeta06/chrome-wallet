import { describe, expect, it } from "vitest";

import { RESET_CLEARED_KEYS } from "@/types/messages";
import { createWalletStorage } from "@/lib/storage";
import { createMemoryStorageArea } from "./helpers/memory-storage-area";

const ADDRESS_A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const ADDRESS_B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

/** A wallet that has been through a full import, plus the keys reset must keep. */
function seededStorage() {
  const area = createMemoryStorageArea({
    "cc:mnemonic": "test test test test test test test test test test test junk",
    "cc:accounts": [ADDRESS_A, ADDRESS_B],
    "cc:defaultAccountIndex": 1,
    "cc:chainId": "0x7a69",
    "cc:connectedSites": {},
    "cc:pendingRequests": {},
    /**
     * 🇪🇸 NOTA: sembrada A PROPÓSITO, y el motivo es que sin ella la aserción de
     * abajo no dice nada sobre esta clave. `toEqual([...])` compara lo que QUEDA
     * con lo esperado; una clave que nunca se sembró no puede quedar, así que el
     * test pasaría igual estuviera `cc:pendingTxs` en el lado que muere o en el
     * que sobrevive.
     *
     * Es la misma familia que las lecciones de la Fase 8: una garantía que solo
     * existe en la frase que la describe. Con la siembra, moverla al lado
     * equivocado pone el test rojo — que es lo que se creía que ya hacía.
     */
    "cc:pendingTxs": {
      "0x7a69:0xdead": { hash: "0xdead", chainId: "0x7a69", sentAt: 0, accountIndex: 0 },
    },
    "cc:providerUuid": "0f1d1f9c-0000-4000-8000-000000000000",
    "cc:logs": [{ id: "1", ts: 0, level: "operation", label: "seeded" }],
  });
  return { area, storage: createWalletStorage(area) };
}

describe("createWalletStorage", () => {
  it("round-trips a typed value", async () => {
    const storage = createWalletStorage(createMemoryStorageArea());

    await storage.set("cc:accounts", [ADDRESS_A]);
    expect(await storage.get("cc:accounts")).toEqual([ADDRESS_A]);
  });

  it("returns undefined for a key that was never written", async () => {
    const storage = createWalletStorage(createMemoryStorageArea());
    expect(await storage.get("cc:mnemonic")).toBeUndefined();
  });

  it("writes several keys in one call", async () => {
    const { area, storage } = seededStorage();

    await storage.setMany({ "cc:accounts": [ADDRESS_A], "cc:defaultAccountIndex": 0 });

    expect(area.snapshot()["cc:accounts"]).toEqual([ADDRESS_A]);
    expect(area.snapshot()["cc:defaultAccountIndex"]).toBe(0);
  });

  it("removes a single key and a list of keys", async () => {
    const { area, storage } = seededStorage();

    await storage.remove("cc:mnemonic");
    expect(area.keys()).not.toContain("cc:mnemonic");

    await storage.remove(["cc:accounts", "cc:chainId"]);
    expect(area.keys()).not.toContain("cc:accounts");
    expect(area.keys()).not.toContain("cc:chainId");
  });

  /**
   * 🇪🇸 NOTA: este test es el que justifica el structuredClone del doble. Si
   * `get` devolviera la referencia guardada, mutarla parecería persistir — y en
   * Chrome no persiste nada, porque chrome.storage serializa. Sin este test el
   * doble sería más permisivo que la API real, que es la peor clase de doble.
   */
  it("hands out copies, not references into the store", async () => {
    const { area, storage } = seededStorage();

    const accounts = await storage.get("cc:accounts");
    accounts?.push(ADDRESS_A);

    expect(await storage.get("cc:accounts")).toHaveLength(2);
    expect(area.snapshot()["cc:accounts"]).toHaveLength(2);
  });
});

describe("resetWallet", () => {
  it("clears exactly RESET_CLEARED_KEYS", async () => {
    const { area, storage } = seededStorage();

    await storage.resetWallet();

    for (const key of RESET_CLEARED_KEYS) {
      expect(area.keys()).not.toContain(key);
    }
  });

  it("keeps cc:logs and cc:providerUuid", async () => {
    const { area, storage } = seededStorage();

    await storage.resetWallet();

    expect(area.keys()).toEqual(["cc:chainId", "cc:logs", "cc:providerUuid"]);
    expect(await storage.get("cc:logs")).toHaveLength(1);
    expect(await storage.get("cc:providerUuid")).toBe("0f1d1f9c-0000-4000-8000-000000000000");
  });

  it("is safe to run on an empty wallet", async () => {
    const area = createMemoryStorageArea();
    await expect(createWalletStorage(area).resetWallet()).resolves.toBeUndefined();
    expect(area.keys()).toEqual([]);
  });
});
