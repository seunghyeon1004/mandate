import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { resolve } from "node:path";

const SCREENS = resolve(import.meta.dirname, "..", "..", "docs", "screens");
const VERIFY = "http://127.0.0.1:18431/mandate/verify/";
const SITE = "http://localhost:4021/";
const CONSOLE = "http://127.0.0.1:4020/";

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.length} node(s) ${v.nodes[0]?.target}`)).toEqual([]);
  return r.violations.length;
}
async function up(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}
const shot = (page: Page, name: string, project: string) => page.screenshot({ path: `${SCREENS}/${name}-${project}.png`, fullPage: true });

test.describe("verify page (GitHub Pages build)", () => {
  test("valid demo mandate: every check passes against testnet", async ({ page }, info) => {
    await page.goto(`${VERIFY}?m=demo-valid`);
    await expect(page.locator("#result")).toHaveAttribute("aria-busy", "false", { timeout: 120_000 });
    await expect(page.locator("#verdict-word")).toHaveText("Valid");
    await expect(page.locator("#ledger tbody tr[data-state=pass]")).toHaveCount(9);
    await expect(page.locator("#facts")).toContainText("Valid until");
    await axe(page);
    await shot(page, "verify-valid", info.project.name);
  });

  test("revoked demo mandate: the anchor check fails with the revocation time", async ({ page }, info) => {
    await page.goto(`${VERIFY}?m=demo-revoked`);
    await expect(page.locator("#result")).toHaveAttribute("aria-busy", "false", { timeout: 120_000 });
    await expect(page.locator("#verdict-word")).toHaveText("Revoked");
    await expect(page.locator("#ledger tbody tr[data-state=fail]")).toHaveCount(1);
    await expect(page.locator("#ledger tbody tr[data-state=fail]")).toContainText("revoked");
    await axe(page);
    await shot(page, "verify-revoked", info.project.name);
  });

  test("pasting something that is not a mandate shows an error, and the page works by keyboard", async ({ page }) => {
    await page.goto(`${VERIFY}?m=paste`);
    await page.keyboard.press("Tab");
    await expect(page.locator("a.visually-hidden")).toBeFocused();
    await page.locator("#paste-input").fill("{ not json");
    await page.locator("#paste-input").press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.locator("#paste-error")).toBeVisible();
    await expect(page.locator("#paste-input")).toHaveAttribute("aria-invalid", "true");
    await axe(page);
  });
});

test.describe("demo relying party", () => {
  test.beforeEach(async () => { test.skip(!(await up(`${SITE}health`)), "demo site not running on :4021"); });
  test("feed shows accepted and rejected agent requests with receipts; checks open by keyboard", async ({ page }, info) => {
    await page.goto(SITE);
    await expect(page.locator("#feed")).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
    const items = page.locator("#feed > li .entry");
    test.skip((await items.count()) === 0, "no agent traffic yet");
    await expect(page.locator("#feed")).toContainText("Accepted, no puzzle");
    const summary = page.locator("#feed details summary").first();
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#feed details").first().locator("table")).toBeVisible();
    await axe(page);
    await shot(page, "site-feed", info.project.name);
  });
  test("human sign-up form validates", async ({ page }) => {
    await page.goto(SITE);
    await page.locator("#signup button[type=submit]").click();
    await expect(page.locator("#signup-msg")).toContainText("Enter an email");
    await expect(page.locator("#email")).toBeFocused();
  });
});

test.describe("issuer console", () => {
  test.beforeEach(async () => { test.skip(!(await up(CONSOLE)), "console not running on :4020"); });
  test("agent, mandates and on-chain log render; badge is valid", async ({ page }, info) => {
    await page.goto(CONSOLE);
    await expect(page.locator("#agent-badge")).toContainText("badge valid", { timeout: 30_000 });
    await expect(page.locator("#mandates tbody tr").first()).not.toContainText("Could not", { timeout: 30_000 });
    await expect(page.locator("#log tbody tr").first()).toBeVisible();
    await axe(page);
    await shot(page, "console", info.project.name);
  });
  test("issue form refuses an empty mandate and moves focus to the problem", async ({ page }) => {
    await page.goto(CONSOLE);
    for (const c of await page.locator('input[name="actions"]').all()) await c.uncheck();
    await page.locator("#issue-btn").click();
    await expect(page.locator("#e-actions")).toHaveText("Pick at least one action.");
    await expect(page.locator('input[name="actions"]').first()).toBeFocused();
  });
  test("revoke asks for a typed confirmation and can be cancelled", async ({ page }) => {
    await page.goto(CONSOLE);
    const ask = page.locator('#mandates button[data-act="ask"]').first();
    test.skip(!(await ask.isVisible({ timeout: 30_000 }).catch(() => false)), "no active mandate");
    await ask.click();
    await expect(page.locator('#mandates .confirm input')).toBeFocused();
    await page.locator('#mandates button[data-act="do"]').click();
    await expect(page.locator('#mandates .confirm input')).toHaveAttribute("aria-invalid", "true");
    await page.locator('#mandates button[data-act="cancel"]').click();
    await expect(page.locator('#mandates button[data-act="ask"]').first()).toBeFocused();
  });
});
