// Page-only captures for the demo video (Playwright recordVideo, bundled Chromium, 1920x1080). No screen recording, no terminal.
// Needs the operator service (4022), the demo site (4021, started fresh so its feed is empty) and the console (4020) running.
// It drives the real flow on testnet: issue a mandate in the console, the agent acts under it, pays, the human revokes, the
// agent is refused. Writes docs/video/captures/shot-N.webm, shot-N.png (a still), and events.json (click positions and times
// for the video bot's coded cursor).
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { MandateAgent } from "../../apps/agent/src/agent.ts";
import { accountKey, agentKey, REPO_ROOT, saveState, state } from "@mandate/node";
import type { SignedMandate } from "@mandate/core";

const OUT = resolve(REPO_ROOT, "docs", "video", "captures");
const SITE = "http://localhost:4021/";
const CONSOLE = "http://127.0.0.1:4020/";
const PAGES = "https://seunghyeon1004.github.io/mandate/";
const W = 1920, H = 1080, ZOOM = 1.5; // a 1280x720 layout rendered sharp at 1920x1080

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const events: Record<string, Array<{ t: number; kind: string; x?: number; y?: number; label: string }>> = {};
const browser = await chromium.launch({ headless: true });

async function shot(n: number, label: string, fn: (page: Page, mark: (kind: string, label: string, sel?: string) => Promise<void>) => Promise<void>) {
  const ctx: BrowserContext = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  await page.addInitScript(`document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "html { zoom: ${ZOOM}; } ::-webkit-scrollbar { display: none; }"; document.head.appendChild(s); });`);
  const t0 = Date.now();
  const list: (typeof events)[string] = (events[`shot-${n}`] = []);
  const mark = async (kind: string, l: string, sel?: string) => {
    let x: number | undefined, y: number | undefined;
    if (sel) { const b = await page.locator(sel).first().boundingBox(); if (b) { x = Math.round(b.x + b.width / 2); y = Math.round(b.y + b.height / 2); } }
    list.push({ t: (Date.now() - t0) / 1000, kind, ...(x !== undefined ? { x, y } : {}), label: l });
  };
  console.log(`shot ${n}: ${label}`);
  await fn(page, mark);
  await page.screenshot({ path: resolve(OUT, `shot-${n}.png`) });
  const video = page.video();
  await ctx.close();
  if (video) renameSync(await video.path(), resolve(OUT, `shot-${n}.webm`));
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shot 1: the problem. The demo site's sign-up with its puzzle placeholder (no real CAPTCHA brand).
await shot(1, "sign-up puzzle", async (page, mark) => {
  await page.goto(SITE);
  await page.locator("#feed").waitFor();
  await pause(1500);
  await mark("zoom", "puzzle placeholder", ".puzzle__box");
  await pause(5000);
});

// Shot 2: the human's console, agent panel with a valid badge.
await shot(2, "console agent panel", async (page, mark) => {
  await page.goto(CONSOLE);
  await page.locator("#agent-badge .status--pass").waitFor({ timeout: 60_000 });
  await pause(1500);
  await mark("zoom", "badge valid", "#agent-badge");
  await pause(5000);
});

// Shot 3: issue a mandate (real, about 30 s on testnet) and watch the five steps fill with transaction links.
let issuedId = "";
await shot(3, "issue a mandate", async (page, mark) => {
  await page.goto(CONSOLE);
  await page.locator("#issue").scrollIntoViewIfNeeded();
  await pause(1500);
  await page.locator("#f-ttl").selectOption("1d");
  await mark("click", "Prove age and issue", "#issue-btn");
  await page.locator("#issue-btn").click();
  await page.locator('#steps li[data-step="anchor"][data-state="done"]').waitFor({ timeout: 180_000 });
  await pause(2500);
  await page.locator("#mandates").scrollIntoViewIfNeeded();
  await mark("zoom", "new mandate, Active", "#mandates tbody tr.mrow");
  await pause(3000);
  const r = await (await fetch(`${CONSOLE}api/mandates`)).json() as { mandates: Array<{ id: string; status: string }> };
  issuedId = r.mandates.find((m) => m.status === "active")!.id;
});
saveState("mandates/current.json", { id: issuedId });
const signed = state<SignedMandate>(`mandates/${issuedId}.json`)!;
const k = await agentKey();
const agent = new MandateAgent({ mandate: signed, agentSecretKey: k.secretKey, wallet: accountKey("agentWallet") });
console.log("mandate for shots 4-6:", issuedId);

// Shot 4: the agent signs up; the site's feed shows it accepted with no puzzle; expand the checks.
await shot(4, "agent signs up", async (page, mark) => {
  await page.goto(SITE);
  await page.locator("#feed").waitFor();
  await page.locator("#feed-h").scrollIntoViewIfNeeded();
  await pause(1500);
  await agent.callWithMandate(`${SITE}api/signup`, { json: { email: "agent@example.org" } });
  await page.locator("#feed .entry").first().waitFor();
  await pause(2500);
  await mark("click", "All 15 checks passed", "#feed details summary");
  await page.locator("#feed details summary").first().click();
  await pause(5000);
  await page.locator("#feed details summary").first().click();
  await page.locator("#feed .entry__sub").first().getByText("finalized").waitFor({ timeout: 60_000 }).catch(() => {});
  await mark("zoom", "receipt finalized", "#feed .entry__sub");
  await pause(3000);
});

// Shot 5: paid report within the cap (x402 in CCD), then a bundle above the cap refused before any payment.
await shot(5, "pay within the cap", async (page, mark) => {
  await page.goto(SITE);
  await page.locator("#feed-h").scrollIntoViewIfNeeded();
  await pause(1500);
  await agent.callWithMandate(`${SITE}api/premium-report`);
  await page.locator("#feed .entry").first().getByText("bought a report").waitFor({ timeout: 60_000 });
  await mark("zoom", "paid 0.05 CCD", "#feed .entry__sub");
  await pause(4000);
  await agent.callWithMandate(`${SITE}api/premium-bundle`);
  await page.locator("#feed .entry").first().getByText("price above").waitFor({ timeout: 30_000 });
  await mark("zoom", "refused above the cap", "#feed .entry__verdict");
  await pause(4500);
});

// Shot 6: revoke in the console (typed confirmation, one transaction), then the agent is refused.
await shot(6, "revoke", async (page, mark) => {
  await page.goto(CONSOLE);
  const row = page.locator(`#mandates tbody tr.mrow:has(.confirm[data-id="${issuedId}"])`);
  await row.waitFor({ timeout: 60_000 });
  await row.scrollIntoViewIfNeeded();
  await pause(1500);
  await mark("click", "Revoke", `.confirm[data-id="${issuedId}"] button`);
  await row.locator('button[data-act="ask"]').click();
  await row.locator("input").pressSequentially(issuedId.slice(0, 8), { delay: 90 });
  await mark("click", "Revoke now", `.confirm[data-id="${issuedId}"] button[data-act="do"]`);
  await row.locator('button[data-act="do"]').click();
  await row.getByText("Revoked").first().waitFor({ timeout: 120_000 });
  await pause(2500);
  await page.goto(SITE);
  await page.locator("#feed-h").scrollIntoViewIfNeeded();
  let refused = false;
  for (let i = 0; i < 10 && !refused; i++) {
    const r = await agent.callWithMandate(`${SITE}api/signup`, { json: { email: "agent@example.org" } });
    refused = (r.body as { error?: string }).error === "revoked";
    if (!refused) await pause(2000);
  }
  await page.locator("#feed .entry").first().getByText("mandate revoked").waitFor({ timeout: 30_000 });
  await mark("zoom", "Rejected: mandate revoked", "#feed .entry__verdict");
  await pause(4500);
});

// Shot 7: the public verify page on GitHub Pages, valid then revoked, with the "Answered by" column.
await shot(7, "verify it yourself", async (page, mark) => {
  await page.goto(`${PAGES}verify/?m=demo-valid`);
  await page.locator('#result[aria-busy="false"]').waitFor({ timeout: 120_000 });
  await pause(1500);
  await mark("zoom", "Valid", "#verdict-word");
  await pause(2500);
  await page.locator("#ledger").scrollIntoViewIfNeeded();
  await mark("zoom", "Answered by", "#ledger thead th:nth-child(4)");
  await pause(3500);
  await page.goto(`${PAGES}verify/?m=demo-revoked`);
  await page.locator('#result[aria-busy="false"]').waitFor({ timeout: 120_000 });
  await pause(1000);
  await mark("zoom", "Revoked", "#verdict-word");
  await pause(3500);
});

// Shot 8: the landing page with the links.
await shot(8, "call to action", async (page, mark) => {
  await page.goto(PAGES);
  await pause(1500);
  await mark("zoom", "Verify the demo mandate", ".key--primary");
  await pause(6000);
});

await browser.close();
writeFileSync(resolve(OUT, "events.json"), JSON.stringify({ size: { width: W, height: H }, zoom: ZOOM, mandate: issuedId, shots: events }, null, 2));
console.log("captures written to", OUT);
