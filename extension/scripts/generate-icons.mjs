/**
 * @file generate-icons.mjs
 * @description Renders assets/icon.svg to the PNG sizes the manifest declares.
 *
 * Run it by hand with `pnpm icons`. It is deliberately NOT part of `pnpm build`:
 * the PNGs are committed, so a clean checkout builds without needing sharp's
 * native binaries.
 *
 * 🇪🇸 NOTA: ¿por qué PNG y no el SVG directamente, si el manifest acepta SVG en
 * `icons`? Porque `chrome.notifications.create()` NO lo acepta: si le pasas un
 * iconUrl que apunta a un SVG, la llamada falla en silencio — no lanza, no
 * rechaza la promesa, simplemente no aparece ninguna notificación. Lo vamos a
 * necesitar en la Fase 9, y ese bug se tarda una tarde en encontrar.
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(root, "assets/icon.svg");
const OUT_DIR = resolve(root, "public/icons");
const SIZES = [16, 48, 128];

const svg = await readFile(SOURCE);
await mkdir(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  const outFile = resolve(OUT_DIR, `icon-${size}.png`);
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(outFile);
  console.log(`wrote icons/icon-${size}.png`);
}
