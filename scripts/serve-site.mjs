// Static server for site/ (what GitHub Pages serves), for local tests. 127.0.0.1 only.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "site");
const port = Number(process.env.PORT ?? 18431);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/mandate/, "");
  let f = join(root, p);
  if (!f.startsWith(root)) { res.writeHead(403).end(); return; }
  try { if ((await stat(f)).isDirectory()) f = join(f, "index.html"); res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }).end(await readFile(f)); }
  catch { res.writeHead(404).end("not found"); }
}).listen(port, "127.0.0.1", () => console.log(`site/ on http://127.0.0.1:${port}/mandate/`));
