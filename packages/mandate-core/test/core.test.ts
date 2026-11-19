import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  anchorValue, canonicalJson, decodeMandateHeader, encodeMandateHeader, mandateHash, parseAnchor, revokedAnchorValue, signMandate,
  signRequest, validateMandate, verifyMandateSignature, verifyRequestSignature, buildMandateHeaders, parseSignatureHeader,
  MAX_MANDATE_HEADER_BYTES, type Mandate, type RequestToSign,
} from "../src/index.js";
import { baseMandate, fakeAgent, fakeHuman } from "./fixtures.js";

const shuffleKeys = (v: unknown, rnd: () => number): unknown => {
  if (Array.isArray(v)) return v.map((x) => shuffleKeys(x, rnd));
  if (v && typeof v === "object") {
    const keys = Object.keys(v).sort(() => rnd() - 0.5);
    return Object.fromEntries(keys.map((k) => [k, shuffleKeys((v as Record<string, unknown>)[k], rnd)]));
  }
  return v;
};

/** Every leaf path of a JSON object. */
const leaves = (v: unknown, p: string[] = []): string[][] =>
  v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => leaves(x, [...p, k])) : [p];

const mutateAt = (obj: unknown, path: string[]): unknown => {
  const copy = structuredClone(obj) as Record<string, unknown>;
  let cur = copy as Record<string, unknown>;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  const last = path.at(-1)!;
  const v = cur[last];
  cur[last] = typeof v === "number" ? v + 1 : typeof v === "string" ? (v.length ? (v[0] === "a" ? "b" : "a") + v.slice(1) : "x") : !v;
  return copy;
};

describe("canonicalisation", () => {
  test("JCS output is independent of key order (property)", () => {
    fc.assert(fc.property(fc.jsonValue(), fc.integer(), (v, seed) => {
      let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      expect(canonicalJson(shuffleKeys(v, rnd))).toBe(canonicalJson(v));
    }), { numRuns: 300 });
  });
  test("known vector (RFC 8785 ordering and number form)", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1e21, y: 0.5 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":0.5,"z":1e+21}}');
  });
});

describe("mandate", () => {
  test("valid fixture passes structural validation", async () => {
    const h = await fakeHuman(), a = await fakeAgent();
    expect(validateMandate(baseMandate(h.address, a.publicKeyHex))).toBeNull();
  });
  test("structural validation rejects bad fields", async () => {
    const h = await fakeHuman(), a = await fakeAgent();
    const m = baseMandate(h.address, a.publicKeyHex);
    expect(validateMandate({ ...m, v: 2 })).toMatch(/version/);
    expect(validateMandate({ ...m, issuer: "nope" })).toMatch(/issuer/);
    expect(validateMandate({ ...m, expiry: m.notBefore })).toMatch(/validity/);
    expect(validateMandate({ ...m, scope: { ...m.scope, domains: ["Bad Domain"] } })).toMatch(/domains/);
    expect(validateMandate({ ...m, scope: { ...m.scope, maxPerAction: { amount: "-1", asset: "CCD" } } })).toMatch(/maxPerAction/);
  });
  test("hash anchor round trip", async () => {
    const h = await fakeHuman(), a = await fakeAgent();
    const m = baseMandate(h.address, a.publicKeyHex);
    const v = anchorValue(m);
    expect(new TextEncoder().encode(v).length).toBeLessThanOrEqual(470);
    expect(parseAnchor(v)).toEqual({ kind: "active", hash: mandateHash(m), expiry: m.expiry });
    expect(parseAnchor(revokedAnchorValue(1800000000))).toEqual({ kind: "revoked", at: 1800000000 });
    expect(parseAnchor(null)).toEqual({ kind: "absent" });
    expect(parseAnchor("sha256:zz|exp:1")).toEqual({ kind: "invalid" });
  });
  test("human signature verifies, and any single-field change breaks hash and signature (property over every leaf)", async () => {
    const h = await fakeHuman(), a = await fakeAgent();
    const m = baseMandate(h.address, a.publicKeyHex);
    const sm = await signMandate(m, h.signer);
    expect(await verifyMandateSignature(sm, h.info)).toBe(true);
    const paths = leaves(m);
    expect(paths.length).toBeGreaterThan(15);
    for (const p of paths) {
      const changed = mutateAt(m, p) as Mandate;
      expect(mandateHash(changed), p.join(".")).not.toBe(mandateHash(m));
      expect(await verifyMandateSignature({ ...sm, mandate: changed }, h.info), p.join(".")).toBe(false);
    }
  });
  test("signature from another account does not verify", async () => {
    const h = await fakeHuman(), other = await fakeHuman(), a = await fakeAgent();
    const sm = await signMandate(baseMandate(h.address, a.publicKeyHex), other.signer);
    expect(await verifyMandateSignature(sm, h.info)).toBe(false);
  });
});

describe("request signature", () => {
  test("verifies, and any single-field change breaks it (property)", async () => {
    const a = await fakeAgent();
    const base: RequestToSign = { method: "POST", url: "https://shop.localhost/signup?x=1", body: '{"email":"a@b.c"}', timestamp: 1_800_000_000_000, nonce: "ab".repeat(16), mandateHash: "cd".repeat(32) };
    const sig = await signRequest(base, a.secretKey);
    expect(await verifyRequestSignature(base, sig, a.publicKeyHex)).toBe(true);
    const variants: Array<Partial<RequestToSign>> = [
      { method: "GET" }, { url: "https://shop.localhost/signup?x=2" }, { url: "https://evil.localhost/signup?x=1" }, { body: '{"email":"a@b.d"}' },
      { timestamp: base.timestamp + 1 }, { nonce: "ac".repeat(16) }, { mandateHash: "ce".repeat(32) },
    ];
    for (const v of variants) expect(await verifyRequestSignature({ ...base, ...v }, sig, a.publicKeyHex), JSON.stringify(v)).toBe(false);
    await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 64 }), async (body) => {
      fc.pre(body !== base.body);
      return !(await verifyRequestSignature({ ...base, body }, sig, a.publicKeyHex));
    }), { numRuns: 100 });
  });
  test("wrong key does not verify", async () => {
    const a = await fakeAgent(), b = await fakeAgent();
    const r: RequestToSign = { method: "GET", url: "https://shop.localhost/", body: "", timestamp: 1, nonce: "ab".repeat(16), mandateHash: "cd".repeat(32) };
    expect(await verifyRequestSignature(r, await signRequest(r, b.secretKey), a.publicKeyHex)).toBe(false);
  });
  test("headers round trip and stay under the size limit", async () => {
    const h = await fakeHuman(), a = await fakeAgent();
    const sm = await signMandate(baseMandate(h.address, a.publicKeyHex), h.signer);
    const enc = encodeMandateHeader(sm);
    expect(enc.length).toBeLessThan(MAX_MANDATE_HEADER_BYTES);
    expect(decodeMandateHeader(enc)).toEqual(sm);
    const hd = await buildMandateHeaders(sm, { method: "POST", url: "https://shop.localhost/signup", body: "{}" }, a.secretKey, 123);
    expect(parseSignatureHeader(hd["mandate-signature"])?.timestamp).toBe(123);
    expect(decodeMandateHeader("not base64!")).toBeNull();
    expect(parseSignatureHeader("t=1, n=zz, s=abc")).toBeNull();
  });
});
