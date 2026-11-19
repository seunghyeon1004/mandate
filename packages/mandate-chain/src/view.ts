import { AccountAddress, type AccountInfo, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import type { ChainView, Mandate, Source, Sourced } from "@mandate/core";
import { verifyAdultProof, type RecordFetcher } from "./adult.js";
import type { Registry } from "./contracts.js";
import type { McpClient } from "./mcp.js";
import { grpcAgentOf, grpcGetMetadata, grpcOwnerOfKey, type AgentRecord, type ExternalKey, type KeyRecord } from "./reads.js";

export interface ChainViewOptions {
  client: ConcordiumGRPCClient;
  registry: Registry;
  /** Hosted Agent Registry MCP. When present and policy is "mcp-first", it answers first and gRPC is the fallback. */
  mcp?: McpClient | null;
  sourcePolicy?: "mcp-first" | "grpc-only";
  /**
   * Upper bound on how stale revocable state may be: mandate anchor, agent status, key binding.
   * A revocation finalized on chain is seen by this verifier at most this long afterwards. Default 10 s. 0 disables caching.
   */
  revocationBoundMs?: number;
  /** Cache for issuer account keys (used for the mandate signature). Default 60 s. */
  accountInfoTtlMs?: number;
  fetchRecord: RecordFetcher;
  network?: "Testnet" | "Mainnet";
  /** Called whenever MCP failed and gRPC answered instead. */
  onFallback?: (what: string, error: string) => void;
}

interface Entry<T> {
  value: T;
  at: number;
}

export interface SourceStats {
  mcp: number;
  grpc: number;
  cache: number;
  fallbacks: number;
}

/**
 * ChainView backed by Concordium testnet/mainnet. Positive and negative answers for revocable state are cached for at most
 * `revocationBoundMs`; adult-proof results are cached by (record hash, VAA tx) because the evidence is immutable.
 */
export class ConcordiumChainView implements ChainView {
  private cache = new Map<string, Entry<unknown>>();
  readonly stats: SourceStats = { mcp: 0, grpc: 0, cache: 0, fallbacks: 0 };
  readonly revocationBoundMs: number;

  private readonly o: ChainViewOptions;

  constructor(o: ChainViewOptions) {
    this.o = o;
    this.revocationBoundMs = o.revocationBoundMs ?? 10_000;
  }

  private cached<T>(key: string, ttl: number): Sourced<T> | null {
    const e = this.cache.get(key) as Entry<T> | undefined;
    if (e && Date.now() - e.at < ttl) {
      this.stats.cache++;
      return { value: e.value, source: "cache" };
    }
    return null;
  }

  private put<T>(key: string, value: T): void {
    this.cache.set(key, { value, at: Date.now() });
  }

  private async twoSource<T>(what: string, mcpFn: (() => Promise<T | undefined>) | null, grpcFn: () => Promise<T>): Promise<Sourced<T>> {
    if (mcpFn && this.o.mcp && (this.o.sourcePolicy ?? "mcp-first") === "mcp-first") {
      try {
        const v = await mcpFn();
        if (v !== undefined) {
          this.stats.mcp++;
          return { value: v, source: "mcp" };
        }
      } catch (e) {
        this.stats.fallbacks++;
        this.o.onFallback?.(what, String((e as Error).message ?? e));
      }
    }
    const v = await grpcFn();
    this.stats.grpc++;
    return { value: v, source: "grpc" };
  }

  /** Forget cached state (e.g. after this process itself submitted a revocation). */
  invalidate(prefix = ""): void {
    for (const k of this.cache.keys()) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  async accountInfo(address: string): Promise<Sourced<AccountInfo>> {
    const key = `acct:${address}`;
    const hit = this.cached<AccountInfo>(key, this.o.accountInfoTtlMs ?? 60_000);
    if (hit) return hit;
    const v = await this.o.client.getAccountInfo(AccountAddress.fromBase58(address));
    this.stats.grpc++;
    this.put(key, v);
    return { value: v, source: "grpc" };
  }

  async mandateAnchor(tokenId: string, k: string): Promise<Sourced<string | null>> {
    const key = `anchor:${tokenId}:${k}`;
    const hit = this.cached<string | null>(key, this.revocationBoundMs);
    if (hit) return hit;
    const r = await this.twoSource(`get_metadata(${tokenId},${k})`, () => this.o.mcp!.getMetadata(tokenId, k), () => grpcGetMetadata(this.o.client, this.o.registry, tokenId, k));
    this.put(key, r.value);
    return r;
  }

  async agent(tokenId: string): Promise<Sourced<AgentRecord | null>> {
    const key = `agent:${tokenId}`;
    const hit = this.cached<AgentRecord | null>(key, this.revocationBoundMs);
    if (hit) return hit;
    const r = await this.twoSource<AgentRecord | null>(
      `agent_of(${tokenId})`,
      async () => {
        const a = await this.o.mcp!.agentOf(tokenId);
        if (a === null) return null;
        if (a.externalKey === undefined) throw new Error("MCP agent_of does not report external_reference");
        const { tokenAddress: _t, ...rec } = a;
        return rec as AgentRecord;
      },
      () => grpcAgentOf(this.o.client, this.o.registry, tokenId),
    );
    this.put(key, r.value);
    return r;
  }

  async keyOwner(k: ExternalKey): Promise<Sourced<KeyRecord | null>> {
    const key = `key:${k.namespace}:${k.keyType}:${k.publicKeyHex}`;
    const hit = this.cached<KeyRecord | null>(key, this.revocationBoundMs);
    if (hit) return hit;
    const r = await this.twoSource(`owner_of_key(${k.publicKeyHex.slice(0, 8)})`, () => this.o.mcp!.ownerOfKey(k), () => grpcOwnerOfKey(this.o.client, this.o.registry, k));
    this.put(key, r.value);
    return r;
  }

  async adultProof(m: Mandate): Promise<Sourced<{ ok: boolean; reason?: string }>> {
    const p = m.adultProof;
    const key = `adult:${m.id}:${p?.recordSha256}:${p?.vaaTx}:${m.issuer}`;
    const hit = this.cached<{ ok: boolean; reason?: string }>(key, Number.POSITIVE_INFINITY);
    if (hit) return hit;
    const r = await verifyAdultProof(m, this.o.client, this.o.fetchRecord, this.o.network ?? "Testnet");
    this.stats.grpc++;
    if (r.ok) this.put(key, r); // only successes are cached; failures are re-checked
    return { value: r, source: "grpc" as Source };
  }
}
