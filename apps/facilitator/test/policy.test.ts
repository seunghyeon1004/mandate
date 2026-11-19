import { describe, expect, test } from "vitest";
import { checkPolicy, defaultPolicy, RateLimiter } from "../src/policy.ts";

const HUMAN = "4jjXocyWa2vkaRjW7BAvQEvF8zzjrLRrktDFjExXkzKMKztn3b";
const ok = { sender: HUMAN, contract: { index: "12802", subindex: "0" }, receiveName: "CIS-8004.setMetadata", parameterHex: "00ff", energy: 30000 };

describe("sponsor policy", () => {
  const p = defaultPolicy([HUMAN]);
  test.each([
    ["allowed registry call", ok, null],
    ["unknown contract", { ...ok, contract: { index: "1", subindex: "0" } }, /not sponsored/],
    ["entry point not on the list (transfer)", { ...ok, receiveName: "CIS-8004.transfer" }, /not sponsored/],
    ["energy above cap", { ...ok, energy: 30001 }, /energy/],
    ["parameter too large", { ...ok, parameterHex: "00".repeat(2049) }, /parameter/],
    ["parameter not hex", { ...ok, parameterHex: "zz" }, /parameter/],
    ["sender not enrolled", { ...ok, sender: "3jBkXyEm6pSUwXqvyFptgtg3xN3LdBcSfmcnguGdtNtn7bJgnT" }, /enrolled/],
  ])("%s", (_l, req, expected) => {
    const r = checkPolicy(p, req);
    if (expected === null) expect(r).toBeNull();
    else expect(r).toMatch(expected as RegExp);
  });
  test("rate limiter", () => {
    const rl = new RateLimiter(2, 1000);
    expect([rl.allow("a", 0), rl.allow("a", 1), rl.allow("a", 2), rl.allow("b", 2), rl.allow("a", 1001)]).toEqual([true, true, false, true, true]);
  });
});
