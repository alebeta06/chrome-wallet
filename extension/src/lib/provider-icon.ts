/**
 * @file lib/provider-icon.ts
 * @description The wallet icon as a data URI, for EIP-6963.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SVG IS DUPLICATED HERE
 * ---------------------------------------------------------------------------
 * `assets/icon.svg` is a BUILD input: `scripts/generate-icons.mjs` renders it to
 * the PNGs in `public/icons/`, and the comment inside it says it must never ship
 * to dist/. It is not part of the module graph, so `inject.ts` cannot import it,
 * and inlining it through a Vite asset import would put the SVG in the bundle by
 * a different door.
 *
 * So the geometry lives twice, on purpose. If the brand icon ever changes, both
 * files change — and that is the trade for keeping `inject.js` a self-contained
 * IIFE with no asset pipeline behind it.
 *
 * 🇪🇸 NOTA: `encodeURIComponent` sobre el SVG legible, y no un base64 pegado.
 * Un data URI en base64 es una pared de caracteres que nadie revisa: no se puede
 * ver en una diff que el icono cambió, ni comprobar a ojo que el SVG está bien
 * formado. Así el fuente sigue siendo el dibujo, y la codificación es un detalle
 * que se calcula una vez al cargar el módulo.
 *
 * El icono TIENE que ser un data URI válido, no una cadena inventada: los
 * selectores multi-wallet lo renderizan en un <img>, y uno roto se ve roto.
 */

/**
 * A trimmed copy of assets/icon.svg: same gradient and same hexagons, minus the
 * comments and the id-heavy formatting that only matter to the PNG pipeline.
 */
const PROVIDER_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">',
  '<defs><linearGradient id="cc" x1="0" y1="0" x2="0" y2="1">',
  '<stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#3b1fa8"/>',
  "</linearGradient></defs>",
  '<rect width="128" height="128" rx="28" fill="url(#cc)"/>',
  '<path d="M64 24 L96 44 L96 84 L64 104 L32 84 L32 44 Z" fill="none" stroke="#ffffff" stroke-width="7" stroke-linejoin="round"/>',
  '<path d="M64 44 L80 54 L80 74 L64 84 L48 74 L48 54 Z" fill="#ffffff" opacity="0.9"/>',
  "</svg>",
].join("");

/** What goes into `EIP6963ProviderInfo.icon`. */
export const PROVIDER_ICON_DATA_URI = `data:image/svg+xml,${encodeURIComponent(PROVIDER_ICON_SVG)}`;
