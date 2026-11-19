// Issuer-side operations for Mandate on Concordium TESTNET, shared by the CLI and the integration test.
// Roles: the human (account owner, signs mandates and owns the agent NFT, pays no fees), the operator (sponsors fees and acts as the
// Verify & Access verifier that anchors VRA/VAA), the agent (holds only its ed25519 request key; pays x402 from its agent wallet).
import {
  AccountAddress, CredentialRegistrationId, IdentityProviderDID, VerifiablePresentationV1, VerificationAuditRecordV1, VerificationRequestV1,
  AttributesKeys, ConcordiumHdWallet,
} from "@concordium/web-sdk";
import * as ed from "@noble/ed25519";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CCD_TESTNET, anchorKey, anchorValue, canonicalJson, fromHex, mandateHash, randomNonce, revokedAnchorValue, sha256Hex, signMandate, toHex,
  type Mandate, type MandateScope, type SignedMandate,
} from "@mandate/core";
import {
  TESTNET, bytesToHex, grpcAgentOf, grpcGetMetadata, hexToBytes, httpSponsor, invoke, option, sendContractUpdate, serializeParams, tokenIdHex,
  type SponsorClient, type TxOutcome,
} from "@mandate/chain";
import { accountKey, agentKey, rawAccountSecret, readAccounts, saveState, SECRETS_DIR, state, type Ctx } from "@mandate/node";

export const AGENT_NAMESPACE = "solana:testnet";
export const AGENT_SCHEME = "solana-ed25519" as const;

export interface AgentState {
  tokenId: string;
  badge: string;
  agentKeyPublicHex: string;
  agentWallet: string;
  owner: string;
  txs: Record<string, TxOutcome>;
  crossCheck?: Record<string, unknown>;
}

export interface IssuedMandate {
  signed: SignedMandate;
  hash: string;
  recordFile: string;
  txs: { vra: string; vaa: string; anchor: TxOutcome };
}

export function sponsorClient(): SponsorClient {
  return httpSponsor(process.env.MANDATE_SPONSOR_URL ?? "http://127.0.0.1:4022");
}

function ok(t: TxOutcome, what: string): TxOutcome {
  if (!t.ok) throw new Error(`${what} failed on chain: ${t.rejectReason}`);
  return t;
}

/**
 * One-time agent setup by the human (all fees sponsored):
 * 1. CIS-8 registerExternalKey: bind the agent's ed25519 key to the human's account (proof signed by the agent key).
 * 2. CIS-8004 register: mint the agent NFT with external_reference = that CIS-8 key (so the NFT names its signing key).
 * 3. CIS-8004 setAgentWallet: route payments to the agent wallet (proof signed by the wallet's account key).
 */
export async function registerAgent(ctx: Ctx, sponsor: SponsorClient, log: (s: string) => void = console.log): Promise<AgentState> {
  const existing = state<AgentState>("agent.json");
  if (existing) return existing;
  // Resumable: each finished step is saved, so a re-run never re-submits a transaction that already landed.
  const partial = state<{ txs: Record<string, TxOutcome>; crossCheck: Record<string, unknown> }>("agent.partial.json") ?? { txs: {}, crossCheck: {} };
  const save = () => saveState("agent.partial.json", partial);
  const human = accountKey("human");
  const wallet = readAccounts().agentWallet.address;
  const k = await agentKey(true);
  const extKey = { key_type: "ed25519", namespace: AGENT_NAMESPACE, public_key: hexToBytes(k.publicKeyHex) };
  const txs = partial.txs;
  const crossCheck = partial.crossCheck;

  // 1. CIS-8 key binding
  const cb = await ctx.mcp.call<{ bytes_hex: string }>("build_cis8_canonical_bytes", { concordium_account: human.account, external_namespace: AGENT_NAMESPACE, external_key_namespace: AGENT_NAMESPACE, external_key_type: "ed25519", external_public_key_hex: k.publicKeyHex, proof_scheme: AGENT_SCHEME });
  const proof = toHex(await ed.signAsync(fromHex(cb.bytes_hex), k.secretKey));
  const bindParams = { external_key: extKey, metadata: [], proof: { scheme: AGENT_SCHEME, signature: hexToBytes(proof) } };
  const mcpBuilt = await ctx.mcp.call<{ receive_name: string; parameter_hex: string }>("build_cis8_register", { sender: human.account, external_key: { namespace: AGENT_NAMESPACE, key_type: "ed25519", public_key_hex: k.publicKeyHex }, proof: { scheme: AGENT_SCHEME, signature_hex: proof } });
  const ours = serializeParams(ctx.registry.cis8, "registerExternalKey", bindParams).toString();
  crossCheck.cis8Register = { mcpReceiveName: mcpBuilt.receive_name, identicalParameterBytes: mcpBuilt.parameter_hex === ours };
  log(`cross-check build_cis8_register: receive_name=${mcpBuilt.receive_name}, parameter bytes identical to our serialization: ${mcpBuilt.parameter_hex === ours}`);
  const boundTo = option<{ owner: string }>(await invoke(ctx.client, ctx.registry.cis8, "ownerOfKey", { external_key: extKey }));
  if (boundTo?.owner === human.account) log("CIS-8 key already bound to the human account (resuming)");
  else {
    txs.keyBinding = ok(await sendContractUpdate(ctx.client, { handle: ctx.registry.cis8, entrypoint: "registerExternalKey", params: bindParams }, human, sponsor), "CIS-8 registerExternalKey");
    save();
  }
  log(`CIS-8 key binding: ${txs.keyBinding?.hash} (fee payer ${txs.keyBinding?.feePayer})`);

  // 2. CIS-8004 register with external reference to the CIS-8 key
  const externalReference = { contract_address: { index: Number(TESTNET.cis8.index), subindex: 0 }, kind: { Cis8: [extKey] } };
  const findAgent = async () => option<{ token_id: string }>(await invoke(ctx.client, ctx.registry.cis8004, "agentByExternalReference", externalReference));
  let found = await findAgent();
  if (found) log("agent NFT for this key already registered (resuming)");
  else {
    txs.register = ok(await sendContractUpdate(ctx.client, { handle: ctx.registry.cis8004, entrypoint: "register", params: { agent_uri: { None: [] }, external_reference: { Some: [externalReference] }, initial_metadata: [{ key: "mandate:profile", value: hexToBytes(toHex(new TextEncoder().encode("mandate/v1"))) }], metadata_hash: { None: [] } } }, human, sponsor), "CIS-8004 register");
    save();
    found = await findAgent();
  }
  if (!found) throw new Error("agentByExternalReference did not find the new agent");
  const tokenId = String(new DataView(Uint8Array.from(hexToBytes(found.token_id)).buffer).getBigUint64(0, true));
  log(`CIS-8004 register: ${txs.register?.hash} -> token ${tokenId}`);

  // 3. setAgentWallet: the wallet proves control by signing the registry's canonical bytes
  const deadline = Date.now() + 10 * 60_000;
  const wb = await ctx.mcp.call<{ bytes_hex: string }>("set_agent_wallet_canonical_bytes", { token_id: tokenId, new_wallet: wallet, deadline_unix_ms: deadline });
  const walletSecret = rawAccountSecret("agentWallet");
  // Native Concordium wallet proof (found by dry-run on testnet, not in the docs): ed25519 signature by the wallet account's key over
  // the registry's canonical bytes, serialized as concordium-std AccountSignatures {cred 0: {key 0: Ed25519(sig)}} = 01 00 01 00 00 || sig.
  const raw = await ed.signAsync(fromHex(wb.bytes_hex), walletSecret);
  const walletParams = { token_id: tokenIdHex(tokenId), new_wallet: wallet, deadline: new Date(deadline).toISOString(), signature: [1, 0, 1, 0, 0, ...raw] };
  await invoke(ctx.client, ctx.registry.cis8004, "setAgentWallet", walletParams, human.account);
  crossCheck.agentWalletProofFormat = "AccountSignatures(ed25519 over canonical bytes)";
  txs.agentWallet = ok(await sendContractUpdate(ctx.client, { handle: ctx.registry.cis8004, entrypoint: "setAgentWallet", params: walletParams }, human, sponsor), "setAgentWallet");
  log(`setAgentWallet (${crossCheck.agentWalletProofFormat}): ${txs.agentWallet.hash}`);

  const badge = (await ctx.mcp.call<{ token_address: string }>("token_address", { contract_index: Number(TESTNET.cis8004.index), contract_subindex: 0, token_id: Number(tokenId) })).token_address;
  const s: AgentState = { tokenId, badge, agentKeyPublicHex: k.publicKeyHex, agentWallet: wallet, owner: human.account, txs, crossCheck };
  saveState("agent.json", s);
  saveState("agent.partial.json", {});
  return s;
}

// ---------------- Verify & Access: account-bound age >= 18 ----------------

/** Wallet side (headless here, the Concordium wallet in production): produce the ZK presentation from the human's identity. */
async function holderPresentation(ctx: Ctx, request: VerificationRequestV1.Type) {
  const a = readAccounts().human;
  const identity = JSON.parse(readFileSync(resolve(SECRETS_DIR, `${a.identity}.identity.json`), "utf8"));
  const w = ConcordiumHdWallet.fromSeedPhrase(readFileSync(resolve(SECRETS_DIR, `${a.identity}.seed.txt`), "utf8").trim(), "Testnet");
  const attrs: Record<string, string> = identity.value.attributeList.chosenAttributes;
  const randomness: Record<string, string> = {};
  for (const k of Object.keys(attrs)) randomness[k] = w.getAttributeCommitmentRandomness(0, 0, a.credNumber, AttributesKeys[k as keyof typeof AttributesKeys]).toString("hex");
  const statements = VerifiablePresentationV1.noRevealRequestedStatements(request.subjectClaims[0]!.statements);
  const claims = VerifiablePresentationV1.createAccountClaims("Testnet", CredentialRegistrationId.fromHexString(a.credId), 0, statements);
  return VerifiablePresentationV1.createFromAnchor(ctx.client, request, [claims], [{ type: "account", issuer: 0, values: attrs, randomness }], []);
}

/** Verifier side (operator): anchor the request (VRA), verify the presentation, anchor the audit record (VAA). */
export type StepFn = (step: "vra" | "presentation" | "vaa" | "signed" | "anchor", detail?: { tx?: string; note?: string }) => void;

export async function proveAdult(ctx: Ctx, mandateId: string, onStep: StepFn = () => {}) {
  const op = accountKey("sponsor");
  const verifier = { sender: AccountAddress.fromBase58(op.account), signer: op.signer };
  const claims = VerificationRequestV1.claimsBuilder().addAccountClaims([new IdentityProviderDID("Testnet", 0)], (b) => b.addMinimumAge(18)).getClaims();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const { type: _t, ...context } = VerificationRequestV1.createSimpleContext(nonce, `mandate:${mandateId}`, "mandate-issuer", `Mandate ${mandateId}`);
  const request = await VerificationRequestV1.createAndAnchor(ctx.client, verifier, context, claims, { app: "mandate" });
  await ctx.client.waitForTransactionFinalization(request.transactionRef, 120_000);
  onStep("vra", { tx: request.transactionRef.toString() });
  const presentation = await holderPresentation(ctx, request);
  onStep("presentation", { note: "zero-knowledge presentation created by the testnet wallet (headless)" });
  const audit = await VerificationAuditRecordV1.createAndAnchor(crypto.randomUUID(), request, presentation, ctx.client, { metadata: verifier, info: { app: "mandate" } }, { network: "Testnet" });
  if (audit.type !== "success") throw new Error("age proof did not verify");
  const vaa = audit.result.anchorTransactionRef;
  await ctx.client.waitForTransactionFinalization(vaa, 120_000);
  onStep("vaa", { tx: vaa.toString() });
  const record = JSON.parse(JSON.stringify(audit.result.record.toJSON(), (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  return { vra: request.transactionRef.toString(), vaa: vaa.toString(), record };
}

export interface IssueOptions {
  actions: string[];
  domains: string[];
  ttlSeconds: number;
  maxPerAction?: string;
  maxTotal?: string;
  recordBaseUrl?: string;
}

export async function issueMandate(ctx: Ctx, sponsor: SponsorClient, agent: AgentState, o: IssueOptions, log: (s: string) => void = console.log, onStep: StepFn = () => {}): Promise<IssuedMandate> {
  const human = accountKey("human");
  const id = crypto.randomUUID();
  log(`issuing mandate ${id}: age proof (VRA/VAA) ...`);
  const proof = await proveAdult(ctx, id, onStep);
  const recordSha256 = sha256Hex(canonicalJson(proof.record));
  const recordFile = saveState(`proofs/${recordSha256}.json`, proof.record);
  const now = Math.floor(Date.now() / 1000);
  const scope: MandateScope = { actions: o.actions, domains: o.domains };
  if (o.maxPerAction) scope.maxPerAction = { amount: o.maxPerAction, asset: "CCD" };
  if (o.maxTotal) scope.maxTotal = { amount: o.maxTotal, asset: "CCD" };
  const m: Mandate = {
    v: 1, id, network: CCD_TESTNET, issuer: human.account,
    agent: { contract: { index: String(TESTNET.cis8004.index), subindex: "0" }, tokenId: agent.tokenId },
    agentKey: { namespace: AGENT_NAMESPACE, keyType: "ed25519", scheme: AGENT_SCHEME, publicKeyHex: agent.agentKeyPublicHex },
    agentWallet: agent.agentWallet,
    scope, notBefore: now - 30, expiry: now + o.ttlSeconds,
    adultProof: { statement: "age>=18", vraTx: proof.vra, vaaTx: proof.vaa, recordSha256, recordUrl: `${o.recordBaseUrl ?? process.env.MANDATE_RECORD_BASE ?? "http://127.0.0.1:4022/proofs"}/${recordSha256}.json` },
    nonce: randomNonce(),
  };
  const signed = await signMandate(m, human.signer);
  onStep("signed", { note: "signed with the human account key (signMessage)" });
  const anchor = ok(await sendContractUpdate(ctx.client, { handle: ctx.registry.cis8004, entrypoint: "setMetadata", params: { key: anchorKey(id), token_id: tokenIdHex(agent.tokenId), value: hexToBytes(toHex(new TextEncoder().encode(anchorValue(m)))) } }, human, sponsor), "anchor setMetadata");
  log(`anchored ${anchorKey(id)} = ${anchorValue(m)} in ${anchor.hash} (fee payer ${anchor.feePayer})`);
  onStep("anchor", { tx: anchor.hash });
  saveState(`mandates/${id}.json`, signed);
  saveState(`mandates/${id}.txs.json`, { vra: proof.vra, vaa: proof.vaa, anchor: anchor.hash, at: new Date().toISOString() });
  return { signed, hash: mandateHash(m), recordFile, txs: { vra: proof.vra, vaa: proof.vaa, anchor } };
}

/** Revoke in one transaction: overwrite the anchor. Every verifier sees it within its stated revocation bound. */
export async function revokeMandate(ctx: Ctx, sponsor: SponsorClient, m: Mandate): Promise<TxOutcome> {
  const human = accountKey("human");
  const t = ok(await sendContractUpdate(ctx.client, { handle: ctx.registry.cis8004, entrypoint: "setMetadata", params: { key: anchorKey(m.id), token_id: tokenIdHex(m.agent.tokenId), value: hexToBytes(toHex(new TextEncoder().encode(revokedAnchorValue(Math.floor(Date.now() / 1000))))) } }, human, sponsor), "revoke setMetadata");
  saveState(`mandates/${m.id}.revoked.json`, { tx: t.hash, at: new Date().toISOString(), feePayer: t.feePayer });
  return t;
}

export async function anchorStatus(ctx: Ctx, m: Mandate) {
  const [grpc, mcp] = await Promise.all([
    grpcGetMetadata(ctx.client, ctx.registry, m.agent.tokenId, anchorKey(m.id)),
    ctx.mcp.getMetadata(m.agent.tokenId, anchorKey(m.id)).catch((e: Error) => `MCP error: ${e.message}`),
  ]);
  return { grpc, mcp, agreed: grpc === mcp };
}

export function loadMandate(id?: string): SignedMandate {
  const cur = id ?? state<{ id: string }>("mandates/current.json")?.id;
  if (!cur) throw new Error("no mandate issued yet");
  const sm = state<SignedMandate>(`mandates/${cur}.json`);
  if (!sm) throw new Error(`mandate ${cur} not found`);
  return sm;
}

export { grpcAgentOf, bytesToHex };

// ---------------- Agent Card (A2A) with the Verified by Concordium badge and the Mandate extension ----------------

export const PAGES_BASE = process.env.MANDATE_PAGES_BASE ?? "https://seunghyeon1004.github.io/mandate";
export const MANDATE_EXTENSION_URI = `${PAGES_BASE}/a2a-extensions/mandate/v1/`;

export function cardUrl(tokenId: string): string {
  return `${PAGES_BASE}/agents/${tokenId}/agent-card.json`;
}

/** Build the card with the hosted MCP (badge included), add the Mandate extension, write it under site/ for GitHub Pages. */
export async function buildCard(ctx: Ctx, agent: AgentState, repoRoot: string): Promise<{ file: string; sha256: string; url: string }> {
  const url = cardUrl(agent.tokenId);
  const b = await ctx.mcp.call<{ agent_card_json: string }>("build_agent_card", {
    name: "Mandate demo agent",
    description: "Generic sign-up and browsing agent. It acts only under a mandate signed by a verified adult human (Concordium ID, zero-knowledge age proof), signs every HTTP request with its CIS-8-bound key, and pays x402 invoices in CCD from its registered agent wallet. Testnet demo.",
    agent_uri: url, owner_account: agent.owner, agent_wallet: agent.agentWallet, token_id: agent.tokenId, version: "0.1.0",
    skills: [
      { id: "signup", name: "Sign up", description: "Creates an account on a site that accepts Concordium mandates instead of a CAPTCHA.", tags: ["mandate", "signup"] },
      { id: "post_comment", name: "Post a comment", description: "Posts a comment on behalf of the mandate issuer.", tags: ["mandate"] },
      { id: "buy_report", name: "Buy a report", description: "Buys a paid resource via x402 in CCD within the mandate's spend caps.", tags: ["mandate", "x402"] },
    ],
  });
  const card = JSON.parse(b.agent_card_json);
  card.capabilities.extensions.push({
    uri: MANDATE_EXTENSION_URI,
    description: "Mandate: requests carry a mandate signed by the agent's owner (scope, expiry, spend caps, age proof) and are signed with the agent's CIS-8 key. Verifiers check them against Concordium.",
    required: false,
    params: {
      requestHeaders: ["Mandate", "Mandate-Signature"],
      signingKey: { cis8: { namespace: AGENT_NAMESPACE, keyType: "ed25519", scheme: AGENT_SCHEME, publicKeyHex: agent.agentKeyPublicHex } },
      anchor: "CIS-8004 agent metadata key mandate:<id> = sha256:<JCS hash>|exp:<unix> or revoked|at:<unix>",
      verifyPage: `${PAGES_BASE}/verify/`,
      spec: MANDATE_EXTENSION_URI,
    },
  });
  const text = JSON.stringify(card, null, 2) + "\n";
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = resolve(repoRoot, "site", "agents", agent.tokenId);
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, "agent-card.json");
  writeFileSync(file, text);
  return { file, sha256: sha256Hex(new TextEncoder().encode(text)), url };
}

/** After Pages serves the card: check the served bytes, pin agent_uri + SHA-256 on chain (sponsored), then run the hosted badge check. */
export async function pinCard(ctx: Ctx, sponsor: SponsorClient, agent: AgentState, localSha256: string) {
  const url = cardUrl(agent.tokenId);
  const served = new Uint8Array(await (await fetch(url, { cache: "no-store" })).arrayBuffer());
  const servedSha = sha256Hex(served);
  if (servedSha !== localSha256) throw new Error(`Pages serves different bytes (${servedSha.slice(0, 12)} != ${localSha256.slice(0, 12)}); wait for the deploy`);
  const human = accountKey("human");
  const tx = ok(await sendContractUpdate(ctx.client, { handle: ctx.registry.cis8004, entrypoint: "setAgentURI", params: { token_id: tokenIdHex(agent.tokenId), agent_uri: { Some: [url] }, metadata_hash: { Some: [hexToBytes(servedSha)] } } }, human, sponsor), "setAgentURI");
  const badge = await ctx.mcp.checkBadge(agent.badge);
  return { tx, servedSha, badge };
}
