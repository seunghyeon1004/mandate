import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"] } },
      // Testnet integration: on demand only (writes evidence, spends test CCD).
      { test: { name: "integration", include: ["tests/integration/**/*.test.ts"], testTimeout: 300_000 } },
    ],
  },
});
