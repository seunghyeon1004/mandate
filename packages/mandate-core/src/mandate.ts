import { AccountAddress, signMessage, verifyMessageSignature, type AccountInfo, type AccountSigner, type AccountTransactionSignature } from "@concordium/web-sdk";
import { canonicalJson, sha256Hex } from "./encoding.js";

export const MANDATE_VERSION = 1 as const;
export const CCD_TESTNET = "ccd:4221332d34e1694168c2a0c0b3fd0f27";
export const CCD_MAINNET = "ccd:9dd9ca4d19e9393877d2c44b70f89acb";

/** An amount in the asset's smallest unit (CCD: micro-CCD, 6 decimals), as a decimal string. */
export interface Amount {
  amount: string;
  asset: "CCD";
}

export interface MandateScope {
  /** Action names the relying party maps its routes to, e.g. "signup", "post_comment", "buy_report". */
  actions: string[];
  /** Host names (exact match, lower case) the agent may use the mandate on. */
  domains: string[];
  /** Maximum price of a single paid action. Absent: paid actions are not allowed. */
  maxPerAction?: Amount;
  /** Maximum total spend under this mandate, as tracked by each relying party (off chain). */
  maxTotal?: Amount;
}

export interface AdultProof {
  statement: "age>=18";
  /** Verification Request Anchor (registerData) tx hash. */
  vraTx: string;
  /** Verification Audit Anchor (registerData) tx hash. */
  vaaTx: string;
  /** SHA-256 of the JCS form of the VerificationAuditRecordV1 JSON. */
  recordSha256: string;
  /** Where the audit record (no personal data: ZK proof only) can be fetched. Integrity comes from recordSha256 and the on-chain VAA. */
  recordUrl: string;
}

export interface Mandate {
  v: typeof MANDATE_VERSION;
  /** UUID; also the on-chain metadata key suffix (`mandate:<id>`). */
  id: string;
  /** CAIP-2 network id. */
  network: string;
  /** The human's Concordium account (base58). Signs the mandate and owns the agent. */
  issuer: string;
  /** CIS-8004 agent: registry contract and token id (decimal string). */
  agent: { contract: { index: string; subindex: string }; tokenId: string };
  /** The agent's request-signing key, bound to the issuer through CIS-8. */
  agentKey: { namespace: string; keyType: "ed25519"; scheme: "solana-ed25519"; publicKeyHex: string };
  /** Concordium account the agent pays x402 invoices from (the agent's registered agentWallet). */
  agentWallet?: string;
  scope: MandateScope;
  /** Unix seconds. */
  notBefore: number;
  /** Unix seconds. */
  expiry: number;
  adultProof?: AdultProof;
  /** Random hex, makes each mandate unique even with identical scope. */
  nonce: string;
}

export interface SignedMandate {
  mandate: Mandate;
  /** Concordium account message signature (`signMessage`), credential index -> key index -> hex. */
  signature: AccountTransactionSignature;
}

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTION = /^[a-z][a-z0-9_]{0,31}$/;
const DOMAIN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const DEC = /^(0|[1-9][0-9]{0,30})$/;

function isAmount(a: unknown): a is Amount {
  return !!a && typeof a === "object" && (a as Amount).asset === "CCD" && DEC.test((a as Amount).amount ?? "") && Object.keys(a).length === 2;
}

/** Structural validation. Returns null when valid, else a short reason. Does not check signatures or chain state. */
export function validateMandate(m: unknown): string | null {
  if (!m || typeof m !== "object") return "mandate is not an object";
  const x = m as Mandate;
  if (x.v !== MANDATE_VERSION) return "unsupported version";
  if (!UUID.test(x.id ?? "")) return "id must be a lower-case UUID";
  if (!/^ccd:[0-9a-f]{32}$/.test(x.network ?? "")) return "network must be a ccd CAIP-2 id";
  try { AccountAddress.fromBase58(x.issuer); } catch { return "issuer is not a Concordium address"; }
  if (!x.agent || !DEC.test(x.agent.tokenId ?? "") || !DEC.test(x.agent.contract?.index ?? "") || !DEC.test(x.agent.contract?.subindex ?? "")) return "agent reference invalid";
  const k = x.agentKey;
  if (!k || k.keyType !== "ed25519" || k.scheme !== "solana-ed25519" || typeof k.namespace !== "string" || !k.namespace || !HEX64.test(k.publicKeyHex ?? "")) return "agentKey invalid";
  if (x.agentWallet !== undefined) { try { AccountAddress.fromBase58(x.agentWallet); } catch { return "agentWallet is not a Concordium address"; } }
  const s = x.scope;
  if (!s || !Array.isArray(s.actions) || !s.actions.length || !s.actions.every((a) => ACTION.test(a))) return "scope.actions invalid";
  if (!Array.isArray(s.domains) || !s.domains.length || !s.domains.every((d) => DOMAIN.test(d))) return "scope.domains invalid";
  if (s.maxPerAction !== undefined && !isAmount(s.maxPerAction)) return "scope.maxPerAction invalid";
  if (s.maxTotal !== undefined && !isAmount(s.maxTotal)) return "scope.maxTotal invalid";
  if (!Number.isSafeInteger(x.notBefore) || !Number.isSafeInteger(x.expiry) || x.expiry <= x.notBefore) return "validity window invalid";
  if (x.adultProof !== undefined) {
    const p = x.adultProof;
    if (p.statement !== "age>=18" || !HEX64.test(p.vraTx ?? "") || !HEX64.test(p.vaaTx ?? "") || !HEX64.test(p.recordSha256 ?? "") || !/^https?:\/\//.test(p.recordUrl ?? "")) return "adultProof invalid";
  }
  if (!/^[0-9a-f]{32,64}$/.test(x.nonce ?? "")) return "nonce invalid";
  return null;
}

/** The exact text the human signs with their Concordium account (wallet `signMessage`): the JCS form of the mandate. */
export function mandateSigningMessage(m: Mandate): string {
  return canonicalJson(m);
}

/** SHA-256 (hex) of the JCS form of the mandate. This is what is anchored on chain. */
export function mandateHash(m: Mandate): string {
  return sha256Hex(canonicalJson(m));
}

/** CIS-8004 agent metadata key holding this mandate's anchor (<= 64 chars). */
export function anchorKey(mandateId: string): string {
  return `mandate:${mandateId}`;
}

/** Short ASCII anchor value stored on chain (the contract accepts UTF-8 text up to ~470 bytes). */
export function anchorValue(m: Mandate): string {
  return `sha256:${mandateHash(m)}|exp:${m.expiry}`;
}

/** Value written over the anchor to revoke the mandate (one transaction). */
export function revokedAnchorValue(atUnix: number): string {
  return `revoked|at:${atUnix}`;
}

export type ParsedAnchor =
  | { kind: "active"; hash: string; expiry: number }
  | { kind: "revoked"; at: number }
  | { kind: "absent" }
  | { kind: "invalid" };

export function parseAnchor(value: string | null): ParsedAnchor {
  if (value === null) return { kind: "absent" };
  let m = /^sha256:([0-9a-f]{64})\|exp:([0-9]{1,15})$/.exec(value);
  if (m) return { kind: "active", hash: m[1]!, expiry: Number(m[2]) };
  m = /^revoked\|at:([0-9]{1,15})$/.exec(value);
  if (m) return { kind: "revoked", at: Number(m[1]) };
  return { kind: "invalid" };
}

/** Sign a mandate headlessly with an account signer (same signature type the Concordium wallet's `signMessage` returns). */
export async function signMandate(m: Mandate, signer: AccountSigner): Promise<SignedMandate> {
  const reason = validateMandate(m);
  if (reason) throw new TypeError(`invalid mandate: ${reason}`);
  const signature = await signMessage(AccountAddress.fromBase58(m.issuer), mandateSigningMessage(m), signer);
  return { mandate: m, signature };
}

/** Verify the human's signature against the issuer account's on-chain credential keys. */
export async function verifyMandateSignature(sm: SignedMandate, issuerInfo: AccountInfo): Promise<boolean> {
  if (issuerInfo.accountAddress.address !== sm.mandate.issuer) return false;
  try {
    return await verifyMessageSignature(mandateSigningMessage(sm.mandate), sm.signature, issuerInfo);
  } catch {
    return false;
  }
}
