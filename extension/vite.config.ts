import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import manifest from "./src/manifest";

const root = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = "dist";

/**
 * Serialises `src/manifest.ts` to `dist/manifest.json` once the bundle is on disk.
 *
 * 🇪🇸 NOTA: se hace en `closeBundle` y no en `generateBundle` a propósito. El
 * manifest no es un artefacto de Rollup (no lo importa nadie, no tiene hash, no
 * participa del grafo de módulos): es un archivo que Chrome lee. Escribirlo al
 * final, cuando el resto de dist/ ya existe, mantiene esa separación clara.
 */
function manifestPlugin(): Plugin {
  return {
    name: "codecrypto:manifest",
    apply: "build",
    closeBundle() {
      const outFile = resolve(root, OUT_DIR, "manifest.json");
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      this.info(`manifest.json written (v${manifest.version})`);
    },
  };
}

/**
 * Pass 1 of 3 — ES modules.
 *
 * Builds the three HTML surfaces (popup, connect, notification) and the service
 * worker. The two classic scripts, `content-script.js` and `inject.js`, cannot
 * be built here: see vite.config.scripts.ts for why.
 *
 * This is the only pass that empties dist/, so it must run first.
 */
export default defineConfig({
  root,
  plugins: [react(), manifestPlugin()],
  resolve: {
    alias: { "@": resolve(root, "src") },
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    target: "chrome120",
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(root, "index.html"),
        connect: resolve(root, "connect.html"),
        notification: resolve(root, "notification.html"),
        background: resolve(root, "src/background.ts"),
      },
      output: {
        /**
         * The manifest references "background.js" by literal name, so that one
         * entry has to land unhashed at the root of dist/. Everything else is
         * a React bundle and gets the usual hashed name under assets/.
         */
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
  },
});
