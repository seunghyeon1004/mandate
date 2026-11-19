// Action receipts: one registerData transaction per accepted action, sent by the site's own account (<= 256 bytes, no personal data).
// Format: MR1|<mandate sha256>|<action>|<sha256(request signature) first 16 hex>|<unix s>[|pay:<payment tx first 16 hex>]
import { registerData, type AccountKey } from "@mandate/chain";
import { sha256Hex } from "@mandate/core";
import type { ConcordiumGRPCClient } from "@concordium/web-sdk";

export interface Receipt {
  at: string;
  mandateId: string;
  mandateHash: string;
  action: string;
  text: string;
  tx: string;
  payment?: string;
}

export class Receipts {
  readonly list: Receipt[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly client: ConcordiumGRPCClient;
  private readonly site: AccountKey;
  constructor(client: ConcordiumGRPCClient, site: AccountKey) {
    this.client = client;
    this.site = site;
  }

  /** Submits without waiting for finalization; calls are serialised so account nonces never collide. Returns the tx hash. */
  record(r: { mandateId: string; mandateHash: string; action: string; signatureHeader: string; payment?: string }): Promise<Receipt> {
    const run = async () => {
      const sig = /s=([A-Za-z0-9_-]+)/.exec(r.signatureHeader)?.[1] ?? "";
      const text = `MR1|${r.mandateHash}|${r.action}|${sha256Hex(sig).slice(0, 16)}|${Math.floor(Date.now() / 1000)}${r.payment ? `|pay:${r.payment.slice(0, 16)}` : ""}`;
      const out = await registerData(this.client, this.site, new TextEncoder().encode(text), false);
      const rec: Receipt = { at: new Date().toISOString(), mandateId: r.mandateId, mandateHash: r.mandateHash, action: r.action, text, tx: out.hash, ...(r.payment ? { payment: r.payment } : {}) };
      this.list.push(rec);
      return rec;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}
