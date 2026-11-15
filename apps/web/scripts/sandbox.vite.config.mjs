// Build configuration for the engine sandbox alone. Used by
// scripts/measure-bundle.mjs to see what the engine costs on the wire without
// touching the app's own build:
//
//   vp build --config scripts/sandbox.vite.config.mjs
//
// The output goes to node_modules/.cache, which git ignores.
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite-plus";
import base from "../vite.config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

export default mergeConfig(
  base,
  defineConfig({
    root,
    build: {
      outDir: fileURLToPath(
        new URL("../node_modules/.cache/orya-halo/sandbox-dist", import.meta.url),
      ),
      emptyOutDir: true,
      // Source maps only when measure-bundle.mjs asks for the per-package breakdown.
      sourcemap: process.env.HALO_SOURCEMAP === "1",
      // The 14 MiB tile extract is not part of the code being measured.
      copyPublicDir: false,
      rollupOptions: {
        input: { sandbox: fileURLToPath(new URL("../sandbox.html", import.meta.url)) },
      },
    },
  }),
);
