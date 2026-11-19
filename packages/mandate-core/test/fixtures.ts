// Offline test fixtures: a fake human account (fresh ed25519 key wrapped as a Concordium AccountInfo) and a fake agent key.
import { AccountAddress, buildBasicAccountSigner, type AccountInfo } from "@concordium/web-sdk";
import * as ed from "@noble/ed25519";
import { CCD_TESTNET, randomNonce, toHex, type Mandate } from "../src/index.js";

export async function fakeHuman() {
  const { secretKey, publicKey } = await ed.keygenAsync();
  const addr = AccountAddress.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
  const info = {
    accountAddress: addr,
    accountThreshold: 1,
    accountCredentials: { 0: { value: { contents: { credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: "Ed25519", verifyKey: toHex(publicKey) } } } } } } },
  } as unknown as AccountInfo;
  return { address: addr.address, info, signer: buildBasicAccountSigner(toHex(secretKey)) };
}

export async function fakeAgent() {
  const { secretKey, publicKey } = await ed.keygenAsync();
  return { secretKey, publicKeyHex: toHex(publicKey) };
}

export function baseMandate(issuer: string, agentPubHex: string, nowS = Math.floor(Date.now() / 1000)): Mandate {
  return {
    v: 1,
    id: crypto.randomUUID(),
    network: CCD_TESTNET,
    issuer,
    agent: { contract: { index: "12802", subindex: "0" }, tokenId: "2000" },
    agentKey: { namespace: "solana:testnet", keyType: "ed25519", scheme: "solana-ed25519", publicKeyHex: agentPubHex },
    scope: { actions: ["signup", "post_comment", "buy_report"], domains: ["shop.localhost"], maxPerAction: { amount: "50000", asset: "CCD" }, maxTotal: { amount: "120000", asset: "CCD" } },
    notBefore: nowS - 60,
    expiry: nowS + 3600,
    nonce: randomNonce(),
  };
}
