// Step 1 of a testnet identity: create a NEW throwaway seed for <label> (refuses to overwrite) and request issuance at IdP 0.
// Writes the IdP form URL to ../.secrets/<label>.idp-start.txt (contains no key material, but kept out of git).
import * as sdk from "@concordium/web-sdk";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { grpc, ipInfo, writeSecret, hasSecret, wallet } from "./lib.mjs";
const label = process.argv[2];
if (!/^[a-z0-9-]+$/.test(label ?? "")) throw new Error("usage: identity-start.mjs <label>");
if (!hasSecret(`${label}.seed.txt`)) { writeSecret(`${label}.seed.txt`, generateMnemonic(wordlist, 256)); console.log(`new seed written for ${label} (not shown)`); }
const c = grpc(), ip = await ipInfo(0), w = wallet(label), ipId = 0, idx = 0;
const req = sdk.createIdentityRequestWithKeys({
  arsInfos: ip.arsInfos, arThreshold: Math.min(Object.keys(ip.arsInfos).length - 1, 255), ipInfo: ip.ipInfo, globalContext: await c.getCryptographicParameters(),
  idCredSec: w.getIdCredSec(ipId, idx).toString("hex"), prfKey: w.getPrfKey(ipId, idx).toString("hex"), blindingRandomness: w.getSignatureBlindingRandomness(ipId, idx).toString("hex"),
});
const qs = new URLSearchParams({ scope: "identity", response_type: "code", redirect_uri: "http://127.0.0.1:8765/cb", state: JSON.stringify({ idObjectRequest: req }) });
const res = await fetch(`${ip.metadata.issuanceStart}?${qs}`, { redirect: "manual" });
const loc = res.headers.get("location");
console.log("issuanceStart status", res.status, "form host:", loc ? new URL(loc).host : "none");
if (!loc) throw new Error("no redirect from IdP");
writeSecret(`${label}.idp-start.txt`, loc);
