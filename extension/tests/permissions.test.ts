import { describe, expect, it, vi } from "vitest";

import {
  createPermissionsPort,
  hasPermissionFor,
  isRpcUrlAllowed,
  originPatternFromRpcUrl,
  revoke,
  type PermissionsPort,
} from "@/lib/permissions";

const ANVIL = "http://localhost:8545";
const SEPOLIA = "https://sepolia.drpc.org";

/** A port that holds exactly the patterns it was built with. */
function portHolding(...granted: string[]): PermissionsPort {
  const held = new Set(granted);
  return {
    contains: (pattern) => Promise.resolve(held.has(pattern)),
    remove: (pattern) => {
      held.delete(pattern);
      return Promise.resolve(true);
    },
  };
}

describe("isRpcUrlAllowed", () => {
  it.each([
    ["a public https endpoint", SEPOLIA],
    ["https with a port", "https://rpc.example.com:8443"],
    ["https with an api key in the path", "https://eth-sepolia.g.alchemy.com/v2/abc123"],
  ])("allows %s", (_label, url) => {
    expect(isRpcUrlAllowed(url)).toBe(true);
  });

  /**
   * 🇪🇸 NOTA: las dos formas del loopback, y son DOS entradas de verdad. Un
   * patrón de host no resuelve nombres, así que `localhost` y `127.0.0.1` son
   * sujetos distintos para Chrome aunque apunten a la misma máquina.
   */
  it.each([
    ["localhost", ANVIL],
    ["the loopback IP", "http://127.0.0.1:8545"],
    ["localhost with no port", "http://localhost"],
  ])("allows plain http on %s", (_label, url) => {
    expect(isRpcUrlAllowed(url)).toBe(true);
  });

  /**
   * 🇪🇸 NOTA: un RPC por http en internet es un intermediario que ve y puede
   * reescribir cada respuesta — el saldo, el nonce, el recibo. La excepción es
   * el loopback y solo el loopback.
   */
  it.each([
    ["plain http on a public host", "http://rpc.example.com"],
    ["a lookalike of localhost", "http://localhost.evil.com:8545"],
    ["a websocket endpoint", "wss://rpc.example.com"],
    ["a file url", "file:///etc/passwd"],
    ["an extension url", "chrome-extension://abc/rpc"],
    ["something that is not a url", "not a url"],
    ["an empty string", ""],
  ])("refuses %s", (_label, url) => {
    expect(isRpcUrlAllowed(url)).toBe(false);
  });

  /**
   * 🇪🇸 NOTA: credenciales en la URL se rechazan en vez de ignorarse. El patrón
   * las descartaría en silencio y el usuario aprobaría `https://host/*` mientras
   * la wallet guarda una URL con contraseña dentro.
   */
  it("refuses a url carrying credentials", () => {
    expect(isRpcUrlAllowed("https://user:pass@rpc.example.com")).toBe(false);
  });

  it("refuses a wildcard host", () => {
    expect(isRpcUrlAllowed("https://*.example.com")).toBe(false);
  });
});

describe("originPatternFromRpcUrl", () => {
  /**
   * ------------------------------------------------------------------------
   * THE PORT IS PART OF THE PATTERN
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: medido en Chrome, no supuesto. Con `http://localhost:8546/*`
   * concedido, `contains("http://localhost:8547/*")` y
   * `contains("http://localhost/*")` devuelven los dos false. El permiso lleva
   * el puerto dentro.
   *
   * Si alguien "simplificara" esto a `url.hostname`, el patrón saldría MÁS
   * ANCHO que el necesario: pedirías todo localhost para hablar con el 8545. Y
   * la lógica de borrado de una red pasaría a revocar el permiso de otra.
   */
  it("keeps the port", () => {
    expect(originPatternFromRpcUrl(ANVIL)).toBe("http://localhost:8545/*");
    expect(originPatternFromRpcUrl("http://localhost:8546")).toBe("http://localhost:8546/*");
  });

  it("gives a different pattern for each port of the same host", () => {
    expect(originPatternFromRpcUrl("http://localhost:8545")).not.toBe(
      originPatternFromRpcUrl("http://localhost:8546"),
    );
  });

  it("drops the path, and any api key in it", () => {
    expect(originPatternFromRpcUrl("https://eth-sepolia.g.alchemy.com/v2/secret")).toBe(
      "https://eth-sepolia.g.alchemy.com/*",
    );
  });

  /** 🇪🇸 NOTA: lo normaliza `new URL`, no nosotros. Un solo patrón por sitio. */
  it("normalises the default port away", () => {
    expect(originPatternFromRpcUrl("https://rpc.example.com:443")).toBe(
      "https://rpc.example.com/*",
    );
    expect(originPatternFromRpcUrl("http://localhost:80")).toBe("http://localhost/*");
  });

  it("keeps a non-default port on https", () => {
    expect(originPatternFromRpcUrl("https://rpc.example.com:8443")).toBe(
      "https://rpc.example.com:8443/*",
    );
  });

  it("gives null for anything the policy refuses", () => {
    expect(originPatternFromRpcUrl("http://rpc.example.com")).toBeNull();
    expect(originPatternFromRpcUrl("not a url")).toBeNull();
  });
});

describe("hasPermissionFor", () => {
  it("is true only for the exact pattern that was granted", async () => {
    const permissions = portHolding("http://localhost:8546/*");

    await expect(hasPermissionFor(permissions, "http://localhost:8546")).resolves.toBe(true);
  });

  /**
   * ------------------------------------------------------------------------
   * THE INVARIANT THAT DECIDES THE DELETION LOGIC
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: éste es el test que fija lo que midió el spike. Conceder un puerto
   * NO concede otro puerto ni el host suelto. De aquí sale que "revoca solo si
   * ninguna otra red usa ese HOST" está mal, y que la condición correcta es
   * "ninguna otra red tiene exactamente el mismo patrón".
   */
  it.each([
    ["another port of the same host", "http://localhost:8547"],
    ["the same host with no port", "http://localhost"],
  ])("is false for %s", async (_label, url) => {
    const permissions = portHolding("http://localhost:8546/*");

    await expect(hasPermissionFor(permissions, url)).resolves.toBe(false);
  });

  it("is false for a url the policy refuses, without asking chrome", async () => {
    const contains = vi.fn<PermissionsPort["contains"]>().mockResolvedValue(true);

    await expect(
      hasPermissionFor({ contains, remove: () => Promise.resolve(true) }, "http://rpc.example.com"),
    ).resolves.toBe(false);
    expect(contains).not.toHaveBeenCalled();
  });

  /** A permission we could not check is not a permission we have. */
  it("is false when chrome throws", async () => {
    const permissions: PermissionsPort = {
      contains: () => Promise.reject(new Error("no")),
      remove: () => Promise.resolve(true),
    };

    await expect(hasPermissionFor(permissions, SEPOLIA)).resolves.toBe(false);
  });
});

describe("revoke", () => {
  it("reports true once the permission is really gone", async () => {
    const permissions = portHolding("http://localhost:8546/*");

    await expect(revoke(permissions, "http://localhost:8546")).resolves.toBe(true);
    await expect(hasPermissionFor(permissions, "http://localhost:8546")).resolves.toBe(false);
  });

  /**
   * ------------------------------------------------------------------------
   * remove() CAN RESOLVE true AND REVOKE NOTHING
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: pasa de verdad — se vio en Brave durante el spike de la Fase 8,
   * donde los permisos opcionales seguían concedidos después de llamar. Por eso
   * `revoke` vuelve a preguntar con `contains()` en vez de creerse el booleano.
   * Sin esta comprobación, la UI diría "permiso revocado" con el permiso
   * intacto.
   */
  it("reports false when remove lies", async () => {
    const permissions: PermissionsPort = {
      contains: () => Promise.resolve(true),
      remove: () => Promise.resolve(true),
    };

    await expect(revoke(permissions, "http://localhost:8546")).resolves.toBe(false);
  });

  it("revokes one port without touching another", async () => {
    const permissions = portHolding("http://localhost:8545/*", "http://localhost:8546/*");

    await expect(revoke(permissions, "http://localhost:8545")).resolves.toBe(true);
    await expect(hasPermissionFor(permissions, "http://localhost:8546")).resolves.toBe(true);
  });
});

describe("createPermissionsPort", () => {
  /** The wrapper's only job is wrapping a bare pattern into chrome's shape. */
  it("wraps the pattern into an origins array", async () => {
    const contains = vi.fn().mockResolvedValue(true);
    const remove = vi.fn().mockResolvedValue(true);
    const port = createPermissionsPort({ contains, remove } as unknown as typeof chrome.permissions);

    await port.contains("https://rpc.example.com/*");
    await port.remove("https://rpc.example.com/*");

    expect(contains).toHaveBeenCalledWith({ origins: ["https://rpc.example.com/*"] });
    expect(remove).toHaveBeenCalledWith({ origins: ["https://rpc.example.com/*"] });
  });
});
