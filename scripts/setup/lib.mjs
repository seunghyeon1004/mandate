// Shared helpers for testnet setup scripts. Secrets are read/written only under ../.secrets (chmod 600), never printed.
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { credentials } from "@grpc/grpc-js";
import * as sdk from "@concordium/web-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SECRETS = process.env.MANDATE_SECRETS_DIR ?? resolve(REPO, "..", ".secrets");
export const WALLET_PROXY = "https://wallet-proxy.testnet.concordium.com";
export const grpc = () => new ConcordiumGRPCNodeClient("grpc.testnet.concordium.com", 20000, credentials.createSsl());
export const j = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? String(v) : v));

export function secretPath(name) { return resolve(SECRETS, name); }
export function writeSecret(name, data) {
  if (!existsSync(SECRETS)) { mkdirSync(SECRETS, { recursive: true, mode: 0o700 }); }
  chmodSync(SECRETS, 0o700);
  writeFileSync(secretPath(name), data, { mode: 0o600 });
  chmodSync(secretPath(name), 0o600);
}
export function readSecret(name) { return readFileSync(secretPath(name), "utf8"); }
export function hasSecret(name) { return existsSync(secretPath(name)); }

/** Public account registry (addresses only, no keys). */
export function readAccounts() { return hasSecret("accounts.public.json") ? JSON.parse(readSecret("accounts.public.json")) : {}; }
export function writeAccounts(a) { writeSecret("accounts.public.json", JSON.stringify(a, null, 2)); }

export async function ipInfo(index = 0) {
  const ips = await (await fetch(`${WALLET_PROXY}/v1/ip_info`)).json();
  const ip = ips.find((x) => x.ipInfo.ipIdentity === index);
  if (!ip) throw new Error(`identity provider ${index} not found`);
  return ip;
}
export function wallet(label) { return sdk.ConcordiumHdWallet.fromSeedPhrase(readSecret(`${label}.seed.txt`).trim(), "Testnet"); }
