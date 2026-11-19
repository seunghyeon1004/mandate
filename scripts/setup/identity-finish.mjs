// Step 3: fetch the issued identity, deploy credentials (one account each) and optionally request faucet CCD once per account.
// usage: identity-finish.mjs <label> <role:credNumber[:faucet]>...   e.g. human human:0 agentWallet:1:faucet
// Account addresses are public; they go to ../.secrets/accounts.public.json. Keys are never written: they are derived from the seed.
import * as sdk from "@concordium/web-sdk";
import { grpc, ipInfo, readSecret, writeSecret, hasSecret, wallet, readAccounts, writeAccounts, WALLET_PROXY, j } from "./lib.mjs";
const [label, ...roles] = process.argv.slice(2);
const c = grpc(), ip = await ipInfo(0), w = wallet(label), ipId = 0, idIdx = 0;
if (!hasSecret(`${label}.identity.json`)) {
  const codeUri = readSecret(`${label}.code-uri.txt`).trim();
  let resp;
  for (let i = 0; i < 20; i++) { resp = await (await fetch(codeUri)).json(); if (resp.status !== "pending") break; await new Promise((r) => setTimeout(r, 3000)); }
  console.log("identity status:", resp.status);
  if (resp.status !== "done") throw new Error("identity not issued: " + String(resp.detail).slice(0, 120));
  writeSecret(`${label}.identity.json`, JSON.stringify(resp.token.identityObject));
}
const identity = JSON.parse(readSecret(`${label}.identity.json`));
const params = await c.getCryptographicParameters();
const accounts = readAccounts();
for (const spec of roles) {
  const [role, n, faucet] = spec.split(":"); const credNumber = Number(n);
  if (accounts[role]) { console.log(`${role}: exists ${accounts[role].address}`); continue; }
  const attributeRandomness = {};
  for (const k of Object.keys(sdk.AttributesKeys).filter((v) => isNaN(Number(v)))) attributeRandomness[k] = w.getAttributeCommitmentRandomness(ipId, idIdx, credNumber, sdk.AttributesKeys[k]).toString("hex");
  const input = { revealedAttributes: [], idObject: identity.value, globalContext: params, credNumber, ipInfo: ip.ipInfo, arsInfos: ip.arsInfos, attributeRandomness,
    credentialPublicKeys: { keys: { 0: { schemeId: "Ed25519", verifyKey: w.getAccountPublicKey(ipId, idIdx, credNumber).toString("hex") } }, threshold: 1 },
    idCredSec: w.getIdCredSec(ipId, idIdx).toString("hex"), prfKey: w.getPrfKey(ipId, idIdx).toString("hex"), sigRetrievelRandomness: w.getSignatureBlindingRandomness(ipId, idIdx).toString("hex") };
  const expiry = sdk.TransactionExpiry.fromDate(new Date(Date.now() + 300000));
  const payload = sdk.createCredentialPayloadNoSeed(input, expiry);
  const sig = await sdk.signCredentialTransaction(payload, w.getAccountSigningKey(ipId, idIdx, credNumber).toString("hex"));
  const hash = await c.sendCredentialDeploymentTransaction(sdk.serializeCredentialDeploymentPayload([sig], payload), expiry);
  const out = await c.waitForTransactionFinalization(hash, 120000);
  const info = await c.getAccountInfo(sdk.CredentialRegistrationId.fromHexString(payload.unsignedCdi.credId));
  accounts[role] = { address: info.accountAddress.address, identity: label, credNumber, credId: payload.unsignedCdi.credId, deployTx: hash.toString() };
  writeAccounts(accounts);
  console.log(`${role}: account ${info.accountAddress.address} (credential tx ${hash.toString()}, ${out.summary.type ?? "finalized"})`);
  if (faucet === "faucet") {
    const r = await fetch(`${WALLET_PROXY}/v0/testnetGTUDrop/${info.accountAddress.address}`, { method: "PUT" });
    console.log(`${role}: faucet HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  }
}
