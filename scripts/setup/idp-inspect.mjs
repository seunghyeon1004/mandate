// Open the IdP form in Playwright's bundled Chromium (headless) and list its fields. Read-only.
import { chromium } from "playwright";
import { readSecret } from "./lib.mjs";
const url = readSecret(`${process.argv[2]}.idp-start.txt`).trim();
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto(url, { waitUntil: "networkidle" });
console.log("title:", await p.title());
const fields = await p.evaluate(() => [...document.querySelectorAll("input,select,textarea,button")].map((e) => ({ tag: e.tagName, type: e.type, name: e.name, id: e.id, label: (e.labels?.[0]?.innerText || e.placeholder || e.innerText || "").trim().slice(0, 40), options: e.tagName === "SELECT" ? [...e.options].slice(0, 4).map((o) => o.value) : undefined })));
for (const f of fields) console.log(JSON.stringify(f));
await b.close();
