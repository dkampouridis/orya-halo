// Writes docs/mockup/icons/*.svg from the single source in icons.js.
//   node docs/mockup/build-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = {};
// icons.js is a plain browser script; give it a stand-in window and read what it attaches.
new Function("window", readFileSync(join(here, "icons.js"), "utf8"))(sandbox);
const { ICONS, GLYPHS, file, glyphFile } = sandbox.HaloIcons;

const out = join(here, "icons");
mkdirSync(out, { recursive: true });
for (const name of Object.keys(ICONS)) writeFileSync(join(out, `${name}.svg`), file(name));
for (const name of Object.keys(GLYPHS))
  writeFileSync(join(out, `glyph-${name}.svg`), glyphFile(name));
console.log(
  `${Object.keys(ICONS).length} icons and ${Object.keys(GLYPHS).length} map glyphs written to ${out}`,
);
