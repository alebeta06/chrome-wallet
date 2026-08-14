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

  /**
   * 🇪🇸 NOTA: `alarms` es obligatorio para `chrome.alarms`, y sin él la API
   * simplemente no existe. Es un permiso normal, no de host: no roza nada de lo
   * medido en la comprobación 79 ni pide diálogo al usuario.
   */
  permissions: ["storage", "tabs", "notifications", "alarms"],

  /** Local Anvil node and the public Sepolia endpoint. Nothing else. */
  host_permissions: ["http://localhost:8545/*", "https://ethereum-sepolia-rpc.publicnode.com/*"],

  /**
   * Hosts the wallet can ASK for at runtime, when the user adds a network.
   * Declaring them grants nothing: each one still needs an explicit
   * chrome.permissions.request() from inside a user gesture.
   *
   * 🇪🇸 NOTA: el comodín https es lo que la documentación de Chrome recomienda
   * para hosts que solo se conocen en runtime, y cubre cualquier RPC público.
   * Los dos de http van aparte porque la política de `isRpcUrlAllowed` solo
   * permite http en local: un nodo de desarrollo no tiene certificado, y
   * exigirle https dejaría fuera el caso que más se usa en este proyecto.
   *
   * localhost y 127.0.0.1 son DOS patrones, no uno. Un patrón de host no
   * resuelve nombres: `http://localhost/*` no casa con `http://127.0.0.1:8545`
   * por mucho que apunten a la misma máquina.
   */
  optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],

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
