// Drop-in Express middleware for relying parties: accept agents that carry a valid Concordium mandate instead of a CAPTCHA.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  MANDATE_HEADER, SIGNATURE_HEADER, canonicalJson, sha256Hex, verifyMandateRequest,
  type Amount, type ChainView, type RejectionCode, type ReplayGuard, type SpendLedger, type VerifyPolicy, type VerifyResult,
} from "@mandate/core";

export type { VerifyResult, RejectionCode } from "@mandate/core";

/** In-memory replay guard. Single process only: a multi-instance deployment needs a shared store (e.g. Redis SET NX PX). */
export class MemoryReplayGuard implements ReplayGuard {
  private seen = new Map<string, number>();
  constructor(private readonly maxEntries = 100_000) {}
  async remember(key: string, expiresAtMs: number): Promise<boolean> {
    const now = Date.now();
    if (this.seen.size >= this.maxEntries) for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
    const exp = this.seen.get(key);
    if (exp !== undefined && exp >= now) return false;
    if (this.seen.size >= this.maxEntries) throw new Error("replay store full");
    this.seen.set(key, expiresAtMs);
    return true;
  }
}

export interface RecordingLedger extends SpendLedger {
  record(mandateHash: string, amount: bigint): Promise<void>;
}

/** In-memory spend ledger (per relying party, off chain). Production: a database row per mandate hash. */
export class MemoryLedger implements RecordingLedger {
  private totals = new Map<string, bigint>();
  async spent(h: string): Promise<bigint> {
    return this.totals.get(h) ?? 0n;
  }
  async record(h: string, amount: bigint): Promise<void> {
    this.totals.set(h, (this.totals.get(h) ?? 0n) + amount);
  }
}

export interface MandateVerifierOptions {
  chain: ChainView;
  policy: VerifyPolicy;
  replay?: ReplayGuard;
  ledger?: RecordingLedger;
  /** Public origin of this site (scheme://host[:port]) used to rebuild the signed URL. Required behind a proxy. */
  publicOrigin?: string;
  /** Called with every verification result (logging, receipts, metrics). */
  onResult?: (result: VerifyResult, req: Request, action: string) => void;
  now?: () => number;
}

const AUTH_ERRORS: RejectionCode[] = ["missing_headers", "bad_mandate", "bad_request_signature", "stale_request", "replay"];

export function statusFor(code: RejectionCode): number {
  if (code === "chain_unavailable") return 503;
  if (AUTH_ERRORS.includes(code)) return 401;
  return 403;
}

export interface RequireOptions {
  /** Price of the route if it is paid via x402 (checked against the mandate's caps before the 402 is ever shown). */
  price?: Amount;
}

interface PendingPayment {
  mandateHash: string;
  wallet: string | null;
  amount: bigint;
  at: number;
}

declare module "express-serve-static-core" {
  interface Locals {
    mandate?: VerifyResult;
  }
}

export class MandateVerifier {
  readonly replay: ReplayGuard;
  readonly ledger: RecordingLedger;
  private pending = new Map<string, PendingPayment>();

  constructor(private readonly o: MandateVerifierOptions) {
    this.replay = o.replay ?? new MemoryReplayGuard();
    this.ledger = o.ledger ?? new MemoryLedger();
  }

  /** Body parser that keeps the exact bytes (the agent signs the body hash). Mount it on mandate-protected routes. */
  static rawBody(limit = "100kb"): RequestHandler {
    return (req, res, next) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const max = parseInt(limit) * 1024;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > max) {
          res.status(413).json({ error: "body_too_large" });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
        next();
      });
      req.on("error", next);
    };
  }

  signedUrl(req: Request): string {
    const origin = this.o.publicOrigin ?? `${req.protocol}://${req.get("host")}`;
    return origin + req.originalUrl;
  }

  async verify(req: Request, action: string, opts: RequireOptions = {}): Promise<VerifyResult> {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    return verifyMandateRequest(
      {
        method: req.method,
        url: this.signedUrl(req),
        body: raw ? new Uint8Array(raw) : "",
        headers: { mandate: req.get(MANDATE_HEADER) ?? null, signature: req.get(SIGNATURE_HEADER) ?? null },
        action,
        ...(opts.price ? { price: opts.price } : {}),
        now: this.o.now?.() ?? Date.now(),
      },
      this.o.policy,
      { chain: this.o.chain, replay: this.replay, ledger: this.ledger },
    );
  }

  /**
   * Middleware: rejects with 401/403/503 and a JSON body listing every check, or calls next() with res.locals.mandate set.
   * On paid routes, mount this BEFORE the x402 middleware so an unauthorised agent never receives a payment request, and
   * register `x402Hooks` so only the agent's registered wallet can pay and spend is recorded after settlement.
   */
  require(action: string, opts: RequireOptions = {}): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
      let result: VerifyResult;
      try {
        result = await this.verify(req, action, opts);
      } catch (e) {
        res.status(503).json({ error: "chain_unavailable", reason: String((e as Error).message).slice(0, 200) });
        return;
      }
      this.o.onResult?.(result, req, action);
      res.locals.mandate = result;
      res.setHeader("Mandate-Result", result.ok ? "ok" : result.code!);
      if (!result.ok) {
        res.status(statusFor(result.code!)).json({ error: result.code, reason: result.reason, checks: result.checks });
        return;
      }
      if (opts.price) {
        const header = req.get("payment-signature") ?? req.get("x-payment");
        if (header) {
          try {
            const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
            this.prune();
            this.pending.set(sha256Hex(canonicalJson(payload)), { mandateHash: result.mandateHash!, wallet: result.mandate!.agentWallet ?? null, amount: BigInt(opts.price.amount), at: Date.now() });
          } catch {
            /* malformed payment header: x402 middleware will reject it */
          }
        }
      }
      next();
    };
  }

  private prune(): void {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [k, v] of this.pending) if (v.at < cutoff) this.pending.delete(k);
  }

  /**
   * Hooks for an x402 resource server (`@x402/core` x402ResourceServer):
   * - after verify: abort unless the payer is the wallet named in the mandate (and registered on chain as agentWallet);
   * - after settle: add the amount to the mandate's off-chain spend ledger.
   */
  x402Hooks<S extends { onAfterVerify(h: (c: any) => Promise<any>): S; onAfterSettle(h: (c: any) => Promise<void>): S }>(server: S, onSettled?: (info: { mandateHash: string; payer: string; transaction: string; amount: bigint }) => void): S {
    return server
      .onAfterVerify(async (ctx: { paymentPayload: unknown; result: { isValid: boolean; payer?: string } }) => {
        const p = this.pending.get(sha256Hex(canonicalJson(ctx.paymentPayload)));
        if (!p) return { abort: true, reason: "no_mandate_for_payment", message: "payment was not preceded by a verified mandate request" };
        if (!p.wallet) return { abort: true, reason: "mandate_has_no_wallet", message: "mandate does not name an agent wallet" };
        if (ctx.result.payer !== p.wallet) return { abort: true, reason: "payer_not_agent_wallet", message: `payer ${ctx.result.payer} is not the mandate's agent wallet` };
        return undefined;
      })
      .onAfterSettle(async (ctx: { paymentPayload: unknown; result: { success: boolean; payer?: string; transaction: string } }) => {
        const key = sha256Hex(canonicalJson(ctx.paymentPayload));
        const p = this.pending.get(key);
        if (!p || !ctx.result.success) return;
        this.pending.delete(key);
        await this.ledger.record(p.mandateHash, p.amount);
        onSettled?.({ mandateHash: p.mandateHash, payer: ctx.result.payer ?? "", transaction: ctx.result.transaction, amount: p.amount });
      });
  }
}
