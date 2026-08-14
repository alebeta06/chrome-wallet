/**
 * @file check-bundles.mjs
 * @description Two architectural rules, checked against what the build actually
 * emitted instead of against what we believe it emits.
 *
 * Run with `pnpm check:bundles`, after `pnpm build`. Exits non-zero on failure
 * so it works as a CI gate, and names the marker AND the file — a check that
 * only says "something is wrong" costs more than it saves.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: las dos reglas llevaban toda la vida del proyecto escritas en
 * `CLAUDE.md` y comprobadas a mano, cuando alguien se acordaba. Una restricción
 * de arquitectura que solo vive en un comentario no es una restricción: es una
 * intención, y las intenciones no fallan el build.
 *
 * La de ethers se comprobó por primera vez en la Fase 9 —nueve fases después de
 * escribirla— y resultó estar bien. Pero "resultó estar bien" no es lo mismo que
 * "está garantizada", y la diferencia solo se nota el día que deja de estarlo.
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/**
 * 🇪🇸 NOTA: identificadores internos de ethers, no el nombre del paquete. Buscar
 * "ethers" daría falsos positivos con cualquier comentario o cadena que lo
 * mencione, y falsos NEGATIVOS en cuanto el minificador renombre — estos seis
 * sobreviven a la minificación porque son nombres de clase exportados o de
 * primitivas criptográficas.
 */
const ETHERS_MARKERS = ["keccak", "HDNodeWallet", "JsonRpcProvider", "secp256k1", "sha256", "pbkdf2"];

/**
 * The three scripts Chrome loads as CLASSIC scripts, not modules.
 *
 * 🇪🇸 NOTA: si el bundle emite `import`/`export` de nivel superior, Chrome los
 * rechaza en runtime y el content script simplemente no se inyecta. No hay error
 * en el build; la wallet deja de existir para las páginas.
 */
const CLASSIC_SCRIPTS = ["content-script.js", "inject.js"];

/** Relative specifiers only: `from"./x.js"`, never a string that says "from". */
const SPECIFIER = /(?:^|[\s;,{}()=])(?:import|from)\s*"(\.\.?\/[^"]+)"/g;

/** A top-level import/export statement, which a classic script may not have. */
const ESM_STATEMENT = /^\s*(?:import|export)\s/m;

const failures = [];

function fail(message) {
  failures.push(message);
}

async function read(path) {
  return readFile(join(DIST, path), "utf8");
}

/**
 * Every file reachable from an entry, following relative imports.
 *
 * ---------------------------------------------------------------------------
 * REACHABILITY, NOT DIRECTORIES
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: la versión fácil de esta comprobación sería "assets/ no puede
 * contener ethers", y sería frágil en las dos direcciones. `background.js` —el
 * único sitio donde ethers SÍ puede estar— importa tres chunks de `assets/`, así
 * que basta con que Rollup mueva código allí para tener un falso positivo. Y al
 * revés: un chunk compartido con ethers dentro pasaría desapercibido si un día
 * se emitiera en la raíz.
 *
 * Lo que la regla dice de verdad es que ethers no sea ALCANZABLE desde una
 * pantalla, así que eso es lo que se mide.
 */
async function reachableFrom(entry) {
  const seen = new Set();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop();
    if (seen.has(current)) continue;
    seen.add(current);

    let source;
    try {
      source = await read(current);
    } catch {
      fail(`${entry}: imports ${current}, which the build did not emit`);
      continue;
    }

    for (const match of source.matchAll(SPECIFIER)) {
      const resolved = join(dirname(current), match[1]);
      queue.push(resolved);
    }
  }

  return seen;
}

/** The entry script an HTML file loads. */
async function entryScriptOf(html) {
  const source = await read(html);
  const match = source.match(/<script[^>]+src="\/?([^"]+)"/);

  if (match === null) {
    fail(`${html}: no entry script found, so nothing could be checked`);
    return null;
  }
  return match[1];
}

async function checkNoEthersInUi() {
  const pages = (await readdir(DIST)).filter((name) => name.endsWith(".html"));

  if (pages.length === 0) {
    fail("dist/ has no HTML pages — did the build run?");
    return;
  }

  for (const page of pages.sort()) {
    const entry = await entryScriptOf(page);
    if (entry === null) continue;

    for (const file of await reachableFrom(entry)) {
      const source = await read(file).catch(() => "");

      for (const marker of ETHERS_MARKERS) {
        if (source.includes(marker)) {
          fail(
            `${page} reaches ${file}, which contains "${marker}". ` +
              `ethers must never end up in a UI bundle — see lib/format.ts.`,
          );
        }
      }
    }
  }
}

async function checkClassicScripts() {
  for (const name of CLASSIC_SCRIPTS) {
    let source;
    try {
      source = await read(name);
    } catch {
      fail(`${name} is missing from dist/ — did the build run?`);
      continue;
    }

    const esm = source.match(ESM_STATEMENT);
    if (esm !== null) {
      fail(
        `${name} contains a top-level "${esm[0].trim()}" statement. ` +
          `Chrome loads it as a classic script and it will fail at runtime, silently.`,
      );
    }

    for (const marker of ETHERS_MARKERS) {
      if (source.includes(marker)) {
        fail(`${name} contains "${marker}". Page-injected scripts must never carry ethers.`);
      }
    }
  }
}

await checkClassicScripts();
await checkNoEthersInUi();

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} bundle check(s) failed:\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("");
  process.exit(1);
}

console.log("✓ bundles: no ethers reachable from any page, no ESM in the classic scripts");
