import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtures } from "./fixtures.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
for (const [name, buffer] of Object.entries(buildFixtures())) {
  writeFileSync(join(dir, `${name}.bin`), new Uint8Array(buffer));
  console.log(`${name}.bin  ${buffer.byteLength} bytes`);
}
