// Step 2: fill the self-service TESTNET identity form (IdP 0) with clearly invented attributes, in Playwright's bundled Chromium.
// Captures the redirect (code_uri) and stores it under ../.secrets/<label>.code-uri.txt.
import { chromium } from "playwright";
import { readSecret, writeSecret } from "./lib.mjs";
const [label, first = "Test", last = "Human", dob = "19900101"] = process.argv.slice(2);
const url = readSecret(`${label}.idp-start.txt`).trim();
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
let codeUri = null;
await p.route("http://127.0.0.1:8765/**", (r) => { codeUri = new URL(r.request().url()); return r.fulfill({ status: 200, body: "ok" }); });
p.on("framenavigated", (f) => { if (f.url().startsWith("http://127.0.0.1:8765/")) codeUri = new URL(f.url()); });
await p.goto(url, { waitUntil: "networkidle" });
const fake = { firstName: first, lastName: last, sex: "0", dob, countryOfResidence: "DK", nationality: "DK", idDocType: "0", idDocNo: "TEST-0001", idDocIssuer: "DK", idDocIssuedAt: "20200101", idDocExpiresAt: "20300101", nationalIdNo: "TEST-NOT-REAL", taxIdNo: "TEST-NOT-REAL" };
for (const [k, v] of Object.entries(fake)) await p.fill(`[name="${k}"]`, v);
await p.fill('[name="expiry"]', "2030-12").catch(() => {});
await Promise.all([p.waitForURL(/127\.0\.0\.1:8765/, { timeout: 60000 }).catch(() => {}), p.click('input[type="submit"]')]);
await p.waitForTimeout(1500);
const finalUrl = codeUri?.href ?? p.url();
const hash = new URLSearchParams(new URL(finalUrl).hash.slice(1));
const cu = hash.get("code_uri");
console.log("redirect host:", new URL(finalUrl).host, "| code_uri present:", Boolean(cu), cu ? "| code_uri host: " + new URL(cu).host : "| page text: " + (await p.evaluate(() => document.body.innerText)).slice(0, 300));
if (cu) writeSecret(`${label}.code-uri.txt`, cu);
await b.close();
