import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";

// Keeps the Hallmark stamp (the first lines of the shared stylesheet) on top of the bundled CSS; the minifier drops comments.
function keepStamp(): Plugin {
  const src = readFileSync(new URL("../../site/assets/mandate.css", import.meta.url), "utf8");
  const stamp = src.split("\n").slice(0, src.split("\n").findIndex((l) => l.startsWith("@import"))).join("\n");
  return {
    name: "keep-hallmark-stamp",
    generateBundle(_o, bundle) {
      for (const f of Object.values(bundle)) if (f.type === "asset" && f.fileName.endsWith(".css")) f.source = `${stamp}\n${String(f.source)}`;
    },
  };
}

// Built into site/verify/ by the Pages workflow; relative base works at https://<user>.github.io/mandate/verify/
export default defineConfig({
  base: "./",
  plugins: [keepStamp()],
  build: { outDir: "../../site/verify", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 8000 },
  server: { host: "127.0.0.1" },
});
