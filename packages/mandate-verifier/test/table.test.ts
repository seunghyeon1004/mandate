// Table test: one row per rejection reason plus the happy path, through a real Express server, real HTTP and real signatures.
// Chain state is a controllable in-memory fake; the same checks run against Concordium testnet in tests/integration.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  CCD_MAINNET, CCD_TESTNET, anchorKey, anchorValue, buildMandateHeaders, mandateHash, revokedAnchorValue, signMandate,
  type AgentRecord, type ChainView, type KeyRecord, type Mandate, type RejectionCode, type SignedMandate, type Sourced,
} from "@mandate/core";
import type { AccountInfo } from "@concordium/web-sdk";
import { MandateVerifier, MemoryLedger } from "../src/index.js";
import { baseMandate, fakeAgent, fakeHuman } from "../../mandate-core/test/fixtures.js";

class FakeChain implements ChainView {
  infos = new Map<string, AccountInfo>();
  anchors = new Map<string, string>();
  agents = new Map<string, AgentRecord>();
  keys = new Map<string, KeyRecord>();
  adult: { ok: boolean; reason?: string } = { ok: true };
  down = false;
  private s<T>(value: T): Sourced<T> {
    if (this.down) throw new Error("node unreachable");
    return { value, source: "grpc" };
  }
  async accountInfo(a: string) { const i = this.infos.get(a); if (!i) throw new Error("no account"); return this.s(i); }
  async mandateAnchor(t: string, k: string) { return this.s(this.anchors.get(`${t}/${k}`) ?? null); }
  async agent(t: string) { return this.s(this.agents.get(t) ?? null); }
  async keyOwner(k: { publicKeyHex: string }) { return this.s(this.keys.get(k.publicKeyHex) ?? null); }
  async adultProof() { return this.s(this.adult); }
}

const DOMAIN = "shop.localhost";
let server: Server;
let base = "";
let verifier: MandateVerifier;
let chain: FakeChain;
let ledger: MemoryLedger;

beforeAll(async () => {
  chain = new FakeChain();
  ledger = new MemoryLedger();
  const app = express();
  const raw = MandateVerifier.rawBody();
  // publicOrigin pins the URL the agent signs, as a real deployment behind a proxy would.
  app.post("/signup", raw, (req, res, next) => verifier.require("signup")(req, res, next), (_req, res) => { res.json({ ok: true, account: "created", checks: res.locals.mandate?.checks }); });
  app.post("/delete-account", raw, (req, res, next) => verifier.require("delete_account")(req, res, next), (_req, res) => { res.json({ ok: true }); });
  app.get("/report", raw, (req, res, next) => verifier.require("buy_report", { price: { amount: String((req.query.p as string) ?? "50000"), asset: "CCD" } })(req, res, next), (_req, res) => { res.json({ ok: true }); });
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  verifier = new MandateVerifier({ chain, ledger, policy: { network: CCD_TESTNET, registry: { index: "12802", subindex: "0" }, maxSkewMs: 60_000 }, publicOrigin: `http://${DOMAIN}:${port}` });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

interface World { human: Awaited<ReturnType<typeof fakeHuman>>; agent: Awaited<ReturnType<typeof fakeAgent>>; m: Mandate; sm: SignedMandate }

/** A fully valid world: signed mandate, anchor on chain, agent owned by the issuer referencing the key, key bound, adult proof ok. */
async function world(edit: (m: Mandate) => void = () => {}): Promise<World> {
  const human = await fakeHuman(), agent = await fakeAgent();
  const m = baseMandate(human.address, agent.publicKeyHex);
  m.agent.tokenId = String(3000 + Math.floor(Math.random() * 1e6));
  m.adultProof = { statement: "age>=18", vraTx: "a".repeat(64), vaaTx: "b".repeat(64), recordSha256: "c".repeat(64), recordUrl: "https://example.org/record.json" };
  edit(m);
  const sm = await signMandate(m, human.signer);
  chain.adult = { ok: true };
  chain.down = false;
  chain.infos.set(human.address, human.info);
  chain.anchors.set(`${m.agent.tokenId}/${anchorKey(m.id)}`, anchorValue(m));
  chain.agents.set(m.agent.tokenId, { owner: human.address, status: "Active", wallet: null, externalKey: { namespace: m.agentKey.namespace, keyType: "ed25519", publicKeyHex: agent.publicKeyHex } });
  chain.keys.set(agent.publicKeyHex, { owner: human.address, status: "Active" });
  return { human, agent, m, sm };
}

const port = () => new URL(base).port;

async function call(w: World, opts: { path?: string; method?: string; body?: string; sm?: SignedMandate; key?: Uint8Array; now?: number; tamperBody?: string; headers?: Record<string, string> | null } = {}) {
  const path = opts.path ?? "/signup", method = opts.method ?? "POST", body = opts.body ?? (method === "GET" ? "" : '{"email":"agent@example.org"}');
  const headers = opts.headers === null ? {} : opts.headers ?? (await buildMandateHeaders(opts.sm ?? w.sm, { method, url: `http://${DOMAIN}:${port()}${path}`, body }, opts.key ?? w.agent.secretKey, opts.now ?? Date.now()));
  const r = await fetch(base + path, { method, headers: { ...headers, ...(method === "GET" ? {} : { "content-type": "application/json" }) }, ...(method === "GET" ? {} : { body: opts.tamperBody ?? body }) });
  return { status: r.status, body: (await r.json()) as { error?: RejectionCode; ok?: boolean; checks?: Array<{ name: string; ok: boolean | null; source?: string }> }, headers };
}

type Row = [label: string, expected: RejectionCode | "ok", status: number, run: () => Promise<{ status: number; body: { error?: string; ok?: boolean } }>];

const rows: Row[] = [
  ["happy path", "ok", 200, async () => call(await world())],
  ["missing_headers", "missing_headers", 401, async () => call(await world(), { headers: null })],
  ["bad_mandate (garbage header)", "bad_mandate", 401, async () => call(await world(), { headers: { mandate: "!!!", "mandate-signature": `t=${Date.now()}, n=${"ab".repeat(16)}, s=${"A".repeat(86)}` } })],
  ["wrong_network", "wrong_network", 403, async () => call(await world((m) => (m.network = CCD_MAINNET)))],
  ["bad_request_signature (wrong agent key)", "bad_request_signature", 401, async () => { const w = await world(); return call(w, { key: (await fakeAgent()).secretKey }); }],
  ["bad_request_signature (body altered in transit)", "bad_request_signature", 401, async () => call(await world(), { tamperBody: '{"email":"attacker@example.org"}' })],
  ["stale_request (clock skew 5 min)", "stale_request", 401, async () => call(await world(), { now: Date.now() - 5 * 60_000 })],
  ["replay (same signed request twice)", "replay", 401, async () => { const w = await world(); const first = await call(w); expect(first.status).toBe(200); const r = await fetch(base + "/signup", { method: "POST", headers: { ...first.headers, "content-type": "application/json" }, body: '{"email":"agent@example.org"}' }); return { status: r.status, body: await r.json() }; }],
  ["not_yet_valid", "not_yet_valid", 403, async () => call(await world((m) => { m.notBefore = Math.floor(Date.now() / 1000) + 600; m.expiry = m.notBefore + 3600; }))],
  ["expired", "expired", 403, async () => call(await world((m) => { m.notBefore = Math.floor(Date.now() / 1000) - 7200; m.expiry = Math.floor(Date.now() / 1000) - 60; }))],
  ["action_out_of_scope", "action_out_of_scope", 403, async () => call(await world(), { path: "/delete-account" })],
  ["domain_out_of_scope", "domain_out_of_scope", 403, async () => call(await world((m) => (m.scope.domains = ["other.localhost"])))],
  ["payment_not_allowed (no spend cap)", "payment_not_allowed", 403, async () => call(await world((m) => { delete m.scope.maxPerAction; delete m.scope.maxTotal; }), { path: "/report", method: "GET" })],
  ["over_cap_per_action", "over_cap_per_action", 403, async () => call(await world(), { path: "/report?p=60000", method: "GET" })],
  ["over_cap_total", "over_cap_total", 403, async () => { const w = await world(); await ledger.record(mandateHash(w.m), 100_000n); return call(w, { path: "/report", method: "GET" }); }],
  ["bad_human_signature (signed by another account)", "bad_human_signature", 403, async () => { const w = await world(); const other = await fakeHuman(); const sm = { ...(await signMandate(w.m, other.signer)) }; return call(w, { sm }); }],
  ["not_anchored", "not_anchored", 403, async () => { const w = await world(); chain.anchors.delete(`${w.m.agent.tokenId}/${anchorKey(w.m.id)}`); return call(w); }],
  ["revoked", "revoked", 403, async () => { const w = await world(); chain.anchors.set(`${w.m.agent.tokenId}/${anchorKey(w.m.id)}`, revokedAnchorValue(Math.floor(Date.now() / 1000))); return call(w); }],
  ["anchor_mismatch", "anchor_mismatch", 403, async () => { const w = await world(); chain.anchors.set(`${w.m.agent.tokenId}/${anchorKey(w.m.id)}`, `sha256:${"0".repeat(64)}|exp:${w.m.expiry}`); return call(w); }],
  ["agent_not_found", "agent_not_found", 403, async () => { const w = await world(); chain.agents.delete(w.m.agent.tokenId); return call(w); }],
  ["agent_revoked", "agent_revoked", 403, async () => { const w = await world(); chain.agents.get(w.m.agent.tokenId)!.status = "Revoked"; return call(w); }],
  ["agent_not_owned_by_issuer", "agent_not_owned_by_issuer", 403, async () => { const w = await world(); chain.agents.get(w.m.agent.tokenId)!.owner = (await fakeHuman()).address; return call(w); }],
  ["agent_key_mismatch", "agent_key_mismatch", 403, async () => { const w = await world(); chain.agents.get(w.m.agent.tokenId)!.externalKey = { namespace: "solana:testnet", keyType: "ed25519", publicKeyHex: "11".repeat(32) }; return call(w); }],
  ["key_not_bound", "key_not_bound", 403, async () => { const w = await world(); chain.keys.delete(w.agent.publicKeyHex); return call(w); }],
  ["adult_proof_missing", "adult_proof_missing", 403, async () => call(await world((m) => { delete m.adultProof; }))],
  ["adult_proof_invalid", "adult_proof_invalid", 403, async () => { const w = await world(); chain.adult = { ok: false, reason: "zero-knowledge presentation did not verify" }; return call(w); }],
  ["chain_unavailable (fails closed)", "chain_unavailable", 503, async () => { const w = await world(); chain.down = true; return call(w); }],
];

describe("verifier table: one row per rejection reason", () => {
  test.each(rows)("%s -> %s (%i)", async (_label, expected, status, run) => {
    const r = await run();
    expect(r.status).toBe(status);
    if (expected === "ok") expect(r.body.ok).toBe(true);
    else expect(r.body.error).toBe(expected);
  });

  test("every RejectionCode has a row", () => {
    const covered = new Set(rows.map((r) => r[1]));
    const all: RejectionCode[] = ["missing_headers", "bad_mandate", "wrong_network", "bad_request_signature", "stale_request", "replay", "not_yet_valid", "expired", "action_out_of_scope", "domain_out_of_scope", "payment_not_allowed", "over_cap_per_action", "over_cap_total", "bad_human_signature", "not_anchored", "revoked", "anchor_mismatch", "agent_not_found", "agent_revoked", "agent_not_owned_by_issuer", "agent_key_mismatch", "key_not_bound", "adult_proof_missing", "adult_proof_invalid", "chain_unavailable"];
    expect(all.filter((c) => !covered.has(c))).toEqual([]);
  });

  test("result lists all 15 checks with the answering source", async () => {
    const r = await call(await world());
    expect(r.body.checks?.map((c) => c.name)).toEqual(["headers", "mandate_format", "network", "request_signature", "freshness", "replay", "validity_window", "scope_action", "scope_domain", "spend_cap", "human_signature", "on_chain_anchor", "agent_registry", "key_binding", "adult_proof"]);
  });

  test("skew inside the window is accepted (59 s behind)", async () => {
    const r = await call(await world(), { now: Date.now() - 59_000 });
    expect(r.status).toBe(200);
  });

  test("a rejected request lists which checks failed and which were skipped", async () => {
    const w = await world((m) => (m.scope.domains = ["other.localhost"]));
    const r = await call(w);
    const byName = Object.fromEntries((r.body.checks ?? []).map((c) => [c.name, c.ok]));
    expect(byName.scope_domain).toBe(false);
    expect(byName.on_chain_anchor).toBeNull();
  });
});
