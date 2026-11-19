// End-to-end on Concordium TESTNET (on demand: `npm run test:integration`). Spends test CCD from the operator account.
// issue (VRA, VAA, anchor) -> free action (receipt) -> x402 payment -> out-of-scope / over-cap / replay / wrong-key rejections ->
// MCP outage fallback -> revoke (one tx) -> rejected retry. Writes docs/EVIDENCE.md and a JSON log under ../.state/evidence/.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { AccountAddress } from "@concordium/web-sdk";
import { CCD_TESTNET, buildMandateHeaders, verifyMandateRequest, type SignedMandate } from "@mandate/core";
import { ConcordiumChainView, McpClient, defaultRecordFetcher, txOutcome, type TxOutcome } from "@mandate/chain";
import { accountKey, agentKey, context, readAccounts, REPO_ROOT, STATE_DIR, ccdexplorerTx, ccdexplorerAccount, explorerTx, state, type Ctx } from "@mandate/node";
import { MemoryReplayGuard } from "@mandate/verifier";
import { MandateAgent, type CallResult } from "../../apps/agent/src/agent.ts";
import { issueMandate, registerAgent, revokeMandate, sponsorClient, type AgentState } from "../../apps/console/src/issuer.ts";

const SITE = "http://localhost:4021";
const OPERATOR = "http://127.0.0.1:4022";
const children: ChildProcess[] = [];
const steps: Array<{ step: string; result: string; tx?: string; feePayer?: string; detail?: string }> = [];
let ctx: Ctx;
let agentState: AgentState;
let signed: SignedMandate;
let agent: MandateAgent;
let issuedTxs: { vra: string; vaa: string; anchor: TxOutcome };
const startedAt = new Date().toISOString();

async function healthy(url: string): Promise<boolean> {
  try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

async function ensure(url: string, script: string) {
  if (await healthy(url)) return;
  const c = spawn(process.execPath, [resolve(REPO_ROOT, script)], { stdio: ["ignore", "inherit", "inherit"] });
  children.push(c);
  for (let i = 0; i < 60 && !(await healthy(url)); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!(await healthy(url))) throw new Error(`${script} did not start`);
}

function body(r: CallResult) {
  return r.body as { ok?: boolean; error?: string; reason?: string; receipt?: { tx: string } };
}

beforeAll(async () => {
  await ensure(OPERATOR, "apps/facilitator/src/main.ts");
  await ensure(SITE, "apps/demo-site/src/main.ts");
  ctx = await context();
  agentState = await registerAgent(ctx, sponsorClient(), () => {});
}, 600_000);

afterAll(() => {
  for (const c of children) c.kill();
});

describe("Mandate end to end on Concordium testnet", () => {
  test("Verified by Concordium badge: agent card pinned on chain, hosted check_badge passes", async () => {
    const b = await ctx.mcp.checkBadge(agentState.badge);
    const passed = Object.values(b.checks).filter((v) => v === true).length;
    steps.push({ step: `Hosted check_badge for ${agentState.badge} (agent token ${agentState.tokenId})`, result: b.badge_valid ? "badge_valid true" : "badge_valid FALSE", detail: `issues ${JSON.stringify(b.issues)}; ${passed} boolean checks true, incl. hash_matches_on_chain=${String(b.checks.hash_matches_on_chain)}` });
    expect(b.badge_valid).toBe(true);
    expect(b.issues).toEqual([]);
  }, 60_000);

  test("issue: account-bound age proof (VRA, VAA) and sponsored anchor", async () => {
    const r = await issueMandate(ctx, sponsorClient(), agentState, { actions: ["signup", "post_comment", "buy_report"], domains: ["localhost"], ttlSeconds: 3600, maxPerAction: "50000", maxTotal: "120000" }, () => {});
    signed = r.signed;
    issuedTxs = r.txs;
    const k = await agentKey();
    agent = new MandateAgent({ mandate: signed, agentSecretKey: k.secretKey, wallet: accountKey("agentWallet") });
    steps.push({ step: "Verify & Access request anchor (VRA), age >= 18, account-bound", result: "anchored", tx: r.txs.vra, detail: "registerData by the verifier (operator) account" });
    steps.push({ step: "Verify & Access audit anchor (VAA) after ZK verification", result: "anchored", tx: r.txs.vaa, detail: "date of birth not in the record" });
    steps.push({ step: `Mandate anchor setMetadata mandate:${signed.mandate.id}`, result: r.txs.anchor.ok ? "success" : "FAILED", tx: r.txs.anchor.hash, feePayer: r.txs.anchor.feePayer, detail: `sponsored=${r.txs.anchor.sponsored}` });
    expect(r.txs.anchor.ok).toBe(true);
    expect(r.txs.anchor.sponsored).toBe(true);
  }, 600_000);

  let signupHeaders: Record<string, string> = {};
  test("free action accepted instead of a CAPTCHA, receipt written on chain", async () => {
    const r = await agent.callWithMandate(`${SITE}/api/signup`, { json: { email: "agent@example.org" } });
    signupHeaders = r.sentHeaders;
    expect(r.status).toBe(200);
    const tx = body(r).receipt!.tx;
    const o = await txOutcome(ctx.client, tx);
    steps.push({ step: "Agent signup with mandate (no CAPTCHA) -> receipt registerData", result: `HTTP ${r.status}, receipt ${o.ok ? "finalized" : "FAILED"}`, tx, feePayer: o.feePayer });
    expect(o.ok).toBe(true);
  }, 300_000);

  test("replay of the exact signed request is rejected", async () => {
    const r = await fetch(`${SITE}/api/signup`, { method: "POST", headers: signupHeaders, body: JSON.stringify({ email: "agent@example.org" }) });
    const b = (await r.json()) as { error: string };
    steps.push({ step: "Replay of the same signed signup request", result: `HTTP ${r.status} ${b.error}` });
    expect(b.error).toBe("replay");
  });

  test("paid action via x402 in CCD, paid from the registered agent wallet", async () => {
    const r = await agent.callWithMandate(`${SITE}/api/premium-report`);
    expect(r.status).toBe(200);
    expect(r.payment?.success).toBe(true);
    expect(r.payment?.payer).toBe(agentState.agentWallet);
    const pay = await txOutcome(ctx.client, r.payment!.transaction!);
    steps.push({ step: "x402 payment 0.05 CCD (V1 sponsored transfer, facilitator pays fee)", result: `HTTP ${r.status}, payer = agent wallet`, tx: pay.hash, feePayer: pay.feePayer, detail: `sponsored=${pay.sponsored}` });
    const rc = await txOutcome(ctx.client, body(r).receipt!.tx);
    steps.push({ step: "Receipt for the paid action", result: rc.ok ? "finalized" : "FAILED", tx: rc.hash, feePayer: rc.feePayer });
  }, 300_000);

  test("out-of-scope action and over-cap payment are rejected before any payment", async () => {
    const del = await agent.callWithMandate(`${SITE}/api/delete-account`, { json: {} });
    steps.push({ step: "Out-of-scope action (delete_account)", result: `HTTP ${del.status} ${body(del).error}` });
    expect(body(del).error).toBe("action_out_of_scope");
    const bundle = await agent.callWithMandate(`${SITE}/api/premium-bundle`);
    steps.push({ step: "Paid action above the per-action cap (0.08 > 0.05 CCD)", result: `HTTP ${bundle.status} ${body(bundle).error}`, detail: "no 402 shown, nothing paid" });
    expect(body(bundle).error).toBe("over_cap_per_action");
    expect(bundle.payment).toBeNull();
  }, 120_000);

  test("wrong agent key is rejected", async () => {
    const other = new MandateAgent({ mandate: signed, agentSecretKey: crypto.getRandomValues(new Uint8Array(32)) });
    const r = await other.callWithMandate(`${SITE}/api/signup`, { json: { email: "x@example.org" } });
    steps.push({ step: "Request signed by a key that is not the bound agent key", result: `HTTP ${r.status} ${body(r).error}` });
    expect(body(r).error).toBe("bad_request_signature");
  });

  test("hosted MCP outage does not break verification (gRPC answers)", async () => {
    const policy = { network: CCD_TESTNET, registry: { index: "12802", subindex: "0" } };
    const k = await agentKey();
    const run = async (mcp: McpClient) => {
      const view = new ConcordiumChainView({ client: ctx.client, registry: ctx.registry, mcp, fetchRecord: defaultRecordFetcher({ allowHttpLocalhost: true }), onFallback: () => {} });
      const url = `${SITE}/api/comment`;
      const h = await buildMandateHeaders(signed, { method: "POST", url, body: "{}" }, k.secretKey);
      const res = await verifyMandateRequest({ method: "POST", url, body: "{}", headers: { mandate: h.mandate!, signature: h["mandate-signature"]! }, action: "post_comment" }, policy, { chain: view, replay: new MemoryReplayGuard() });
      return { res, stats: view.stats };
    };
    const up = await run(new McpClient("https://agent-registry-mcp.concordium.com", "testnet", 6000));
    const down = await run(new McpClient("https://127.0.0.1:9", "testnet", 1500));
    const src = (r: typeof up) => r.res.checks.filter((c) => c.source && c.source !== "local").map((c) => `${c.name}=${c.source}`).join(", ");
    steps.push({ step: "Verification with hosted MCP reachable", result: up.res.ok ? "accepted" : `rejected ${up.res.code}`, detail: src(up) });
    steps.push({ step: "Verification with MCP unreachable (fallback)", result: down.res.ok ? "accepted" : `rejected ${down.res.code}`, detail: `${src(down)}; fallbacks=${down.stats.fallbacks}` });
    expect(up.res.ok).toBe(true);
    expect(down.res.ok).toBe(true);
    expect(down.res.checks.find((c) => c.name === "on_chain_anchor")?.source).toBe("grpc");
    expect(up.res.checks.find((c) => c.name === "on_chain_anchor")?.source).toBe("mcp");
  }, 300_000);

  test("revoke in one transaction; the site rejects the next request within its revocation bound", async () => {
    const rv = await revokeMandate(ctx, sponsorClient(), signed.mandate);
    const finalizedAt = Date.now();
    steps.push({ step: "Human revokes the mandate (one setMetadata, sponsored)", result: rv.ok ? "success" : "FAILED", tx: rv.hash, feePayer: rv.feePayer, detail: `sponsored=${rv.sponsored}` });
    let last: CallResult | null = null;
    for (let i = 0; i < 12; i++) {
      last = await agent.callWithMandate(`${SITE}/api/signup`, { json: { email: "agent@example.org" } });
      if (body(last).error === "revoked") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const seconds = ((Date.now() - finalizedAt) / 1000).toFixed(1);
    steps.push({ step: "Agent retries after revocation", result: `HTTP ${last!.status} ${body(last!).error}`, detail: `seen ${seconds} s after finalization (site bound: 10 s cache)` });
    expect(body(last!).error).toBe("revoked");
    expect(Number(seconds)).toBeLessThanOrEqual(15);
  }, 300_000);

  afterAll(async () => {
    const acc = readAccounts();
    const bal = async (a: string) => String((await ctx.client.getAccountInfo(AccountAddress.fromBase58(a))).accountAmount.microCcdAmount);
    const balances = { human: await bal(acc.human.address), agentWallet: await bal(acc.agentWallet.address), sponsor: await bal(acc.sponsor.address), site: await bal(acc.site.address) };
    const fmt = (m: string) => (Number(m) / 1e6).toFixed(6);
    const link = (h?: string) => (h ? `[${h.slice(0, 10)}…](${ccdexplorerTx(h)}) ([CCDScan](${explorerTx(h)}))` : "");
    const reg = agentState.txs;
    const cardPin = state<{ tx: { hash: string; feePayer?: string }; servedSha: string }>("card-pin.json");
    const md = `# Evidence: full run on Concordium testnet

Generated by \`npm run test:integration\` (tests/integration/e2e.test.ts), run started ${startedAt}. Every row below was produced by that run, except the one-time agent registration, which was done earlier with \`mandate register\` (same code) and is reused.

Network: Concordium testnet (\`${CCD_TESTNET}\`). Agent Registry CIS-8004 \`<12802,0>\`, CIS-8 \`<12801,0>\` (schemas loaded at runtime from the deployed modules).

Testnet identities come from the self-service testnet identity provider with invented attributes ("Test Human", DOB 1990-01-01). "Verified adult" proves the mechanism, not a real person.

## Accounts

| Role | Account | Balance after run (CCD) |
| --- | --- | --- |
| Human (issuer, agent NFT owner; never pays fees) | [${acc.human.address}](${ccdexplorerAccount(acc.human.address)}) | ${fmt(balances.human)} |
| Agent wallet (pays x402) | [${acc.agentWallet.address}](${ccdexplorerAccount(acc.agentWallet.address)}) | ${fmt(balances.agentWallet)} |
| Operator (fee sponsor, x402 facilitator, Verify & Access verifier) | [${acc.sponsor.address}](${ccdexplorerAccount(acc.sponsor.address)}) | ${fmt(balances.sponsor)} |
| Demo site (payee, writes receipts) | [${acc.site.address}](${ccdexplorerAccount(acc.site.address)}) | ${fmt(balances.site)} |

## Agent (one-time registration)

| What | Tx | Fee payer |
| --- | --- | --- |
| CIS-8 \`registerExternalKey\`: agent ed25519 key bound to the human (scheme solana-ed25519) | ${link(reg.keyBinding?.hash)} | ${reg.keyBinding?.feePayer ?? ""} |
| CIS-8004 \`register\`: agent token ${agentState.tokenId}, external_reference = that CIS-8 key | ${link(reg.register?.hash)} | ${reg.register?.feePayer ?? ""} |
| CIS-8004 \`setAgentWallet\`: payments routed to the agent wallet | ${link(reg.agentWallet?.hash)} | ${reg.agentWallet?.feePayer ?? ""} |
| CIS-8004 \`setAgentURI\`: Agent Card on GitHub Pages and its SHA-256 pinned (Verified by Concordium badge) | ${link(cardPin?.tx.hash)} | ${cardPin?.tx.feePayer ?? ""} |

Badge (token address): \`${agentState.badge}\`. Agent Card: ${cardPin ? `https://seunghyeon1004.github.io/mandate/agents/${agentState.tokenId}/agent-card.json (SHA-256 \`${cardPin.servedSha}\`)` : "not pinned"}. Agent key: \`${agentState.agentKeyPublicHex}\`. MCP \`build_cis8_register\` output was byte-identical to our own serialization: ${String((agentState.crossCheck?.cis8Register as { identicalParameterBytes?: boolean } | undefined)?.identicalParameterBytes)}.

## This run

Mandate \`${signed?.mandate.id}\`, scope ${JSON.stringify(signed?.mandate.scope)}.

| # | Step | Result | Tx | Fee payer / detail |
| --- | --- | --- | --- | --- |
${steps.map((s, i) => `| ${i + 1} | ${s.step} | ${s.result} | ${link(s.tx)} | ${[s.feePayer, s.detail].filter(Boolean).join("; ")} |`).join("\n")}

Notes:
- Spending caps are enforced off chain by the verifier (per relying party); the on-chain receipts and payment are evidence after the fact. Protocol-Level Locks are not live and are not used.
- Receipts are \`registerData\` transactions from the site account: \`MR1|<mandate sha256>|<action>|<request-signature digest>|<unix time>\`.
`;
    writeFileSync(resolve(REPO_ROOT, "docs", "EVIDENCE.md"), md);
    mkdirSync(resolve(STATE_DIR, "evidence"), { recursive: true });
    writeFileSync(resolve(STATE_DIR, "evidence", `run-${startedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify({ startedAt, mandate: signed, issuedTxs, steps, balances, agent: agentState }, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2));
  }, 120_000);
});
