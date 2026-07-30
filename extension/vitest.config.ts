import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Test config, deliberately separate from vite.config.ts.
 *
 * 🇪🇸 NOTA: si Vitest cargara vite.config.ts arrastraría el plugin de React y el
 * que escribe el manifest, ninguno de los dos tiene nada que hacer en un test.
 * Un archivo aparte evita ese acoplamiento por completo.
 *
 * `environment: "node"` y no jsdom: lo que se prueba aquí (derivación, storage,
 * despachador) no toca el DOM. Añadir jsdom sería pagar arranque a cambio de nada.
 */
export default defineConfig({
  resolve: {
    alias: { "@": resolve(root, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    /**
     * 🇪🇸 NOTA: sin esto, un `vi.spyOn(console, "error")` en un beforeEach
     * acumula las llamadas de todos los tests anteriores, y un
     * `toHaveBeenCalledTimes(2)` falla contando 7. Restaurar antes de cada test
     * hace que los tests sean independientes de verdad y no por casualidad.
     */
    restoreMocks: true,
  },
});
