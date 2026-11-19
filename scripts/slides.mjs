// Renders docs/slides/index.html to docs/SLIDES.pdf (16:9, 1280x720 pages) with Playwright's bundled Chromium.
// With an output folder argument it also writes one PNG per slide, for checking each page by eye.
import { chromium } from "playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pngDir = process.argv[2];
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto(pathToFileURL(resolve(repo, "docs", "slides", "index.html")).href, { waitUntil: "networkidle" });
await p.evaluate(() => document.fonts.ready);
const broken = await p.evaluate(() => [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute("src")));
if (broken.length) throw new Error(`images not loaded: ${broken.join(", ")}`);
const overflow = await p.evaluate(() => [...document.querySelectorAll(".slide")].map((s, i) => [...s.querySelectorAll("*")].filter((e) => !e.closest(".shot")).some((e) => { const r = e.getBoundingClientRect(), sr = s.getBoundingClientRect(); return r.width > 0 && (r.right > sr.right + 1 || r.bottom > sr.bottom + 1); }) ? i + 1 : 0).filter(Boolean));
if (overflow.length) console.log("WARNING: content outside the page on slide(s)", overflow.join(", "));
await p.pdf({ path: resolve(repo, "docs", "SLIDES.pdf"), width: "1280px", height: "720px", printBackground: true, preferCSSPageSize: true });
if (pngDir) {
  const n = await p.locator(".slide").count();
  for (let i = 0; i < n; i++) await p.locator(".slide").nth(i).screenshot({ path: `${pngDir}/slide-${i + 1}.png` });
}
await b.close();
console.log(`docs/SLIDES.pdf written${pngDir ? `, PNGs in ${pngDir}` : ""}`);
