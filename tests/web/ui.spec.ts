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
/**
 * Layout guard: no horizontal page overflow; inside each row, no two visible cells overlap; nav links stay on one line.
 * Catches the class of bug where a table squeezed to phone width piles its text on top of itself.
 */
async function layoutProblems(page: Page, rowSelector: string, cellSelector = ":scope > *"): Promise<string[]> {
  return page.evaluate(([rowSel, cellSel]) => {
    const out: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) out.push(`page overflows horizontally: ${de.scrollWidth} > ${de.clientWidth}`);
    document.querySelectorAll(rowSel).forEach((row, ri) => {
      const r = row.getBoundingClientRect();
      if (r.right > de.clientWidth + 1) out.push(`row ${ri} sticks out: right ${Math.round(r.right)}`);
      const cells = [...row.querySelectorAll(cellSel)].map((c) => ({ c, b: c.getBoundingClientRect() })).filter((x) => x.b.width > 0 && x.b.height > 0 && getComputedStyle(x.c).visibility !== "hidden");
      for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i]!.b, b = cells[j]!.b;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 2 && oy > 2) out.push(`row ${ri}: cells ${i} and ${j} overlap (${Math.round(ox)}x${Math.round(oy)} px)`);
      }
    });
    document.querySelectorAll(".nav a").forEach((a) => {
      const lh = parseFloat(getComputedStyle(a).lineHeight) || parseFloat(getComputedStyle(a).fontSize) * 1.6;
      const lines = Math.round((a.getBoundingClientRect().height - parseFloat(getComputedStyle(a).paddingTop) - parseFloat(getComputedStyle(a).paddingBottom) - parseFloat(getComputedStyle(a).borderBottomWidth)) / lh);
      if (lines > 1) out.push(`nav link "${a.textContent}" wraps onto ${lines} lines`);
    });
    return out;
  }, [rowSelector, cellSelector] as const);
}

const shot = (page: Page, name: string, project: string) => page.screenshot({ path: `${SCREENS}/${name}-${project}.png`, fullPage: true });

test.describe("verify page (GitHub Pages build)", () => {
  test("valid demo mandate: every check passes against testnet", async ({ page }, info) => {
    await page.goto(`${VERIFY}?m=demo-valid`);
    await expect(page.locator("#result")).toHaveAttribute("aria-busy", "false", { timeout: 120_000 });
    await expect(page.locator("#verdict-word")).toHaveText("Valid");
    await expect(page.locator("#ledger tbody tr[data-state=pass]")).toHaveCount(9);
    await expect(page.locator("#facts")).toContainText("Valid until");
    await expect(page.locator("#verdict-hint")).toBeVisible();
    expect(await layoutProblems(page, "#ledger tbody tr", ":scope > td")).toEqual([]);
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

  test("a node or MCP outage shows 'could not check', never 'invalid'", async ({ page }) => {
    await page.route(/grpc\.testnet\.concordium\.com|agent-registry-mcp\.concordium\.com/, (r) => r.abort("connectionrefused"));
    await page.goto(`${VERIFY}?m=demo-valid`);
    await expect(page.locator("#verdict-word")).toHaveText("Retrying", { timeout: 60_000 });
    await expect(page.locator("#result")).toHaveAttribute("aria-busy", "false", { timeout: 120_000 });
    await expect(page.locator("#verdict-word")).toHaveText("Could not check");
    await expect(page.locator(".status--fail")).toHaveCount(0);
    await expect(page.locator("#verdict")).not.toHaveClass(/verdict--fail/);
  });

  test("a transient outage is retried and then succeeds", async ({ page }) => {
    let refused = 0;
    await page.route(/grpc\.testnet\.concordium\.com/, (r) => (refused++ < 2 ? r.abort("connectionrefused") : r.continue()));
    await page.goto(`${VERIFY}?m=demo-valid`);
    await expect(page.locator("#verdict-word")).toHaveText("Retrying", { timeout: 60_000 });
    await expect(page.locator("#result")).toHaveAttribute("aria-busy", "false", { timeout: 120_000 });
    await expect(page.locator("#verdict-word")).toHaveText("Valid");
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
    await expect(page.locator("#feed details[open]")).toHaveCount(0);
    expect(await layoutProblems(page, "#feed > li .entry", ":scope > span")).toEqual([]);
    await shot(page, "site-feed", info.project.name);
    const summary = page.locator("#feed details summary").first();
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#feed details").first().locator("table")).toBeVisible();
    await axe(page);
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
    expect(await layoutProblems(page, "#mandates tbody tr.mrow", ":scope > td")).toEqual([]);
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
