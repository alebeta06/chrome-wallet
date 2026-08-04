import { describe, expect, it } from "vitest";

import type { PendingRequest, RequestId } from "@/types/messages";
import { pendingBadgeText } from "@/lib/badge";

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
