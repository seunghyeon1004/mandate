import { test, expect } from "vitest";
test("workspace wiring", async () => {
  expect(await import("../src/index.js")).toBeTypeOf("object");
});
