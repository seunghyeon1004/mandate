#!/usr/bin/env node
// Scripted agent (deterministic, for tests and the video): agent <signup|comment|report|bundle|delete> [siteOrigin]
import { MandateAgent } from "./agent.ts";
import { accountKey, agentKey, state } from "@mandate/node";
import type { SignedMandate } from "@mandate/core";

const [cmd, origin = process.env.SITE_ORIGIN ?? "http://localhost:4021"] = process.argv.slice(2);
const cur = state<{ id: string }>("mandates/current.json");
if (!cur) throw new Error("no mandate issued");
const mandate = state<SignedMandate>(`mandates/${cur.id}.json`)!;
const k = await agentKey();
const agent = new MandateAgent({ mandate, agentSecretKey: k.secretKey, wallet: accountKey("agentWallet") });
const calls: Record<string, () => ReturnType<MandateAgent["callWithMandate"]>> = {
  signup: () => agent.callWithMandate(`${origin}/api/signup`, { json: { email: "agent@example.org" } }),
  comment: () => agent.callWithMandate(`${origin}/api/comment`, { json: { text: "Posted by an agent under a mandate." } }),
  report: () => agent.callWithMandate(`${origin}/api/premium-report`),
  bundle: () => agent.callWithMandate(`${origin}/api/premium-bundle`),
  delete: () => agent.callWithMandate(`${origin}/api/delete-account`, { json: {} }),
};
const fn = calls[cmd ?? ""];
if (!fn) { console.log(`usage: agent <${Object.keys(calls).join("|")}> [origin]`); process.exit(1); }
const r = await fn();
const { sentHeaders: _h, ...shown } = r;
console.log(JSON.stringify(shown, null, 2));
process.exit(0);
