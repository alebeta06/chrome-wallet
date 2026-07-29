/**
 * @file manifest.ts
 * @description The extension manifest, written as TypeScript instead of JSON.
 *
 * A Vite plugin serialises this object to `dist/manifest.json` at the end of the
 * build (see `manifestPlugin` in vite.config.ts). Nothing here is bundled into
 * browser code: this module is only ever imported by the build.
 *
 * 🇪🇸 NOTA: ¿por qué un .ts en vez del manifest.json de toda la vida? Porque
 * `chrome.runtime.ManifestV3` valida el objeto en tiempo de compilación. Un
 * manifest.json con un typo en `run_at` o un permiso inventado no falla al
 * compilar: falla al cargar la extensión, o peor, carga y el content script
 * simplemente no se inyecta nunca y te pasas una tarde buscando el motivo.
 */

const manifest: chrome.runtime.ManifestV3 = {
  manifest_version: 3,
  name: "CodeCrypto Wallet",
  version: "0.1.0",
  description: "Ethereum wallet built from scratch for the CodeCrypto master's degree.",

  // The popup. Vite emits index.html at the root of dist/.
  action: {
    default_popup: "index.html",
    default_icon: {
      16: "icons/icon-16.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
  },

  icons: {
    16: "icons/icon-16.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },

  /**
   * The service worker is the only ES module of the three scripts, which is why
   * it is the only one Vite may emit with `import` statements in it.
   */
  background: {
    service_worker: "background.js",
    type: "module",
  },

  permissions: ["storage", "tabs", "notifications"],

  /** Local Anvil node and the public Sepolia endpoint. Nothing else. */
  host_permissions: ["http://localhost:8545/*", "https://sepolia.drpc.org/*"],

  /**
   * 🇪🇸 NOTA: `run_at: "document_start"` es obligatorio, no una optimización.
   * El content script tiene que inyectar el provider ANTES de que la dApp
   * ejecute su primer script; si llega en `document_idle`, el `useEffect` que
   * busca `window.ethereum` ya se ejecutó y la wallet no existe para esa página.
   * `all_frames` + `match_about_blank` cubren las dApps que viven en un iframe.
   */
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["content-script.js"],
      run_at: "document_start",
      all_frames: true,
      match_about_blank: true,
    },
  ],

  /**
   * inject.js runs in the page's own JavaScript world, so the page must be
   * allowed to load it from the extension's origin.
   */
  web_accessible_resources: [
    {
      resources: ["inject.js"],
      matches: ["<all_urls>"],
    },
  ],
};

export default manifest;
