import type { AccountInfo } from "@concordium/web-sdk";
import { anchorKey, anchorValue, mandateHash, parseAnchor, validateMandate, verifyMandateSignature, type Amount, type Mandate, type SignedMandate } from "./mandate.js";
import { decodeMandateHeader, parseSignatureHeader, verifyRequestSignature } from "./request.js";

/** Where an answer came from. `local` = pure computation, no network. */
export type Source = "local" | "mcp" | "grpc" | "indexer" | "cache";

export interface Sourced<T> {
  value: T;
  source: Source;
}

export type RejectionCode =
  | "missing_headers"
  | "bad_mandate"
  | "wrong_network"
  | "bad_request_signature"
  | "stale_request"
  | "replay"
  | "not_yet_valid"
  | "expired"
  | "action_out_of_scope"
  | "domain_out_of_scope"
  | "payment_not_allowed"
  | "over_cap_per_action"
  | "over_cap_total"
  | "bad_human_signature"
  | "not_anchored"
  | "revoked"
  | "anchor_mismatch"
  | "agent_not_found"
  | "agent_revoked"
  | "agent_not_owned_by_issuer"
  | "agent_key_mismatch"
  | "key_not_bound"
  | "adult_proof_missing"
  | "adult_proof_invalid"
  | "chain_unavailable";

export type CheckName =
  | "headers"
  | "mandate_format"
  | "network"
  | "request_signature"
  | "freshness"
  | "replay"
  | "validity_window"
  | "scope_action"
  | "scope_domain"
  | "spend_cap"
  | "human_signature"
  | "on_chain_anchor"
  | "agent_registry"
  | "key_binding"
  | "adult_proof";

export interface Check {
  name: CheckName;
  /** true = passed, false = failed, null = not evaluated because an earlier check failed. */
  ok: boolean | null;
  code?: RejectionCode;
  reason?: string;
  source?: Source;
}

export interface VerifyResult {
  ok: boolean;
  code?: RejectionCode;
  reason?: string;
  checks: Check[];
  mandate?: Mandate;
  mandateHash?: string;
  /** Spend reservation held for this request (commit after settlement, release otherwise). */
  reservation?: string;
}

export interface AgentRecord {
  owner: string;
  status: "Active" | "Revoked" | string;
  wallet: string | null;
  /** CIS-8 key referenced by the agent NFT's external_reference, if any. */
  externalKey: { namespace: string; keyType: string; publicKeyHex: string } | null;
}

export interface KeyRecord {
  owner: string;
  status: "Active" | "Revoked" | string;
}

/** Read access to Concordium. Implementations must not cache revocable state for longer than their stated bound. */
export interface ChainView {
  accountInfo(address: string): Promise<Sourced<AccountInfo>>;
  mandateAnchor(tokenId: string, key: string): Promise<Sourced<string | null>>;
  agent(tokenId: string): Promise<Sourced<AgentRecord | null>>;
  keyOwner(key: { namespace: string; keyType: string; publicKeyHex: string }): Promise<Sourced<KeyRecord | null>>;
  adultProof(m: Mandate): Promise<Sourced<{ ok: boolean; reason?: string }>>;
}

export interface ReplayGuard {
  /** Atomically records `key` until `expiresAtMs`. Returns false if the key was already present. */
  remember(key: string, expiresAtMs: number): Promise<boolean>;
}

export interface SpendLedger {
  /** Total already spent or reserved under this mandate at this relying party, in the asset's smallest unit. */
  spent(mandateHash: string): Promise<bigint>;
  /**
   * Atomically reserve `amount` if spent + reserved + amount <= cap. Returns a reservation id, or null if it would exceed the cap.
   * The caller commits the reservation after the payment settles, or releases it. Implementations expire stale reservations.
   */
  reserve?(mandateHash: string, amount: bigint, cap: bigint): Promise<string | null>;
  release?(reservation: string): Promise<void>;
}

export interface VerifyPolicy {
  network: string;
  registry: { index: string; subindex: string };
  /** Allowed difference between the request timestamp and the verifier clock. Default 60 s. */
  maxSkewMs?: number;
  /** Default true. */
  requireAdultProof?: boolean;
}

export interface VerifyInput {
  method: string;
  url: string;
  body: Uint8Array | string;
  headers: { mandate?: string | null; signature?: string | null };
  /** The action this route represents (decided by the relying party, never by the agent). */
  action: string;
  /** Price of this request if it is paid. */
  price?: Amount;
  /** Reserve the price against maxTotal (set when the request carries a payment), so concurrent payments cannot overshoot. */
  reserveSpend?: boolean;
  now?: number;
}

export interface VerifyDeps {
  chain: ChainView;
  replay: ReplayGuard;
  ledger?: SpendLedger;
}

const ORDER: CheckName[] = ["headers", "mandate_format", "network", "request_signature", "freshness", "replay", "validity_window", "scope_action", "scope_domain", "spend_cap", "human_signature", "on_chain_anchor", "agent_registry", "key_binding", "adult_proof"];

class Fail extends Error {
  readonly code: RejectionCode;
  readonly why: string;
  readonly source: Source;
  constructor(code: RejectionCode, why: string, source: Source = "local") {
    super(why);
    this.code = code;
    this.why = why;
    this.source = source;
  }
}

/**
 * Verify an agent's HTTP request made under a mandate. Returns every check with pass/fail, the reason and which source answered.
 * Local checks run first; chain checks run only when all local checks pass (they cost network calls). Fails closed: an
 * unreachable chain gives `chain_unavailable`, never a pass.
 */
export async function verifyMandateRequest(input: VerifyInput, policy: VerifyPolicy, deps: VerifyDeps): Promise<VerifyResult> {
  const now = input.now ?? Date.now();
  const checks = new Map<CheckName, Check>();
  const pass = (name: CheckName, source: Source = "local", reason?: string) => checks.set(name, { name, ok: true, source, ...(reason ? { reason } : {}) });
  const result = (): VerifyResult => {
    const list = ORDER.map((n) => checks.get(n) ?? { name: n, ok: null });
    const failed = list.find((c) => c.ok === false);
    return { ok: !failed, ...(failed ? { code: failed.code!, reason: failed.reason! } : {}), checks: list, ...(sm ? { mandate: sm.mandate, mandateHash: hash } : {}) };
  };
  const run = async (name: CheckName, fn: () => Promise<Source | void> | Source | void): Promise<boolean> => {
    try {
      const src = await fn();
      pass(name, src || "local");
      return true;
    } catch (e) {
      if (e instanceof Fail) checks.set(name, { name, ok: false, code: e.code, reason: e.why, source: e.source });
      else checks.set(name, { name, ok: false, code: "chain_unavailable", reason: `lookup failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`, source: "local" });
      return false;
    }
  };

  let sm: SignedMandate | null = null;
  let hash = "";
  let reservation: string | undefined;
  const sig = parseSignatureHeader(input.headers.signature);
  if (!(await run("headers", () => {
    if (!input.headers.mandate || !input.headers.signature) throw new Fail("missing_headers", "Mandate and Mandate-Signature headers are required");
    sm = decodeMandateHeader(input.headers.mandate);
    if (!sm) throw new Fail("bad_mandate", "Mandate header is not valid base64url JSON");
    if (!sig) throw new Fail("missing_headers", "Mandate-Signature header is malformed");
  }))) return result();
  const signed = sm as unknown as SignedMandate;
  const m = signed.mandate;

  if (!(await run("mandate_format", () => {
    const why = validateMandate(m);
    if (why) throw new Fail("bad_mandate", why);
    hash = mandateHash(m);
  }))) return result();

  const local: Array<[CheckName, () => Promise<Source | void> | Source | void]> = [
    ["network", () => {
      if (m.network !== policy.network) throw new Fail("wrong_network", `mandate is for ${m.network}, this site accepts ${policy.network}`);
      if (m.agent.contract.index !== policy.registry.index || m.agent.contract.subindex !== policy.registry.subindex) throw new Fail("wrong_network", "agent is not in the Agent Registry this site trusts");
    }],
    ["request_signature", async () => {
      const ok = await verifyRequestSignature({ method: input.method, url: input.url, body: input.body, timestamp: sig!.timestamp, nonce: sig!.nonce, mandateHash: hash }, sig!.signature, m.agentKey.publicKeyHex);
      if (!ok) throw new Fail("bad_request_signature", "request was not signed by the mandate's agent key (or was altered)");
    }],
    ["freshness", () => {
      const skew = policy.maxSkewMs ?? 60_000;
      if (Math.abs(now - sig!.timestamp) > skew) throw new Fail("stale_request", `request timestamp is ${Math.round((now - sig!.timestamp) / 1000)} s from verifier time (max ${skew / 1000} s)`);
    }],
    ["replay", async () => {
      const skew = policy.maxSkewMs ?? 60_000;
      const fresh = await deps.replay.remember(`${m.agentKey.publicKeyHex}:${sig!.nonce}`, sig!.timestamp + skew + 1000);
      if (!fresh) throw new Fail("replay", "this exact signed request was already used");
    }],
    ["validity_window", () => {
      const t = Math.floor(now / 1000);
      if (t < m.notBefore) throw new Fail("not_yet_valid", `mandate is valid from ${new Date(m.notBefore * 1000).toISOString()}`);
      if (t >= m.expiry) throw new Fail("expired", `mandate expired at ${new Date(m.expiry * 1000).toISOString()}`);
    }],
    ["scope_action", () => {
      if (!m.scope.actions.includes(input.action)) throw new Fail("action_out_of_scope", `action "${input.action}" is not in the mandate (allowed: ${m.scope.actions.join(", ")})`);
    }],
    ["scope_domain", () => {
      const host = new URL(input.url).hostname.toLowerCase();
      if (!m.scope.domains.includes(host)) throw new Fail("domain_out_of_scope", `domain ${host} is not in the mandate`);
    }],
    ["spend_cap", async () => {
      if (!input.price) return;
      const max = m.scope.maxPerAction;
      if (!max) throw new Fail("payment_not_allowed", "mandate does not allow paid actions");
      if (max.asset !== input.price.asset) throw new Fail("payment_not_allowed", `mandate allows ${max.asset}, price is in ${input.price.asset}`);
      if (BigInt(input.price.amount) > BigInt(max.amount)) throw new Fail("over_cap_per_action", `price ${input.price.amount} exceeds per-action cap ${max.amount}`);
      if (m.scope.maxTotal) {
        const price = BigInt(input.price.amount), cap = BigInt(m.scope.maxTotal.amount);
        if (input.reserveSpend && deps.ledger?.reserve) {
          const id = await deps.ledger.reserve(hash, price, cap);
          if (!id) throw new Fail("over_cap_total", `this payment plus spent and in-flight payments would exceed the total cap ${cap}`);
          reservation = id;
        } else {
          const spent = deps.ledger ? await deps.ledger.spent(hash) : 0n;
          if (spent + price > cap) throw new Fail("over_cap_total", `total ${spent + price} would exceed cap ${cap}`);
        }
      }
    }],
  ];
  for (const [name, fn] of local) if (!(await run(name, fn))) return result();

  // Chain checks are independent: run them in parallel.
  await Promise.all(chainChecks(signed, policy, deps.chain, run));
  const r = result();
  if (reservation) {
    if (r.ok) r.reservation = reservation;
    else await deps.ledger?.release?.(reservation);
  }
  return r;
}

type Runner = (name: CheckName, fn: () => Promise<Source | void> | Source | void) => Promise<boolean>;

/** The on-chain checks shared by verifyMandateRequest (relying parties) and verifyMandate (the public verify page). */
function chainChecks(signed: SignedMandate, policy: VerifyPolicy, chain: ChainView, run: Runner): Array<Promise<boolean>> {
  const m = signed.mandate;
  return [
    run("human_signature", async () => {
      const info = await chain.accountInfo(m.issuer);
      if (!(await verifyMandateSignature(signed, info.value))) throw new Fail("bad_human_signature", "mandate signature does not match the issuer account's keys", info.source);
      return info.source;
    }),
    run("on_chain_anchor", async () => {
      const a = await chain.mandateAnchor(m.agent.tokenId, anchorKey(m.id));
      const p = parseAnchor(a.value);
      if (p.kind === "revoked") throw new Fail("revoked", `mandate was revoked on chain at ${new Date(p.at * 1000).toISOString()}`, a.source);
      if (p.kind === "absent") throw new Fail("not_anchored", "no on-chain anchor for this mandate", a.source);
      if (a.value !== anchorValue(m)) throw new Fail("anchor_mismatch", "on-chain anchor does not match this mandate (altered or replaced)", a.source);
      return a.source;
    }),
    run("agent_registry", async () => {
      const a = await chain.agent(m.agent.tokenId);
      if (!a.value) throw new Fail("agent_not_found", `agent token ${m.agent.tokenId} does not exist`, a.source);
      if (a.value.status !== "Active") throw new Fail("agent_revoked", `agent status is ${a.value.status}`, a.source);
      if (a.value.owner !== m.issuer) throw new Fail("agent_not_owned_by_issuer", "agent NFT is not owned by the mandate issuer", a.source);
      const k = a.value.externalKey;
      if (!k || k.publicKeyHex !== m.agentKey.publicKeyHex || k.namespace !== m.agentKey.namespace || k.keyType !== m.agentKey.keyType) throw new Fail("agent_key_mismatch", "agent NFT does not reference this signing key", a.source);
      if (m.agentWallet && a.value.wallet !== m.agentWallet) throw new Fail("agent_key_mismatch", "registered agentWallet differs from the mandate", a.source);
      return a.source;
    }),
    run("key_binding", async () => {
      const k = await chain.keyOwner(m.agentKey);
      if (!k.value) throw new Fail("key_not_bound", "agent key has no CIS-8 binding", k.source);
      if (k.value.status !== "Active") throw new Fail("key_not_bound", `CIS-8 binding status is ${k.value.status}`, k.source);
      if (k.value.owner !== m.issuer) throw new Fail("key_not_bound", "agent key is bound to a different account", k.source);
      return k.source;
    }),
    run("adult_proof", async () => {
      if (!m.adultProof) {
        if (policy.requireAdultProof ?? true) throw new Fail("adult_proof_missing", "mandate carries no age proof");
        return "local";
      }
      const r = await chain.adultProof(m);
      if (!r.value.ok) throw new Fail("adult_proof_invalid", r.value.reason ?? "age proof did not verify", r.source);
      return r.source;
    }),
  ];
}

const MANDATE_ONLY: CheckName[] = ["mandate_format", "network", "validity_window", "human_signature", "on_chain_anchor", "agent_registry", "key_binding", "adult_proof"];

/**
 * Verify a signed mandate on its own (no HTTP request): structure, network, validity window, and every on-chain check.
 * Used by the public in-browser verify page. Unlike verifyMandateRequest, chain checks run even if the window has passed,
 * so an expired or revoked mandate shows all its evidence.
 */
export async function verifyMandate(signed: SignedMandate, policy: VerifyPolicy, chain: ChainView, now: number = Date.now()): Promise<VerifyResult> {
  const checks = new Map<CheckName, Check>();
  const run: Runner = async (name, fn) => {
    try {
      const src = await fn();
      checks.set(name, { name, ok: true, source: src || "local" });
      return true;
    } catch (e) {
      if (e instanceof Fail) checks.set(name, { name, ok: false, code: e.code, reason: e.why, source: e.source });
      else checks.set(name, { name, ok: false, code: "chain_unavailable", reason: `lookup failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`, source: "local" });
      return false;
    }
  };
  const m = signed.mandate;
  let hash = "";
  const formatOk = await run("mandate_format", () => {
    const why = validateMandate(m);
    if (why) throw new Fail("bad_mandate", why);
    hash = mandateHash(m);
  });
  if (formatOk) {
    await run("network", () => {
      if (m.network !== policy.network) throw new Fail("wrong_network", `mandate is for ${m.network}, expected ${policy.network}`);
      if (m.agent.contract.index !== policy.registry.index || m.agent.contract.subindex !== policy.registry.subindex) throw new Fail("wrong_network", "agent is not in the expected Agent Registry");
    });
    await run("validity_window", () => {
      const t = Math.floor(now / 1000);
      if (t < m.notBefore) throw new Fail("not_yet_valid", `mandate is valid from ${new Date(m.notBefore * 1000).toISOString()}`);
      if (t >= m.expiry) throw new Fail("expired", `mandate expired at ${new Date(m.expiry * 1000).toISOString()}`);
    });
    await Promise.all(chainChecks(signed, policy, chain, run));
  }
  const list = MANDATE_ONLY.map((n) => checks.get(n) ?? { name: n, ok: null });
  const failed = list.find((c) => c.ok === false);
  return { ok: !failed, ...(failed ? { code: failed.code!, reason: failed.reason! } : {}), checks: list, mandate: m, ...(hash ? { mandateHash: hash } : {}) };
}
