import { describe, expect, it } from "vitest";

import type { ConnectedSite } from "@/types/messages";
import {
  connectSite,
  disconnectSite,
  resolveSiteAccount,
  usableSites,
  type ConnectedSites,
} from "@/lib/sites";

const VERCEL = "https://chrome-wallet.vercel.app";
const LOCAL = "http://localhost:3000";
const EVIL = "https://evil.example";

function site(origin: string, accountIndex: number, at = 1_000): ConnectedSite {
  return { origin, accountIndex, connectedAt: at, lastUsedAt: at };
}

/** Two origins on two different accounts — the shape the whole model is about. */
const TWO_SITES: ConnectedSites = {
  [VERCEL]: site(VERCEL, 3),
  [LOCAL]: site(LOCAL, 1),
};

describe("resolveSiteAccount", () => {
  /**
   * ------------------------------------------------------------------------
   * THE TEST THAT DEFINES THE PER-ORIGIN MODEL
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: dos dApps conectadas a la vez, cada una a una cuenta distinta, y
   * cada una ve LA SUYA. Si esto se rompiera, el modelo por origen dejaría de
   * existir aunque todo lo demás siguiera compilando — y la forma en que se
   * rompe no es un error de compilación, es alguien devolviendo la cuenta por
   * defecto "porque es más simple".
   */
  it("gives each origin its own account", () => {
    expect(resolveSiteAccount(TWO_SITES, VERCEL, 5)).toBe(3);
    expect(resolveSiteAccount(TWO_SITES, LOCAL, 5)).toBe(1);
  });

  it("gives nothing to an origin that never connected", () => {
    expect(resolveSiteAccount(TWO_SITES, EVIL, 5)).toBeNull();
  });

  it("gives nothing when no site has ever connected", () => {
    expect(resolveSiteAccount({}, VERCEL, 5)).toBeNull();
    expect(resolveSiteAccount(undefined, VERCEL, 5)).toBeNull();
  });

  /**
   * 🇪🇸 NOTA: el origen es una cadena y se compara exacta. Un prefijo o un
   * subdominio NO es el mismo origen, y confundirlos sería dar acceso a
   * `evil.chrome-wallet.vercel.app.attacker.com` porque "empieza igual".
   */
  it.each([
    ["a subdomain", "https://sub.chrome-wallet.vercel.app"],
    ["a lookalike suffix", "https://chrome-wallet.vercel.app.evil.com"],
    ["http instead of https", "http://chrome-wallet.vercel.app"],
    ["a different port", "http://localhost:3001"],
    ["a trailing slash", `${VERCEL}/`],
  ])("does not match %s", (_label, origin) => {
    expect(resolveSiteAccount(TWO_SITES, origin, 5)).toBeNull();
  });

  describe("an index that no longer fits", () => {
    /**
     * 🇪🇸 NOTA: el caso real — conectas a la cuenta 4, reseteas, reimportas con
     * 2. Acotar a 0 haría que la dApp, que enseñó "tu cuenta es 0x90F7…", pasara
     * a operar como 0xf39F… sin decírselo a nadie. Devolver null obliga a
     * reconectar: más molesto y correcto.
     */
    it("reads as not connected instead of falling back to account 0", () => {
      expect(resolveSiteAccount(TWO_SITES, VERCEL, 2)).toBeNull();
    });

    it("does not affect the other origin, whose index still fits", () => {
      expect(resolveSiteAccount(TWO_SITES, LOCAL, 2)).toBe(1);
    });

    it("reads as not connected when the wallet has no accounts at all", () => {
      expect(resolveSiteAccount(TWO_SITES, VERCEL, 0)).toBeNull();
    });

    it.each([
      ["a negative index", -1],
      ["a non-integer index", 1.5],
      ["NaN", Number.NaN],
    ])("rejects %s", (_label, accountIndex) => {
      const broken: ConnectedSites = { [VERCEL]: site(VERCEL, accountIndex) };

      expect(resolveSiteAccount(broken, VERCEL, 5)).toBeNull();
    });

    /**
     * A read must stay a read.
     *
     * 🇪🇸 NOTA: la tentación es borrar el registro roto al encontrarlo. Eso
     * convierte cualquier `eth_accounts` en una escritura, y con el service
     * worker durmiéndose y despertándose es una carrera que no hace falta
     * tener. Se ignora al leer; el registro lo limpia el usuario o un reset.
     */
    it("does not mutate the sites it was given", () => {
      const before = JSON.stringify(TWO_SITES);

      resolveSiteAccount(TWO_SITES, VERCEL, 2);

      expect(JSON.stringify(TWO_SITES)).toBe(before);
    });
  });
});

describe("usableSites", () => {
  it("keeps only the origins whose index still fits", () => {
    expect(Object.keys(usableSites(TWO_SITES, 2))).toEqual([LOCAL]);
  });

  it("keeps everything when every index fits", () => {
    expect(Object.keys(usableSites(TWO_SITES, 5)).sort()).toEqual([LOCAL, VERCEL].sort());
  });

  it("survives an empty or missing map", () => {
    expect(usableSites({}, 5)).toEqual({});
    expect(usableSites(undefined, 5)).toEqual({});
  });
});

describe("connectSite", () => {
  it("adds an origin without touching the others", () => {
    const next = connectSite(TWO_SITES, EVIL, 0, 5_000);

    expect(next[EVIL].accountIndex).toBe(0);
    expect(next[VERCEL].accountIndex).toBe(3);
    expect(next[LOCAL].accountIndex).toBe(1);
  });

  it("stamps both timestamps on a first connection", () => {
    const next = connectSite({}, VERCEL, 2, 5_000);

    expect(next[VERCEL]).toEqual({
      origin: VERCEL,
      accountIndex: 2,
      connectedAt: 5_000,
      lastUsedAt: 5_000,
    });
  });

  /**
   * 🇪🇸 NOTA: saber desde cuándo un sitio tiene acceso es justo el dato que uno
   * mira al revisar la lista de sitios conectados. Pisarlo en cada cambio de
   * cuenta lo destruiría, y el usuario perdería la única señal de "esto lleva
   * conectado desde hace seis meses y ya no sé por qué".
   */
  it("keeps connectedAt when an existing site moves account", () => {
    const next = connectSite(TWO_SITES, VERCEL, 0, 9_999);

    expect(next[VERCEL].connectedAt).toBe(1_000);
    expect(next[VERCEL].lastUsedAt).toBe(9_999);
    expect(next[VERCEL].accountIndex).toBe(0);
  });

  it("does not mutate the map it was given", () => {
    const before = JSON.stringify(TWO_SITES);

    connectSite(TWO_SITES, EVIL, 0, 5_000);

    expect(JSON.stringify(TWO_SITES)).toBe(before);
  });

  it("works from an empty or missing map", () => {
    expect(Object.keys(connectSite(undefined, VERCEL, 0, 1))).toEqual([VERCEL]);
  });
});

describe("disconnectSite", () => {
  it("removes only the origin asked for", () => {
    const next = disconnectSite(TWO_SITES, VERCEL);

    expect(next[VERCEL]).toBeUndefined();
    expect(next[LOCAL].accountIndex).toBe(1);
  });

  it("is a no-op for an origin that was never connected", () => {
    expect(disconnectSite(TWO_SITES, EVIL)).toBe(TWO_SITES);
  });

  it("does not mutate the map it was given", () => {
    const before = JSON.stringify(TWO_SITES);

    disconnectSite(TWO_SITES, VERCEL);

    expect(JSON.stringify(TWO_SITES)).toBe(before);
  });

  it("survives an empty or missing map", () => {
    expect(disconnectSite({}, VERCEL)).toEqual({});
    expect(disconnectSite(undefined, VERCEL)).toEqual({});
  });
});
