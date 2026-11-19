// The agent side of Mandate. The agent holds: its ed25519 request key (bound to the human via CIS-8), the signed mandate, and the key of
// its own agent wallet (registered on the agent NFT via setAgentWallet). It never holds the human's key.
import { AccountAddress, type AccountSigner } from "@concordium/web-sdk";
import { buildMandateHeaders, mandateHash, type SignedMandate } from "@mandate/core";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";

export interface AgentConfig {
  mandate: SignedMandate;
  agentSecretKey: Uint8Array;
  wallet?: { account: string; signer: AccountSigner };
}

export interface CallResult {
  status: number;
  ok: boolean;
  body: unknown;
  mandateResult: string | null;
  /** Decoded x402 PAYMENT-RESPONSE header, when a payment settled. */
  payment: { success: boolean; transaction?: string; payer?: string; errorReason?: string } | null;
  /** The exact headers of the last attempt (used by tests to demonstrate replay rejection). */
  sentHeaders: Record<string, string>;
}

export class MandateAgent {
  private readonly cfg: AgentConfig;
  private readonly paidFetch: typeof fetch;
  private lastHeaders: Record<string, string> = {};

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
    // Every attempt (including the x402 retry carrying PAYMENT-SIGNATURE) gets a fresh mandate signature and nonce.
    const signedFetch: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
      const mh = await buildMandateHeaders(cfg.mandate, { method: req.method, url: req.url, body }, cfg.agentSecretKey);
      const headers = new Headers(req.headers);
      for (const [k, v] of Object.entries(mh)) headers.set(k, v);
      this.lastHeaders = Object.fromEntries(headers.entries());
      return fetch(req.url, { method: req.method, headers, ...(body ? { body } : {}) });
    };
    if (cfg.wallet) {
      const client = new x402Client().setSpendControls({ allowedAssets: true }).register(CONCORDIUM_TESTNET_CAIP2, new ExactConcordiumScheme({ accountAddress: AccountAddress.fromBase58(cfg.wallet.account), signer: cfg.wallet.signer }));
      this.paidFetch = wrapFetchWithPayment(signedFetch, client);
    } else this.paidFetch = signedFetch;
  }

  get mandateId(): string {
    return this.cfg.mandate.mandate.id;
  }

  get mandateHash(): string {
    return mandateHash(this.cfg.mandate.mandate);
  }

  /** The agent's single tool: call a URL under the mandate (pays x402 automatically within the mandate's caps, enforced by the site). */
  async callWithMandate(url: string, init: { method?: string; json?: unknown } = {}): Promise<CallResult> {
    const method = init.method ?? (init.json === undefined ? "GET" : "POST");
    const r = await this.paidFetch(url, { method, ...(init.json !== undefined ? { body: JSON.stringify(init.json), headers: { "content-type": "application/json" } } : {}) });
    const text = await r.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const pr = r.headers.get("payment-response");
    let payment: CallResult["payment"] = null;
    if (pr) { try { payment = JSON.parse(Buffer.from(pr, "base64").toString("utf8")); } catch { /* ignore */ } }
    return { status: r.status, ok: r.ok, body, mandateResult: r.headers.get("mandate-result"), payment, sentHeaders: { ...this.lastHeaders } };
  }
}
