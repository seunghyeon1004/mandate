#!/usr/bin/env node
// mandate CLI (TESTNET). Needs the operator service running for sponsored fees (apps/facilitator).
//   register                         one-time: CIS-8 key binding, CIS-8004 register, setAgentWallet
//   issue [--actions a,b] [--domains d] [--ttl s] [--max-per microCCD] [--max-total microCCD]
//   revoke [mandateId]
//   status [mandateId]
import { parseArgs } from "node:util";
import { anchorKey, anchorValue, mandateHash } from "@mandate/core";
import { context, explorerTx, state } from "@mandate/node";
import { anchorStatus, buildCard, issueMandate, loadMandate, pinCard, registerAgent, revokeMandate, sponsorClient, type AgentState } from "./issuer.ts";
import { REPO_ROOT, saveState } from "@mandate/node";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { actions: { type: "string", default: "signup,post_comment,buy_report" }, domains: { type: "string", default: "localhost" }, ttl: { type: "string", default: "3600" }, "max-per": { type: "string", default: "50000" }, "max-total": { type: "string", default: "120000" } },
});
const [cmd, arg] = positionals;
const ctx = await context();
const sponsor = sponsorClient();

switch (cmd) {
  case "register": {
    const a = await registerAgent(ctx, sponsor);
    console.log(JSON.stringify({ tokenId: a.tokenId, badge: a.badge, agentKey: a.agentKeyPublicHex, agentWallet: a.agentWallet, txs: Object.fromEntries(Object.entries(a.txs).map(([k, t]) => [k, explorerTx(t.hash)])) }, null, 2));
    break;
  }
  case "issue": {
    const agent = state<AgentState>("agent.json");
    if (!agent) throw new Error("run `mandate register` first");
    const r = await issueMandate(ctx, sponsor, agent, { actions: values.actions!.split(","), domains: values.domains!.split(","), ttlSeconds: Number(values.ttl), maxPerAction: values["max-per"]!, maxTotal: values["max-total"]! });
    console.log(JSON.stringify({ id: r.signed.mandate.id, hash: r.hash, vra: explorerTx(r.txs.vra), vaa: explorerTx(r.txs.vaa), anchor: explorerTx(r.txs.anchor.hash) }, null, 2));
    break;
  }
  case "revoke": {
    const sm = loadMandate(arg);
    const t = await revokeMandate(ctx, sponsor, sm.mandate);
    console.log(`revoked ${sm.mandate.id}: ${explorerTx(t.hash)}`);
    break;
  }
  case "status": {
    const sm = loadMandate(arg);
    console.log(JSON.stringify({ id: sm.mandate.id, hash: mandateHash(sm.mandate), key: anchorKey(sm.mandate.id), expected: anchorValue(sm.mandate), onChain: await anchorStatus(ctx, sm.mandate) }, null, 2));
    break;
  }
  case "card": {
    const agent = state<AgentState>("agent.json")!;
    const c = await buildCard(ctx, agent, REPO_ROOT);
    saveState("card.json", c);
    console.log(JSON.stringify(c, null, 2));
    break;
  }
  case "pin-card": {
    const agent = state<AgentState>("agent.json")!;
    const c = state<{ sha256: string }>("card.json")!;
    const r = await pinCard(ctx, sponsor, agent, c.sha256);
    saveState("card-pin.json", r);
    console.log(JSON.stringify({ setAgentURI: explorerTx(r.tx.hash), feePayer: r.tx.feePayer, servedSha256: r.servedSha, badge_valid: r.badge.badge_valid, issues: r.badge.issues, checks: r.badge.checks }, null, 2));
    break;
  }
  default:
    console.log("usage: mandate register | card | pin-card | issue [...] | revoke [id] | status [id]");
}
process.exit(0);
