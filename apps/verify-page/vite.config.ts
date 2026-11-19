import { defineConfig } from "vite";
// Built into site/verify/ by the Pages workflow; base path matches https://<user>.github.io/mandate/verify/
export default defineConfig({
  base: "./",
  build: { outDir: "../../site/verify", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 8000 },
  server: { host: "127.0.0.1" },
});
