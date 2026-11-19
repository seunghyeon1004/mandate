// Action receipts: one registerData transaction per accepted action, sent by the site's own account (<= 256 bytes, no personal data).
// Format: MR1|<mandate sha256>|<action>|<sha256(request signature) first 16 hex>|<unix s>
// A receipt is "submitted" when the node accepted it and "finalized" once it is in a finalized block (checked in the background).
import { registerData, txOutcome, type AccountKey } from "@mandate/chain";
import { sha256Hex } from "@mandate/core";
import type { ConcordiumGRPCClient } from "@concordium/web-sdk";

export interface Receipt {
  at: string;
  mandateId: string;
  mandateHash: string;
  action: string;
  text: string;
  tx: string;
  status: "submitted" | "finalized" | "failed";
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

  /** Submits without waiting for finalization (calls are serialised so account nonces never collide), then tracks finality. */
  record(r: { mandateId: string; mandateHash: string; action: string; signatureHeader: string }): Promise<Receipt> {
    const run = async () => {
      const sig = /s=([A-Za-z0-9_-]+)/.exec(r.signatureHeader)?.[1] ?? "";
      const text = `MR1|${r.mandateHash}|${r.action}|${sha256Hex(sig).slice(0, 16)}|${Math.floor(Date.now() / 1000)}`;
      const out = await registerData(this.client, this.site, new TextEncoder().encode(text), false);
      const rec: Receipt = { at: new Date().toISOString(), mandateId: r.mandateId, mandateHash: r.mandateHash, action: r.action, text, tx: out.hash, status: "submitted" };
      this.list.push(rec);
      void txOutcome(this.client, out.hash).then((o) => { rec.status = o.ok ? "finalized" : "failed"; }, () => { rec.status = "failed"; });
      return rec;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}
