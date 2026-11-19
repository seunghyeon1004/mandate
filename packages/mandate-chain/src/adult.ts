// Re-verifies a mandate's "verified adult" evidence end to end, trusting nobody but the chain:
// audit record integrity (hash pinned in the signed mandate) -> VAA anchor on chain -> VRA anchor on chain -> ZK proof with the node
// -> the proven credential belongs to the mandate issuer's account -> the proof was made for this mandate id -> statement is age >= 18.
import {
  CredentialRegistrationId, TransactionHash, VerifiablePresentationV1, VerificationAuditRecordV1, VerificationRequestV1,
  type ConcordiumGRPCClient,
} from "@concordium/web-sdk";
import { canonicalJson, sha256Hex, type Mandate } from "@mandate/core";

export type RecordFetcher = (url: string) => Promise<unknown>;

/** Default fetcher: https only (http allowed for 127.0.0.1/localhost in development), 64 KB cap, 5 s timeout. */
export function defaultRecordFetcher(opts: { allowHttpLocalhost?: boolean; maxBytes?: number; timeoutMs?: number } = {}): RecordFetcher {
  return async (url) => {
    const u = new URL(url);
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(opts.allowHttpLocalhost && local && u.protocol === "http:")) throw new Error("record URL must be https");
    const r = await fetch(u, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000), redirect: "error" });
    if (!r.ok) throw new Error(`record fetch HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > (opts.maxBytes ?? 65536)) throw new Error("record too large");
    return JSON.parse(text);
  };
}

function yyyymmdd(d: Date): number {
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export interface AdultProofResult {
  ok: boolean;
  reason?: string;
}

export async function verifyAdultProof(m: Mandate, client: ConcordiumGRPCClient, fetchRecord: RecordFetcher, network: "Testnet" | "Mainnet" = "Testnet", now = new Date()): Promise<AdultProofResult> {
  const p = m.adultProof;
  if (!p) return { ok: false, reason: "no adult proof in mandate" };
  let json: unknown;
  try {
    json = await fetchRecord(p.recordUrl);
  } catch (e) {
    return { ok: false, reason: `audit record unavailable: ${(e as Error).message}` };
  }
  if (sha256Hex(canonicalJson(json)) !== p.recordSha256) return { ok: false, reason: "audit record does not match the hash in the signed mandate" };
  const record = VerificationAuditRecordV1.fromJSON(json as VerificationAuditRecordV1.JSON);
  if (record.request.transactionRef.toString() !== p.vraTx) return { ok: false, reason: "audit record refers to a different VRA" };
  try {
    await VerificationAuditRecordV1.verifyAnchor(record, TransactionHash.fromHexString(p.vaaTx), client);
  } catch (e) {
    return { ok: false, reason: `VAA anchor check failed: ${(e as Error).message.slice(0, 120)}` };
  }
  try {
    await VerificationRequestV1.verifyAnchor(record.request, client);
  } catch (e) {
    return { ok: false, reason: `VRA anchor check failed: ${(e as Error).message.slice(0, 120)}` };
  }
  const v = await VerifiablePresentationV1.verifyWithNode(record.presentation, client, network);
  if (v.type !== "success") return { ok: false, reason: "zero-knowledge presentation did not verify" };

  const pj = record.presentation.toJSON() as unknown as {
    presentationContext: { given: Array<{ label: string; context: string }> };
    verifiableCredential: Array<{ type: string[]; credentialSubject: { id: string; statement: Array<{ type: string; attributeTag: string; lower?: string; upper?: string }> } }>;
  };
  const conn = pj.presentationContext.given.find((g) => g.label === "ConnectionID")?.context;
  if (conn !== `mandate:${m.id}`) return { ok: false, reason: "age proof was made for a different mandate" };
  const vc = pj.verifiableCredential[0];
  if (!vc || pj.verifiableCredential.length !== 1 || !vc.type.includes("ConcordiumAccountBasedCredential")) return { ok: false, reason: "age proof is not bound to an account credential" };
  const credId = /^did:ccd:(?:testnet|mainnet):cred:([0-9a-f]{96})$/.exec(vc.credentialSubject.id)?.[1];
  if (!credId) return { ok: false, reason: "unexpected credential subject id" };
  const holder = await client.getAccountInfo(CredentialRegistrationId.fromHexString(credId));
  if (holder.accountAddress.address !== m.issuer) return { ok: false, reason: "age proof belongs to a different account than the mandate issuer" };
  const dob = vc.credentialSubject.statement.find((s) => s.attributeTag === "dob" && s.type === "AttributeInRange");
  // Range statements prove lower <= dob < upper (upper exclusive). Born before (today - 18y + 1 day) means 18 or older today.
  const exclusiveCutoff = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate() + 1));
  if (!dob || Number(dob.upper) > yyyymmdd(exclusiveCutoff)) return { ok: false, reason: "proven statement does not imply age >= 18" };
  return { ok: true };
}
