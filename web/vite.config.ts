import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8811" } },
  build: { outDir: "dist", emptyOutDir: true },
});
