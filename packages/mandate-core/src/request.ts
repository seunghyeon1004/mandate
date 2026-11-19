import * as ed from "@noble/ed25519";
import { base64url, canonicalJson, fromBase64url, fromHex, fromUtf8, sha256Hex, toHex, utf8 } from "./encoding.js";
import { mandateHash, type SignedMandate } from "./mandate.js";

export const MANDATE_HEADER = "mandate";
export const SIGNATURE_HEADER = "mandate-signature";
/** Upper bound for the encoded Mandate header. Keeps it far below common 8-16 KB header limits. */
export const MAX_MANDATE_HEADER_BYTES = 6144;

export interface RequestToSign {
  method: string;
  /** Absolute URL as the relying party sees it: scheme://host[:port]/path?query */
  url: string;
  body: Uint8Array | string;
  /** Unix milliseconds. */
  timestamp: number;
  /** Random hex, 32 chars (128 bits) or more. */
  nonce: string;
  mandateHash: string;
}

/** Bytes the agent key signs. Every field that could be swapped by an attacker is in here. */
export function signatureBase(r: RequestToSign): Uint8Array {
  const body = typeof r.body === "string" ? utf8(r.body) : r.body;
  return utf8(["mandate-request/v1", r.method.toUpperCase(), normaliseUrl(r.url), sha256Hex(body), String(r.timestamp), r.nonce, r.mandateHash].join("\n"));
}

export function normaliseUrl(u: string): string {
  const x = new URL(u);
  x.hash = "";
  return x.toString();
}

export async function signRequest(r: RequestToSign, agentSecretKey: Uint8Array): Promise<string> {
  return base64url(await ed.signAsync(signatureBase(r), agentSecretKey));
}

export async function verifyRequestSignature(r: RequestToSign, signatureB64url: string, publicKeyHex: string): Promise<boolean> {
  try {
    const sig = fromBase64url(signatureB64url);
    if (sig.length !== 64) return false;
    return await ed.verifyAsync(sig, signatureBase(r), fromHex(publicKeyHex));
  } catch {
    return false;
  }
}

export async function publicKeyHexFromSecret(agentSecretKey: Uint8Array): Promise<string> {
  return toHex(await ed.getPublicKeyAsync(agentSecretKey));
}

export interface ParsedSignatureHeader {
  timestamp: number;
  nonce: string;
  signature: string;
}

export function formatSignatureHeader(p: ParsedSignatureHeader): string {
  return `t=${p.timestamp}, n=${p.nonce}, s=${p.signature}`;
}

export function parseSignatureHeader(v: string | undefined | null): ParsedSignatureHeader | null {
  if (!v || v.length > 512) return null;
  const parts = Object.fromEntries(v.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = parts.t, n = parts.n, s = parts.s;
  if (!t || !/^[0-9]{1,16}$/.test(t) || !n || !/^[0-9a-f]{32,64}$/.test(n) || !s || !/^[A-Za-z0-9_-]{86}$/.test(s)) return null;
  return { timestamp: Number(t), nonce: n, signature: s };
}

export function encodeMandateHeader(sm: SignedMandate): string {
  return base64url(utf8(canonicalJson(sm)));
}

export function decodeMandateHeader(v: string | undefined | null): SignedMandate | null {
  if (!v || v.length > MAX_MANDATE_HEADER_BYTES) return null;
  try {
    const sm = JSON.parse(fromUtf8(fromBase64url(v))) as SignedMandate;
    return sm && typeof sm === "object" && sm.mandate && sm.signature ? sm : null;
  } catch {
    return null;
  }
}

export function randomNonce(bytes = 16): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

/** Build the two headers an agent sends. */
export async function buildMandateHeaders(
  sm: SignedMandate,
  req: { method: string; url: string; body?: Uint8Array | string },
  agentSecretKey: Uint8Array,
  now: number = Date.now(),
): Promise<Record<string, string>> {
  const nonce = randomNonce();
  const toSign: RequestToSign = { method: req.method, url: req.url, body: req.body ?? "", timestamp: now, nonce, mandateHash: mandateHash(sm.mandate) };
  const signature = await signRequest(toSign, agentSecretKey);
  return { [MANDATE_HEADER]: encodeMandateHeader(sm), [SIGNATURE_HEADER]: formatSignatureHeader({ timestamp: now, nonce, signature }) };
}
