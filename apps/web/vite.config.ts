import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  worker: { format: "es" },
  // The overlays load on first use; without these the first open makes the dev server
  // discover new dependencies, re-optimise and reload the page.
  optimizeDeps: { include: ["@base-ui/react/dialog", "@base-ui/react/switch"] },
  server: { port: 5173, strictPort: false },
  build: { target: "es2023", sourcemap: true },
});
