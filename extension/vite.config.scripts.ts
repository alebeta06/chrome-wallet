import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Passes 2 and 3 of 3 — classic scripts.
 *
 * Chrome loads `content-script.js` and `inject.js` as CLASSIC scripts, not as ES
 * modules. A single `import` left in either of them dies at runtime with
 * "Cannot use import statement outside a module", and the failure is silent from
 * the extension's point of view: the page just never gets a provider.
 *
 * The fix is `format: "iife"`, which inlines every dependency into one
 * self-contained function. But IIFE does not support code splitting, and
 * `inlineDynamicImports` — the guarantee of a single output file — only works
 * with a single input entry. So the two scripts cannot share a build: one pass
 * each, selected here with --mode.
 *
 *   vite build -c vite.config.scripts.ts --mode content-script
 *   vite build -c vite.config.scripts.ts --mode inject
 *
 * 🇪🇸 NOTA: el que esto sean tres pasadas y no una no es un apaño, es la
 * consecuencia directa de mezclar dos formatos de módulo en un mismo dist/.
 * La ventaja de hacerlo así es que la restricción la vigila el bundler: con
 * `format: "iife"` Rollup se niega a compilar si alguien mete un top-level
 * await o un import dinámico que no pueda inlinear, en vez de dejarlo pasar y
 * romperse en producción.
 */
const ENTRIES = {
  "content-script": "src/content-script.ts",
  inject: "src/inject.ts",
} as const;

type ScriptMode = keyof typeof ENTRIES;

function assertScriptMode(mode: string): asserts mode is ScriptMode {
  if (!(mode in ENTRIES)) {
    throw new Error(
      `Unknown --mode "${mode}". Expected one of: ${Object.keys(ENTRIES).join(", ")}`,
    );
  }
}

export default defineConfig(({ mode }) => {
  assertScriptMode(mode);

  return {
    root,
    // The icons were already copied by pass 1; copying them again on every pass
    // is pure waste.
    publicDir: false,
    resolve: {
      alias: { "@": resolve(root, "src") },
    },
    build: {
      outDir: "dist",
      // Critical: pass 1 owns the cleanup. If this were true, each pass would
      // delete everything the previous one produced.
      emptyOutDir: false,
      target: "chrome120",
      sourcemap: true,
      modulePreload: false,
      rollupOptions: {
        input: { [mode]: resolve(root, ENTRIES[mode]) },
        output: {
          format: "iife",
          inlineDynamicImports: true,
          // -> dist/content-script.js, dist/inject.js. Fixed names, no hash:
          // the manifest references them literally.
          entryFileNames: "[name].js",
        },
      },
    },
  };
});
