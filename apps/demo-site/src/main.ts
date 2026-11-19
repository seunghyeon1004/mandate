// Demo relying party "Larchfield Reports" (127.0.0.1). Instead of a CAPTCHA, routes accept an AI agent with a valid Concordium mandate.
//   GET  /                      the sign-up page and the live feed of agent requests (what this site decided and why)
//   POST /api/signup            action "signup"         free, mandate required
//   POST /api/comment           action "post_comment"   free, mandate required
//   POST /api/delete-account    action "delete_account" (outside the demo mandates: shows an out-of-scope rejection)
//   GET  /api/premium-report    action "buy_report"     0.05 CCD via x402; payer must be the agent's registered wallet
//   GET  /api/premium-bundle    action "buy_report"     0.08 CCD: above the demo mandates' per-action cap
//   GET  /api/activity          the feed: verification results, receipts (submitted/finalized), payments
import express, { type Request, type Response } from "express";
import { resolve } from "node:path";
import { CCD_TESTNET, type VerifyResult } from "@mandate/core";
import { MandateVerifier } from "@mandate/verifier";
import { accountKey, chainView, context, ccdexplorerTx, REPO_ROOT } from "@mandate/node";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";
import { Receipts, type Receipt } from "./receipts.ts";

const PORT = Number(process.env.SITE_PORT ?? 4021);
const ORIGIN = process.env.SITE_ORIGIN ?? `http://localhost:${PORT}`;
const FACILITATOR = process.env.FACILITATOR_URL ?? "http://127.0.0.1:4022";
const REVOCATION_BOUND_MS = Number(process.env.REVOCATION_BOUND_MS ?? 10_000);
const REPORT_PRICE = "50000"; // micro-CCD = 0.05 CCD
const BUNDLE_PRICE = "80000";
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

const ctx = await context();
const site = accountKey("site");
const view = chainView(ctx, { revocationBoundMs: REVOCATION_BOUND_MS, onFallback: (w, e) => log("MCP fallback to gRPC:", w, e) });
const receipts = new Receipts(ctx.client, site);

interface Activity {
  id: number;
  at: string;
  method: string;
  path: string;
  action: string;
  price?: string;
  result: Pick<VerifyResult, "ok" | "code" | "reason" | "checks" | "mandateHash">;
  mandateId?: string;
  tokenId?: string;
  issuer?: string;
  receipt?: Receipt;
  payment?: { tx: string; amount: string; payer: string };
  paymentRequested?: boolean;
}
const activity: Activity[] = [];
let seq = 0;

const verifier = new MandateVerifier({
  chain: view,
  policy: { network: CCD_TESTNET, registry: { index: String(ctx.registry.cis8004.address.index), subindex: "0" }, maxSkewMs: 60_000 },
  publicOrigin: ORIGIN,
  onResult: (r, req, action) => {
    const price = (req as Request & { price?: string }).price;
    const paidRetry = !!(req.get("payment-signature") ?? req.get("x-payment"));
    // An agent's first call to a paid route is answered with 402 and retried with a payment; show it once, as the paid attempt.
    if (price && r.ok && !paidRetry) { (req as Request & { activity?: Activity }).activity = undefined; return; }
    const a: Activity = {
      id: ++seq, at: new Date().toISOString(), method: req.method, path: req.path, action,
      ...(price ? { price } : {}),
      result: { ok: r.ok, ...(r.code ? { code: r.code } : {}), ...(r.reason ? { reason: r.reason } : {}), checks: r.checks, ...(r.mandateHash ? { mandateHash: r.mandateHash } : {}) },
      ...(r.mandate ? { mandateId: r.mandate.id, tokenId: r.mandate.agent.tokenId, issuer: r.mandate.issuer } : {}),
    };
    activity.unshift(a);
    activity.length = Math.min(activity.length, 60);
    (req as Request & { activity?: Activity }).activity = a;
    log(`${req.method} ${req.path} action=${action} ->`, r.ok ? "ACCEPT" : `REJECT ${r.code}: ${r.reason}`, r.checks.filter((c) => c.source && c.source !== "local").map((c) => `${c.name}:${c.source}`).join(" "));
  },
});

const x402 = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR })).register(CONCORDIUM_TESTNET_CAIP2, new ExactConcordiumScheme());
verifier.x402Hooks(x402, (s) => {
  const a = activity.find((x) => x.result.mandateHash === s.mandateHash && x.price && !x.payment);
  if (a) a.payment = { tx: s.transaction, amount: String(s.amount), payer: s.payer };
  log(`x402 settled ${s.amount} microCCD from ${s.payer} tx ${s.transaction}`);
});
const paid = paymentMiddleware(
  {
    "GET /api/premium-report": { accepts: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2, payTo: site.account, price: { amount: REPORT_PRICE, asset: "CCD" } }, description: "Premium market report", mimeType: "application/json" },
    "GET /api/premium-bundle": { accepts: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2, payTo: site.account, price: { amount: BUNDLE_PRICE, asset: "CCD" } }, description: "Premium bundle", mimeType: "application/json" },
  },
  x402,
);

const app = express();
app.disable("x-powered-by");
const raw = MandateVerifier.rawBody();
const priced = (amount: string) => (req: Request, _res: Response, next: express.NextFunction) => { (req as Request & { price?: string }).price = amount; next(); };

async function receipt(req: Request, res: Response, action: string): Promise<Receipt> {
  const m = res.locals.mandate!;
  const rc = await receipts.record({ mandateId: m.mandate!.id, mandateHash: m.mandateHash!, action, signatureHeader: req.get("mandate-signature") ?? "" });
  const a = (req as Request & { activity?: Activity }).activity;
  if (a) a.receipt = rc;
  return rc;
}
const bodyOf = (req: Request) => { try { return JSON.parse(((req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("{}")).toString() || "{}"); } catch { return {}; } };

app.use("/assets", express.static(resolve(REPO_ROOT, "site", "assets"), { maxAge: 0 }));
app.use("/", express.static(resolve(REPO_ROOT, "apps", "demo-site", "public"), { index: "index.html" }));

app.get("/health", (_q, r) => { r.json({ ok: true, origin: ORIGIN, payTo: site.account }); });

app.post("/api/signup", raw, verifier.require("signup"), async (req, res) => {
  const rc = await receipt(req, res, "signup");
  res.json({ ok: true, account: "created", email: String(bodyOf(req).email ?? "agent@example.org"), captcha: "skipped: verified mandate", receipt: { tx: rc.tx, status: rc.status, explorer: ccdexplorerTx(rc.tx) }, checks: res.locals.mandate!.checks });
});

app.post("/api/comment", raw, verifier.require("post_comment"), async (req, res) => {
  const rc = await receipt(req, res, "post_comment");
  res.json({ ok: true, comment: String(bodyOf(req).text ?? "").slice(0, 280), receipt: { tx: rc.tx, status: rc.status, explorer: ccdexplorerTx(rc.tx) }, checks: res.locals.mandate!.checks });
});

app.post("/api/delete-account", raw, verifier.require("delete_account"), (_req, res) => { res.json({ ok: true }); });

app.get("/api/premium-report", raw, priced(REPORT_PRICE), verifier.require("buy_report", { price: { amount: REPORT_PRICE, asset: "CCD" } }), paid, async (req, res) => {
  const rc = await receipt(req, res, "buy_report");
  res.json({ ok: true, report: { title: "Testnet market report", lines: ["Demo content unlocked by an x402 payment in CCD."] }, receipt: { tx: rc.tx, status: rc.status, explorer: ccdexplorerTx(rc.tx) }, mandate: res.locals.mandate!.mandate!.id });
});

app.get("/api/premium-bundle", raw, priced(BUNDLE_PRICE), verifier.require("buy_report", { price: { amount: BUNDLE_PRICE, asset: "CCD" } }), paid, (_req, res) => { res.json({ ok: true }); });

app.get("/api/activity", (_q, r) => {
  r.json({ origin: ORIGIN, payTo: site.account, revocationBoundMs: REVOCATION_BOUND_MS, prices: { report: REPORT_PRICE, bundle: BUNDLE_PRICE }, entries: activity });
});

app.listen(PORT, "127.0.0.1", () => log(`demo site on ${ORIGIN} (bound to 127.0.0.1:${PORT}), payTo ${site.account}, facilitator ${FACILITATOR}, revocation bound ${view.revocationBoundMs} ms`));
