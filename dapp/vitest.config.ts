import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Same shape as the extension's test config, and separate from next.config.ts
 * for the same reason: nothing under test needs the framework.
 *
 * `environment: "node"` and not jsdom. What is tested here is the EIP-6963
 * discovery store, the error map and the formatters — none of which touch the
 * DOM. The store takes its `EventTarget` as an argument instead of reading
 * `window`, and Node has had `EventTarget` and `CustomEvent` as globals since
 * v18, so the whole discovery handshake can be driven with real events and no
 * browser at all.
 *
 * 🇪🇸 NOTA: no hay tests de componentes de React aquí, y es deliberado. Montar
 * jsdom + testing-library para afirmar que un botón se renderiza deshabilitado
 * prueba el framework, no la lógica. Lo que de verdad hay que comprobar —que la
 * wallet aparece, que `eth_accounts` devuelve [] y que el iframe recibe el
 * provider— necesita un navegador de verdad con la extensión cargada, y eso es
 * Playwright en la Fase 10.
 */
export default defineConfig({
  resolve: {
    alias: { "@": resolve(root, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
  },
});
