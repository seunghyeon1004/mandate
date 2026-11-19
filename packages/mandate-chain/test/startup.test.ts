import { describe, expect, test } from "vitest";
import type { ConcordiumGRPCClient } from "@concordium/web-sdk";
import { isTransientNodeError, loadContract, RegistryStartupError } from "../src/contracts.js";

/** Fake node: fails getInstanceInfo with the given errors first, then answers like the CIS-8 instance. */
function fakeNode(failures: Error[]) {
  let calls = 0;
  const client = {
    async getInstanceInfo() {
      calls++;
      const f = failures.shift();
      if (f) throw f;
      return { name: { value: "init_CIS-8" }, methods: ["registerExternalKey", "ownerOfKey", "revoke"].map((m) => ({ value: `CIS-8.${m}` })), sourceModule: { moduleRef: "ab".repeat(32) } };
    },
    async getEmbeddedSchema() { return { buffer: new Uint8Array([1, 2, 3]) }; },
  } as unknown as ConcordiumGRPCClient;
  return { client, calls: () => calls };
}
const http502 = () => new Error("Received HTTP status code 502");
const fast = [1, 1];

describe("start-up schema load retries transient node errors", () => {
  test("two 502s, then success", async () => {
    const n = fakeNode([http502(), http502()]);
    const h = await loadContract(n.client, 12801n, 0n, "CIS-8", ["registerExternalKey"], fast);
    expect(h.name).toBe("CIS-8");
    expect(n.calls()).toBe(3);
  });
  test("three 502s: gives up with a clear start-up error", async () => {
    const n = fakeNode([http502(), http502(), http502()]);
    await expect(loadContract(n.client, 12801n, 0n, "CIS-8", ["registerExternalKey"], fast)).rejects.toThrow(RegistryStartupError);
    expect(n.calls()).toBe(3);
  });
  test("a non-transient error is not retried", async () => {
    const n = fakeNode([new Error("NOT_FOUND: instance does not exist")]);
    await expect(loadContract(n.client, 12801n, 0n, "CIS-8", ["registerExternalKey"], fast)).rejects.toThrow(/not readable/);
    expect(n.calls()).toBe(1);
  });
  test("classifier", () => {
    expect(isTransientNodeError(http502())).toBe(true);
    expect(isTransientNodeError(new Error("Received HTTP status code 503"))).toBe(true);
    expect(isTransientNodeError(new Error("contract rejected"))).toBe(false);
  });
});
