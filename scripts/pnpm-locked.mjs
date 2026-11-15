#!/usr/bin/env node
// Serialises dependency changes when several people (or agents) work in the
// same checkout at once. Usage: node scripts/pnpm-locked.mjs add --filter @orya-halo/web some-package
// A directory is used as the mutex because mkdir is atomic on every platform.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lock = join(root, ".install.lock");
const STALE_MS = 10 * 60_000;
const deadline = Date.now() + 15 * 60_000;

for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_MS)
        rmSync(lock, { recursive: true, force: true });
    } catch {}
    if (Date.now() > deadline) {
      console.error("pnpm-locked: timed out waiting for .install.lock");
      process.exit(1);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
}

let status = 1;
try {
  const res = spawnSync("pnpm", process.argv.slice(2), {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  status = res.status ?? 1;
} finally {
  rmSync(lock, { recursive: true, force: true });
}
process.exit(status);
