// Issuer console web UI (127.0.0.1 only, TESTNET). The human's key is held by this local process for the demo; in production the
// Concordium wallet signs (signMessage for the mandate, sendTransaction for the sponsored anchor) and this server holds no keys.
//   GET  /                         console page
//   GET  /api/agent                agent record, key binding, badge check
//   GET  /api/mandates             issued mandates with their on-chain status
//   POST /api/mandates             issue (age proof, signature, anchor) as a job; poll GET /api/jobs/:id
//   POST /api/mandates/:id/revoke  revoke in one sponsored transaction (body must repeat the id)
//   GET  /api/log                  every transaction this console caused, with explorer links
import express, { type NextFunction, type Request, type Response } from "express";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { anchorKey, parseAnchor, type SignedMandate } from "@mandate/core";
import { grpcAgentOf, grpcGetMetadata } from "@mandate/chain";
import { context, ccdexplorerTx, REPO_ROOT, STATE_DIR, state } from "@mandate/node";
import { issueMandate, revokeMandate, sponsorClient, PAGES_BASE, type AgentState, type StepFn } from "./issuer.ts";

const PORT = Number(process.env.CONSOLE_PORT ?? 4020);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ACTIONS = ["signup", "post_comment", "buy_report", "delete_account"];
const TTL: Record<string, number> = { "1h": 3600, "1d": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

const ctx = await context();
const sponsor = sponsorClient();

const memo = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const e = memo.get(key);
  if (e && Date.now() - e.at < ttlMs) return e.v as T;
  const v = await fn();
  memo.set(key, { at: Date.now(), v });
  return v;
}

interface Job { id: string; steps: Array<{ step: string; tx?: string; note?: string; at: string }>; done: boolean; error?: string; mandateId?: string }
const jobs = new Map<string, Job>();
let busy = false;

function mandateIds(): string[] {
  return readdirSync(resolve(STATE_DIR, "mandates")).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f)).map((f) => f.slice(0, 36));
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
// Only this page may trigger transactions: refuse POSTs from any other origin (a malicious page cannot drive the local console).
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "POST" && req.get("origin") !== ORIGIN) { res.status(403).json({ error: "cross-origin request refused" }); return; }
  next();
});
app.use("/assets", express.static(resolve(REPO_ROOT, "site", "assets")));
app.use("/", express.static(resolve(REPO_ROOT, "apps", "console", "public")));

app.get("/api/agent", async (_q, r) => {
  const a = state<AgentState>("agent.json");
  if (!a) { r.json({ registered: false }); return; }
  try {
    const [rec, key, badge] = await Promise.all([
      cached(`agent:${a.tokenId}`, 10_000, () => grpcAgentOf(ctx.client, ctx.registry, a.tokenId)),
      cached(`key:${a.agentKeyPublicHex}`, 10_000, () => ctx.mcp.ownerOfKey({ namespace: "solana:testnet", keyType: "ed25519", publicKeyHex: a.agentKeyPublicHex }).catch(() => null)),
      cached(`badge:${a.badge}`, 60_000, () => ctx.mcp.checkBadge(a.badge).catch((e: Error) => ({ badge_valid: false, issues: [e.message], checks: {} }))),
    ]);
    const pin = state<{ tx: { hash: string } }>("card-pin.json");
    r.json({ registered: true, tokenId: a.tokenId, badge: a.badge, owner: a.owner, agentWallet: a.agentWallet, agentKey: a.agentKeyPublicHex, record: rec, keyBinding: key, badgeCheck: { valid: badge.badge_valid, issues: badge.issues, passed: Object.values(badge.checks ?? {}).filter((v) => v === true).length }, card: rec?.agentUri ?? null, cardPinTx: pin?.tx.hash ?? null, txs: Object.fromEntries(Object.entries(a.txs).map(([k, t]) => [k, t.hash])) });
  } catch (e) {
    r.status(503).json({ error: `chain unavailable: ${(e as Error).message.slice(0, 160)}` });
  }
});

app.get("/api/mandates", async (_q, r) => {
  const a = state<AgentState>("agent.json");
  try {
    const list = await Promise.all(mandateIds().map(async (id) => {
      const sm = state<SignedMandate>(`mandates/${id}.json`)!;
      const m = sm.mandate;
      const onChain = await cached(`anchor:${id}`, 10_000, () => grpcGetMetadata(ctx.client, ctx.registry, m.agent.tokenId, anchorKey(id)));
      const p = parseAnchor(onChain);
      const now = Date.now() / 1000;
      const status = p.kind === "revoked" ? "revoked" : p.kind !== "active" ? "missing" : now >= m.expiry ? "expired" : "active";
      return { id, scope: m.scope, notBefore: m.notBefore, expiry: m.expiry, status, txs: state(`mandates/${id}.txs.json`), revoked: state(`mandates/${id}.revoked.json`), agent: m.agent.tokenId, current: a ? m.agent.tokenId === a.tokenId : false };
    }));
    list.sort((x, y) => y.notBefore - x.notBefore);
    r.json({ mandates: list, verifyPage: `${PAGES_BASE}/verify/` });
  } catch (e) {
    r.status(503).json({ error: `chain unavailable: ${(e as Error).message.slice(0, 160)}` });
  }
});

app.post("/api/mandates", (req, res) => {
  const b = req.body as { actions?: unknown; domains?: unknown; ttl?: unknown; maxPerAction?: unknown; maxTotal?: unknown };
  const errors: Record<string, string> = {};
  const actions = Array.isArray(b.actions) ? b.actions.filter((x): x is string => typeof x === "string" && ACTIONS.includes(x)) : [];
  if (!actions.length) errors.actions = "Pick at least one action.";
  const domains = String(b.domains ?? "").split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!domains.length || !domains.every((d) => /^[a-z0-9.-]{1,253}$/.test(d))) errors.domains = "Enter one or more host names, e.g. localhost.";
  const ttl = TTL[String(b.ttl)];
  if (!ttl) errors.ttl = "Pick how long the mandate lasts.";
  const toMicro = (v: unknown) => { const s = String(v ?? "").trim(); if (!s) return undefined; if (!/^\d+(\.\d{1,6})?$/.test(s)) return null; return String(Math.round(Number(s) * 1e6)); };
  const per = toMicro(b.maxPerAction), total = toMicro(b.maxTotal);
  if (per === null) errors.maxPerAction = "Use a CCD amount like 0.05.";
  if (total === null) errors.maxTotal = "Use a CCD amount like 0.12.";
  if (actions.includes("buy_report") && !per) errors.maxPerAction = "Paid actions need a per-action cap.";
  if (per && total && BigInt(total) < BigInt(per)) errors.maxTotal = "The total cap must be at least the per-action cap.";
  if (Object.keys(errors).length) { res.status(422).json({ errors }); return; }
  if (busy) { res.status(409).json({ error: "An issuance is already running. Wait for it to finish." }); return; }
  const agent = state<AgentState>("agent.json");
  if (!agent) { res.status(409).json({ error: "Register the agent first (npm run mandate -- register)." }); return; }
  const job: Job = { id: crypto.randomUUID(), steps: [], done: false };
  jobs.set(job.id, job);
  busy = true;
  const onStep: StepFn = (step, d) => job.steps.push({ step, ...(d?.tx ? { tx: d.tx } : {}), ...(d?.note ? { note: d.note } : {}), at: new Date().toISOString() });
  issueMandate(ctx, sponsor, agent, { actions, domains, ttlSeconds: ttl!, ...(per ? { maxPerAction: per } : {}), ...(total ? { maxTotal: total } : {}) }, (s) => log(s), onStep)
    .then((r) => { job.mandateId = r.signed.mandate.id; log("issued", r.signed.mandate.id); })
    .catch((e: Error) => { job.error = e.message.slice(0, 300); log("issue failed", e.message); })
    .finally(() => { job.done = true; busy = false; });
  res.status(202).json({ job: job.id });
});

app.get("/api/jobs/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) { res.status(404).json({ error: "unknown job" }); return; }
  res.json({ ...j, links: Object.fromEntries(j.steps.filter((s) => s.tx).map((s) => [s.step, ccdexplorerTx(s.tx!)])) });
});

app.post("/api/mandates/:id/revoke", async (req, res) => {
  const id = req.params.id;
  if ((req.body as { confirm?: string })?.confirm !== id) { res.status(400).json({ error: "confirmation does not match the mandate id" }); return; }
  const sm = state<SignedMandate>(`mandates/${id}.json`);
  if (!sm) { res.status(404).json({ error: "unknown mandate" }); return; }
  try {
    const t = await revokeMandate(ctx, sponsor, sm.mandate);
    memo.delete(`anchor:${id}`);
    log("revoked", id, t.hash);
    res.json({ tx: t.hash, explorer: ccdexplorerTx(t.hash), feePayer: t.feePayer });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message.slice(0, 300) });
  }
});

app.get("/api/log", (_q, r) => {
  const a = state<AgentState>("agent.json");
  const rows: Array<{ what: string; tx: string; group: string }> = [];
  if (a) {
    if (a.txs.keyBinding) rows.push({ group: "Agent", what: "CIS-8 key binding: agent key bound to your account", tx: a.txs.keyBinding.hash });
    if (a.txs.register) rows.push({ group: "Agent", what: `CIS-8004 register: agent token ${a.tokenId}`, tx: a.txs.register.hash });
    if (a.txs.agentWallet) rows.push({ group: "Agent", what: "setAgentWallet: the agent pays from its own wallet", tx: a.txs.agentWallet.hash });
  }
  const pin = state<{ tx: { hash: string } }>("card-pin.json");
  if (pin) rows.push({ group: "Agent", what: "setAgentURI: agent card and its SHA-256 pinned (badge)", tx: pin.tx.hash });
  const ms = mandateIds().map((id) => ({ id, sm: state<SignedMandate>(`mandates/${id}.json`)! })).sort((x, y) => x.sm.mandate.notBefore - y.sm.mandate.notBefore);
  for (const { id } of ms) {
    const t = state<{ vra: string; vaa: string; anchor: string }>(`mandates/${id}.txs.json`);
    const rv = state<{ tx: string }>(`mandates/${id}.revoked.json`);
    const g = `Mandate ${id.slice(0, 8)}`;
    if (t) {
      rows.push({ group: g, what: "Age proof requested (VRA)", tx: t.vra });
      rows.push({ group: g, what: "Age proof verified, audit anchored (VAA)", tx: t.vaa });
      rows.push({ group: g, what: "Mandate hash anchored", tx: t.anchor });
    }
    if (rv) rows.push({ group: g, what: "Revoked", tx: rv.tx });
  }
  r.json({ rows: rows.map((x) => ({ ...x, explorer: ccdexplorerTx(x.tx) })) });
});

app.listen(PORT, "127.0.0.1", () => log(`console on ${ORIGIN}`));
