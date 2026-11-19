// Local, Node-only configuration for the demo apps and CLI. TESTNET ONLY.
// Secrets live in MANDATE_SECRETS_DIR (default ../.secrets next to the repo): seed phrases, identity objects, the agent key.
// This module derives signers in memory and never logs or returns secret material as text.
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { credentials } from "@grpc/grpc-js";
import { AccountAddress, ConcordiumHdWallet, buildBasicAccountSigner, type AccountSigner } from "@concordium/web-sdk";
import * as ed from "@noble/ed25519";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TESTNET, loadRegistry, McpClient, ConcordiumChainView, defaultRecordFetcher, type Registry, type AccountKey } from "@mandate/chain";
import { toHex, fromHex } from "@mandate/core";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..", "..");
export const SECRETS_DIR = process.env.MANDATE_SECRETS_DIR ?? resolve(REPO_ROOT, "..", ".secrets");
/** Non-secret runtime state (mandates, audit records, evidence logs): outside the repo by default. */
export const STATE_DIR = process.env.MANDATE_STATE_DIR ?? resolve(REPO_ROOT, "..", ".state");

export type Role = "human" | "agentWallet" | "sponsor" | "site";

export interface AccountEntry {
  address: string;
  identity: string;
  credNumber: number;
  credId: string;
}

function secretFile(name: string): string {
  return resolve(SECRETS_DIR, name);
}

export function readAccounts(): Record<Role, AccountEntry> {
  const p = secretFile("accounts.public.json");
  if (!existsSync(p)) throw new Error(`no accounts file at ${p}; run scripts/setup/identity-*.mjs first`);
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Account signer for a role, derived from that identity's seed (testnet). */
export function accountKey(role: Role): AccountKey {
  const a = readAccounts()[role];
  if (!a) throw new Error(`no account for role ${role}`);
  const seed = readFileSync(secretFile(`${a.identity}.seed.txt`), "utf8").trim();
  const w = ConcordiumHdWallet.fromSeedPhrase(seed, "Testnet");
  const signer: AccountSigner = buildBasicAccountSigner(w.getAccountSigningKey(0, 0, a.credNumber).toString("hex"));
  return { account: AccountAddress.fromBase58(a.address).address, signer };
}

/** Raw ed25519 account key (for proofs that need a raw signature, e.g. setAgentWallet). Kept in memory only. */
export function rawAccountSecret(role: Role): Uint8Array {
  const a = readAccounts()[role];
  const seed = readFileSync(secretFile(`${a.identity}.seed.txt`), "utf8").trim();
  return new Uint8Array(ConcordiumHdWallet.fromSeedPhrase(seed, "Testnet").getAccountSigningKey(0, 0, a.credNumber));
}

/** The agent's request-signing key (ed25519), created once. Returns the public key hex and a signing secret held in memory. */
export async function agentKey(create = false): Promise<{ publicKeyHex: string; secretKey: Uint8Array }> {
  const p = secretFile("agent.ed25519.json");
  if (!existsSync(p)) {
    if (!create) throw new Error("no agent key; run the register command first");
    const { secretKey } = await ed.keygenAsync();
    mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify({ kind: "ed25519", network: "testnet", secretKeyHex: toHex(secretKey) }), { mode: 0o600 });
    chmodSync(p, 0o600);
  }
  const secretKey = fromHex(JSON.parse(readFileSync(p, "utf8")).secretKeyHex);
  return { publicKeyHex: toHex(await ed.getPublicKeyAsync(secretKey)), secretKey };
}

export function grpcClient(): ConcordiumGRPCNodeClient {
  return new ConcordiumGRPCNodeClient(TESTNET.grpcHost, TESTNET.grpcPort, credentials.createSsl());
}

export function state<T>(name: string): T | null {
  const p = resolve(STATE_DIR, name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
}

export function saveState(name: string, value: unknown): string {
  mkdirSync(dirname(resolve(STATE_DIR, name)), { recursive: true });
  const p = resolve(STATE_DIR, name);
  writeFileSync(p, JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2));
  return p;
}

export interface Ctx {
  client: ConcordiumGRPCNodeClient;
  registry: Registry;
  mcp: McpClient;
}

export async function context(mcpUrl: string = process.env.MANDATE_MCP_URL ?? TESTNET.mcpUrl): Promise<Ctx> {
  const client = grpcClient();
  const registry = await loadRegistry(client);
  return { client, registry, mcp: new McpClient(mcpUrl, "testnet", Number(process.env.MANDATE_MCP_TIMEOUT_MS ?? 4000)) };
}

export function chainView(ctx: Ctx, opts: { allowHttpLocalhost?: boolean; revocationBoundMs?: number; onFallback?: (w: string, e: string) => void } = {}): ConcordiumChainView {
  return new ConcordiumChainView({
    client: ctx.client,
    registry: ctx.registry,
    mcp: ctx.mcp,
    fetchRecord: defaultRecordFetcher({ allowHttpLocalhost: opts.allowHttpLocalhost ?? true }),
    ...(opts.revocationBoundMs !== undefined ? { revocationBoundMs: opts.revocationBoundMs } : {}),
    ...(opts.onFallback ? { onFallback: opts.onFallback } : {}),
  });
}

export const explorerTx = (h: string) => `${TESTNET.explorer}/?dcount=1&dentity=transaction&dhash=${h}`;
export const explorerAccount = (a: string) => `${TESTNET.explorer}/?dcount=1&dentity=account&daddress=${a}`;
export const ccdexplorerTx = (h: string) => `https://ccdexplorer.io/testnet/transaction/${h}`;
export const ccdexplorerAccount = (a: string) => `https://ccdexplorer.io/testnet/account/${a}`;
