import { describe, expect, it, vi } from "vitest";

import type { PendingRequest, RequestId } from "@/types/messages";
import { BADGE_COLOR, createBadge, pendingBadgeText, type BadgePort } from "@/lib/badge";
import { createWalletStorage } from "@/lib/storage";
import { createMemoryStorageArea } from "./helpers/memory-storage-area";

const NOW = 10_000;

function request(id: string, expiresAt: number): PendingRequest {
  return {
    id,
    kind: "connect",
    origin: "https://dapp.example",
    createdAt: 0,
    expiresAt,
    accounts: [],
    suggestedAccountIndex: 0,
  };
}

function map(...requests: PendingRequest[]): Record<RequestId, PendingRequest> {
  return Object.fromEntries(requests.map((entry) => [entry.id, entry]));
}

describe("pendingBadgeText", () => {
  it("shows nothing when nothing is waiting", () => {
    expect(pendingBadgeText({}, NOW)).toBe("");
    expect(pendingBadgeText(undefined, NOW)).toBe("");
  });

  it("counts the live requests", () => {
    expect(pendingBadgeText(map(request("a", 20_000)), NOW)).toBe("1");
    expect(pendingBadgeText(map(request("a", 20_000), request("b", 30_000)), NOW)).toBe("2");
  });

  /**
   * 🇪🇸 NOTA: una solicitud caducada sigue en storage hasta que algo la lee y la
   * descarta. Contarla dejaría el badge con un número fantasma después de un
   * timeout — la wallet diciendo "tienes algo pendiente" para siempre.
   */
  it("ignores requests that have already expired", () => {
    expect(pendingBadgeText(map(request("a", 5_000)), NOW)).toBe("");
    expect(pendingBadgeText(map(request("a", 5_000), request("b", 20_000)), NOW)).toBe("1");
  });

  it("treats the expiry instant itself as expired", () => {
    expect(pendingBadgeText(map(request("a", NOW)), NOW)).toBe("");
  });

  it("caps at 9+ so the badge stays legible", () => {
    const many = map(...Array.from({ length: 12 }, (_unused, i) => request(`r${i}`, 20_000)));

    expect(pendingBadgeText(many, NOW)).toBe("9+");
  });

  it("shows 9 without the plus", () => {
    const nine = map(...Array.from({ length: 9 }, (_unused, i) => request(`r${i}`, 20_000)));

    expect(pendingBadgeText(nine, NOW)).toBe("9");
  });
});

// ============================================================================
// Phase 9 — the whole path, not just the derivation
// ============================================================================

/** Records what was written to chrome.action, without a browser. */
function fakePort() {
  const texts: string[] = [];
  const colors: string[] = [];

  const port: BadgePort = {
    setText: vi.fn(async (text) => {
      texts.push(text);
    }),
    setBackgroundColor: vi.fn(async (color) => {
      colors.push(color);
    }),
  };

  return { port, texts, colors };
}

function badgeOver(pending: Record<RequestId, PendingRequest> | undefined) {
  const area = createMemoryStorageArea(
    pending === undefined ? {} : { "cc:pendingRequests": pending },
  );
  const { port, texts, colors } = fakePort();

  return { badge: createBadge(createWalletStorage(area), port, () => NOW), texts, colors, port };
}

describe("createBadge", () => {
  /**
   * ------------------------------------------------------------------------
   * THE PATH NOBODY WAS TESTING
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: `pendingBadgeText` tenía sus tests desde la Fase 6, pero la
   * derivación pura no es lo que se rompe. Lo que importa es el camino entero —
   * leer storage y escribir el texto— y ése solo se ejecutaba en `background.ts`,
   * donde no llega ningún test.
   *
   * Y es EL camino del despertar: el texto del badge es estado del navegador y
   * sobrevive al service worker. Si al arrancar nadie lo recalcula, la wallet se
   * queda enseñando el número de algo que se resolvió mientras dormía.
   */
  it("rehydrates the count from storage", async () => {
    const { badge, texts } = badgeOver(map(request("a", 20_000), request("b", 30_000)));

    await badge.refresh();

    expect(texts).toEqual(["2"]);
  });

  it("clears the badge when everything in storage has expired", async () => {
    const { badge, texts } = badgeOver(map(request("a", 5_000)));

    await badge.refresh();

    expect(texts).toEqual([""]);
  });

  /** A freshly installed wallet has no such key at all. */
  it("writes an empty badge when the key is not there", async () => {
    const { badge, texts } = badgeOver(undefined);

    await badge.refresh();

    expect(texts).toEqual([""]);
  });

  it("paints the colour once, with the accent", async () => {
    const { badge, colors } = badgeOver({});

    await badge.paintBackground();

    expect(colors).toEqual([BADGE_COLOR]);
  });

  /**
   * 🇪🇸 NOTA: ésta es la aserción del commit. El color se pintaba DENTRO del
   * refresco y condicionado a que hubiera texto, así que cada cambio de
   * `cc:pendingRequests` reescribía el mismo valor constante. Sacarlo no se nota
   * mirando la wallet: se nota aquí.
   */
  it("never touches the colour while refreshing, however many times", async () => {
    const { badge, port } = badgeOver(map(request("a", 20_000)));

    await badge.refresh();
    await badge.refresh();
    await badge.refresh();

    expect(port.setBackgroundColor).not.toHaveBeenCalled();
    expect(port.setText).toHaveBeenCalledTimes(3);
  });

  it("reads storage on every refresh instead of remembering a count", async () => {
    const area = createMemoryStorageArea({ "cc:pendingRequests": map(request("a", 20_000)) });
    const { port, texts } = fakePort();
    const badge = createBadge(createWalletStorage(area), port, () => NOW);

    await badge.refresh();
    await area.set({ "cc:pendingRequests": {} });
    await badge.refresh();

    expect(texts).toEqual(["1", ""]);
  });
});
