// Mandate operator service (127.0.0.1 only). TESTNET.
//   POST /sponsor/contract-update   V1 sponsored transaction for an allow-listed Agent Registry call (dry-run first)
//   GET  /supported, POST /verify, POST /settle   x402 facilitator for ccd:* (no public facilitator supports Concordium)
//   GET  /proofs/<sha256>.json      audit records (ZK age proofs, no personal data) referenced by mandates
//   GET  /health
import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { AccountAddress, ContractAddress, Energy, Parameter, ReceiveName } from "@concordium/web-sdk";
import { buildSponsoredContractUpdate, type SponsorRequest } from "@mandate/chain";
import { accountKey, context, rawAccountSecret, readAccounts, STATE_DIR } from "@mandate/node";
import { toHex } from "@mandate/core";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactConcordiumScheme } from "@x402/concordium/exact/facilitator";
import { CONCORDIUM_TESTNET_CAIP2, getConcordiumGrpcUrl, parseGrpcUrl, toConcordiumFacilitatorSigner } from "@x402/concordium";
import { checkPolicy, defaultPolicy, RateLimiter } from "./policy.ts";

const PORT = Number(process.env.FACILITATOR_PORT ?? 4022);
const ctx = await context();
const sponsor = accountKey("sponsor");
const accounts = readAccounts();
const policy = defaultPolicy((process.env.SPONSOR_ALLOWED_SENDERS ?? accounts.human.address).split(",").filter(Boolean));
const limiter = new RateLimiter(policy.rateLimit.count, policy.rateLimit.windowMs);
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(CONCORDIUM_TESTNET_CAIP2));
const facilitator = new x402Facilitator().register(
  CONCORDIUM_TESTNET_CAIP2,
  new ExactConcordiumScheme({ signer: toConcordiumFacilitatorSigner(sponsor.account, toHex(rawAccountSecret("sponsor")), { host, port, useTls: true }) }),
);

const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_q, r) => { r.json({ ok: true, sponsor: sponsor.account, network: CONCORDIUM_TESTNET_CAIP2 }); });

app.post("/sponsor/contract-update", async (q, r) => {
  const req = q.body as SponsorRequest;
  const refusal = checkPolicy(policy, req);
  if (refusal) { log("sponsor refused", req?.receiveName, refusal); r.status(403).json({ error: refusal }); return; }
  if (!limiter.allow(req.sender)) { r.status(429).json({ error: "rate limit" }); return; }
  try {
    const dry = await ctx.client.invokeContract({ invoker: AccountAddress.fromBase58(req.sender), contract: ContractAddress.create(BigInt(req.contract.index), BigInt(req.contract.subindex)), method: ReceiveName.fromString(req.receiveName), parameter: Parameter.fromHexString(req.parameterHex), energy: Energy.create(BigInt(req.energy)) });
    if (dry.tag !== "success") { r.status(422).json({ error: "dry-run rejected; not sponsoring a failing transaction" }); return; }
    const transaction = await buildSponsoredContractUpdate(ctx.client, sponsor, req);
    log("sponsored", req.receiveName, "for", req.sender);
    r.json({ transaction });
  } catch (e) {
    r.status(500).json({ error: String((e as Error).message).slice(0, 200) });
  }
});

app.get("/supported", async (_q, r) => { r.json(await facilitator.getSupported()); });
app.post("/verify", async (q, r) => {
  const out = await facilitator.verify(q.body.paymentPayload, q.body.paymentRequirements);
  log("x402 verify", out.isValid ? "valid" : `invalid ${out.invalidReason}`, out.payer ?? "");
  r.json(out);
});
app.post("/settle", async (q, r) => {
  const out = await facilitator.settle(q.body.paymentPayload, q.body.paymentRequirements);
  log("x402 settle", out.success ? "success" : `failed ${out.errorReason}`, out.transaction ?? "");
  r.json(out);
});

app.get("/proofs/:file", (q, r) => {
  const f = q.params.file;
  if (!/^[0-9a-f]{64}\.json$/.test(f)) { r.status(400).end(); return; }
  const p = resolve(STATE_DIR, "proofs", f);
  if (!existsSync(p)) { r.status(404).end(); return; }
  r.type("application/json").send(readFileSync(p, "utf8"));
});

app.listen(PORT, "127.0.0.1", () => log(`operator service on http://127.0.0.1:${PORT} (sponsor ${sponsor.account}, sponsoring senders: ${policy.allowedSenders.join(",") || "any"})`));
