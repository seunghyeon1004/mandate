import { defineConfig } from "@playwright/test";
// Web tests use Playwright's bundled Chromium only. The verify page is served from site/ (build it first);
// the demo site (4021) and console (4020) tests run when those local services are up, and are skipped otherwise.
export default defineConfig({
  testDir: "tests/web",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { browserName: "chromium", trace: "off" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "phone", use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } },
  ],
  webServer: { command: "node scripts/serve-site.mjs", url: "http://127.0.0.1:18431/mandate/verify/", reuseExistingServer: true, timeout: 30_000 },
});
