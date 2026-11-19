// Demo relying party (127.0.0.1). Instead of a CAPTCHA, routes accept an AI agent that carries a valid Concordium mandate.
//   POST /api/signup            action "signup"        free, mandate required
//   POST /api/comment           action "post_comment"  free, mandate required
//   POST /api/delete-account    action "delete_account" (never granted in the demo: shows out-of-scope rejection)
//   GET  /api/premium-report    action "buy_report"    0.05 CCD via x402, payer must be the agent's registered wallet
//   GET  /api/premium-bundle    action "buy_report"    0.08 CCD: above the demo mandate's per-action cap
//   GET  /api/receipts          on-chain receipts written by this site
import express, { type Request } from "express";
import { CCD_TESTNET } from "@mandate/core";
import { MandateVerifier } from "@mandate/verifier";
import { accountKey, chainView, context, ccdexplorerTx } from "@mandate/node";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";
import { Receipts } from "./receipts.ts";

const PORT = Number(process.env.SITE_PORT ?? 4021);
const ORIGIN = process.env.SITE_ORIGIN ?? `http://localhost:${PORT}`;
const FACILITATOR = process.env.FACILITATOR_URL ?? "http://127.0.0.1:4022";
const REPORT_PRICE = "50000"; // micro-CCD = 0.05 CCD
const BUNDLE_PRICE = "80000";
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

const ctx = await context();
const site = accountKey("site");
const view = chainView(ctx, { revocationBoundMs: Number(process.env.REVOCATION_BOUND_MS ?? 10_000), onFallback: (w, e) => log("MCP fallback to gRPC:", w, e) });
const receipts = new Receipts(ctx.client, site);

const verifier = new MandateVerifier({
  chain: view,
  policy: { network: CCD_TESTNET, registry: { index: String(ctx.registry.cis8004.address.index), subindex: "0" }, maxSkewMs: 60_000 },
  publicOrigin: ORIGIN,
  onResult: (r, req, action) => log(`${req.method} ${req.path} action=${action} ->`, r.ok ? "ACCEPT" : `REJECT ${r.code}: ${r.reason}`, r.checks.filter((c) => c.source && c.source !== "local").map((c) => `${c.name}:${c.source}`).join(" ")),
});

const x402 = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR })).register(CONCORDIUM_TESTNET_CAIP2, new ExactConcordiumScheme());
const settled = new Map<string, string>(); // mandateHash -> last payment tx
verifier.x402Hooks(x402, (s) => { settled.set(s.mandateHash, s.transaction); log(`x402 settled ${s.amount} microCCD from ${s.payer} tx ${s.transaction}`); });
const paid = paymentMiddleware(
  {
    "GET /api/premium-report": { accepts: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2, payTo: site.account, price: { amount: REPORT_PRICE, asset: "CCD" } }, description: "Premium market report", mimeType: "application/json" },
    "GET /api/premium-bundle": { accepts: { scheme: "exact", network: CONCORDIUM_TESTNET_CAIP2, payTo: site.account, price: { amount: BUNDLE_PRICE, asset: "CCD" } }, description: "Premium bundle", mimeType: "application/json" },
  },
  x402,
);

const app = express();
const raw = MandateVerifier.rawBody();
const accounts: Array<{ email: string; at: string; mandateId: string }> = [];
const comments: Array<{ text: string; at: string; mandateId: string }> = [];

async function receipt(req: Request, res: express.Response, action: string, payment?: string) {
  const m = res.locals.mandate!;
  return receipts.record({ mandateId: m.mandate!.id, mandateHash: m.mandateHash!, action, signatureHeader: req.get("mandate-signature") ?? "", ...(payment ? { payment } : {}) });
}

app.get("/health", (_q, r) => { r.json({ ok: true, origin: ORIGIN, payTo: site.account }); });

app.post("/api/signup", raw, verifier.require("signup"), async (req, res) => {
  const body = JSON.parse(((req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("{}")).toString() || "{}");
  const m = res.locals.mandate!;
  accounts.push({ email: String(body.email ?? "agent@example.org"), at: new Date().toISOString(), mandateId: m.mandate!.id });
  const rc = await receipt(req, res, "signup");
  res.json({ ok: true, account: "created", captcha: "skipped: verified mandate", receipt: { tx: rc.tx, text: rc.text, explorer: ccdexplorerTx(rc.tx) }, checks: m.checks });
});

app.post("/api/comment", raw, verifier.require("post_comment"), async (req, res) => {
  const body = JSON.parse(((req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("{}")).toString() || "{}");
  comments.push({ text: String(body.text ?? "").slice(0, 280), at: new Date().toISOString(), mandateId: res.locals.mandate!.mandate!.id });
  const rc = await receipt(req, res, "post_comment");
  res.json({ ok: true, receipt: { tx: rc.tx, explorer: ccdexplorerTx(rc.tx) }, checks: res.locals.mandate!.checks });
});

app.post("/api/delete-account", raw, verifier.require("delete_account"), (_req, res) => { res.json({ ok: true }); });

app.get("/api/premium-report", raw, verifier.require("buy_report", { price: { amount: REPORT_PRICE, asset: "CCD" } }), paid, async (req, res) => {
  const m = res.locals.mandate!;
  // x402 settles after the handler; the payment tx is reported in the PAYMENT-RESPONSE header. The receipt names the mandate and action.
  const rc = await receipt(req, res, "buy_report");
  res.json({ ok: true, report: { title: "Testnet market report", lines: ["Demo content unlocked by an x402 payment in CCD."] }, receipt: { tx: rc.tx, explorer: ccdexplorerTx(rc.tx) }, mandate: m.mandate!.id });
});

app.get("/api/premium-bundle", raw, verifier.require("buy_report", { price: { amount: BUNDLE_PRICE, asset: "CCD" } }), paid, (_req, res) => { res.json({ ok: true }); });

app.get("/api/receipts", (_q, r) => { r.json({ receipts: receipts.list.map((x) => ({ ...x, explorer: ccdexplorerTx(x.tx) })), settled: Object.fromEntries(settled) }); });

app.listen(PORT, "127.0.0.1", () => log(`demo site on ${ORIGIN} (bound to 127.0.0.1:${PORT}), payTo ${site.account}, facilitator ${FACILITATOR}, revocation bound ${view.revocationBoundMs} ms`));
