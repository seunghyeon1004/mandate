// What the sponsor is willing to pay for. Anything else is refused before a signature is produced.
import type { SponsorRequest } from "@mandate/chain";

export interface SponsorPolicy {
  /** "<index>,<subindex>" -> allowed receive names */
  contracts: Record<string, string[]>;
  maxEnergy: number;
  maxParameterBytes: number;
  /** Empty = any sender. */
  allowedSenders: string[];
  /** Max sponsored transactions per sender per window. */
  rateLimit: { count: number; windowMs: number };
}

export function defaultPolicy(allowedSenders: string[]): SponsorPolicy {
  return {
    contracts: {
      "12802,0": ["CIS-8004.register", "CIS-8004.setMetadata", "CIS-8004.setAgentURI", "CIS-8004.setAgentWallet", "CIS-8004.revoke"],
      "12801,0": ["CIS-8.registerExternalKey", "CIS-8.revoke"],
    },
    maxEnergy: 30_000,
    maxParameterBytes: 2048,
    allowedSenders,
    rateLimit: { count: 30, windowMs: 10 * 60_000 },
  };
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly count: number;
  private readonly windowMs: number;
  constructor(count: number, windowMs: number) {
    this.count = count;
    this.windowMs = windowMs;
  }
  allow(key: string, now = Date.now()): boolean {
    const h = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (h.length >= this.count) { this.hits.set(key, h); return false; }
    h.push(now);
    this.hits.set(key, h);
    return true;
  }
}

/** Returns null when allowed, else the refusal reason. */
export function checkPolicy(p: SponsorPolicy, r: SponsorRequest): string | null {
  const key = `${r.contract.index},${r.contract.subindex}`;
  const allowed = p.contracts[key];
  if (!allowed) return `contract <${key}> is not sponsored`;
  if (!allowed.includes(r.receiveName)) return `${r.receiveName} is not sponsored`;
  if (!Number.isInteger(r.energy) || r.energy <= 0 || r.energy > p.maxEnergy) return `energy must be 1..${p.maxEnergy}`;
  if (!/^(?:[0-9a-f]{2})*$/.test(r.parameterHex) || r.parameterHex.length / 2 > p.maxParameterBytes) return `parameter must be hex and at most ${p.maxParameterBytes} bytes`;
  if (p.allowedSenders.length && !p.allowedSenders.includes(r.sender)) return "sender is not enrolled for sponsorship";
  return null;
}
