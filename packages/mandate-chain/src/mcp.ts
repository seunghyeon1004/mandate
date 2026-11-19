// Minimal client for the hosted Concordium Agent Registry MCP service (JSON-RPC over HTTP) and its REST twins.
// Works in Node and in browsers (fetch only). Every call has a timeout so an outage degrades to the gRPC fallback quickly.
import type { AgentRecord, ExternalKey, KeyRecord } from "./reads.js";

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

export class McpClient {
  private session: string | null = null;
  private id = 1;
  private initialising: Promise<void> | null = null;

  constructor(readonly baseUrl: string, readonly network: "testnet" | "mainnet" | "devnet" = "testnet", readonly timeoutMs = 4000, private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  private async rpc(method: string, params?: unknown, notification = false): Promise<unknown> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;
    if (!notification) body.id = this.id++;
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.session) headers["mcp-session-id"] = this.session;
    const r = await this.fetchImpl(`${this.baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    const s = r.headers.get("mcp-session-id");
    if (s) this.session = s;
    if (!r.ok && r.status !== 202) throw new McpError(`MCP HTTP ${r.status}`);
    let t = await r.text();
    if (t.includes("data:")) t = t.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "";
    return t.trim() ? JSON.parse(t) : {};
  }

  private async ensureInit(): Promise<void> {
    if (this.session) return;
    this.initialising ??= (async () => {
      await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mandate", version: "0.1.0" } });
      await this.rpc("notifications/initialized", undefined, true);
    })().finally(() => (this.initialising = null));
    await this.initialising;
  }

  /** Call a tool; returns the parsed JSON text content. Throws McpError on transport errors and tool errors. */
  async call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureInit();
    const r = (await this.rpc("tools/call", { name: tool, arguments: { network: this.network, ...args } })) as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };
    if (r.error) throw new McpError(`MCP ${tool}: ${r.error.message ?? "error"}`);
    const text = r.result?.content?.[0]?.text;
    if (r.result?.isError) throw new McpError(`MCP ${tool}: ${String(text).slice(0, 200)}`);
    if (text === undefined) throw new McpError(`MCP ${tool}: empty result`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new McpError(`MCP ${tool}: non-JSON result ${text.slice(0, 120)}`);
    }
  }

  async rest<T = unknown>(path: string): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const r = await this.fetchImpl(`${this.baseUrl}${path}${sep}network=${this.network}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok) throw new McpError(`REST ${path}: HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  async getMetadata(tokenId: string, key: string): Promise<string | null> {
    const r = await this.call<{ value_text?: string; value_hex?: string } | null>("get_metadata", { token_id: tokenId, key });
    if (r === null) return null;
    if (typeof r.value_text === "string") return r.value_text;
    if (typeof r.value_hex === "string") return new TextDecoder().decode(Uint8Array.from(r.value_hex.match(/../g) ?? [], (h) => parseInt(h, 16)));
    throw new McpError("get_metadata: unexpected shape");
  }

  /** agent_of; `externalKey` is undefined when the service does not report the external reference. */
  async agentOf(tokenId: string): Promise<(Omit<AgentRecord, "externalKey"> & { externalKey?: AgentRecord["externalKey"]; tokenAddress: string }) | null> {
    const r = await this.call<Record<string, unknown> | null>("agent_of", { token_id: tokenId });
    if (r === null) return null;
    const ext = r.external_reference as { kind?: string; key_type?: string; namespace?: string; public_key_hex?: string; external_key?: { key_type: string; namespace: string; public_key_hex: string } } | null | undefined;
    let externalKey: AgentRecord["externalKey"] | undefined = undefined;
    if (ext === null) externalKey = null;
    else if (ext && typeof ext === "object") {
      const k = ext.external_key ?? (ext as { key_type: string; namespace: string; public_key_hex: string });
      externalKey = k.public_key_hex ? { namespace: k.namespace, keyType: k.key_type, publicKeyHex: k.public_key_hex.toLowerCase() } : undefined;
    }
    return {
      tokenAddress: String(r.token_address),
      owner: String(r.owner_account),
      status: String(r.status),
      wallet: (r.agent_wallet as string | null | undefined) ?? null,
      agentUri: (r.agent_uri as string | undefined) ?? null,
      metadataHashHex: (r.metadata_hash_hex as string | undefined) ?? null,
      ...(externalKey !== undefined ? { externalKey } : {}),
    };
  }

  async ownerOfKey(key: ExternalKey): Promise<KeyRecord | null> {
    const r = await this.call<{ owner?: string; status?: string } | null>("owner_of_key", { external_key: { namespace: key.namespace, key_type: key.keyType, public_key_hex: key.publicKeyHex } });
    if (r === null || !r.owner) return null;
    return { owner: r.owner, status: r.status ?? "Unknown" };
  }

  async checkBadge(badge: string): Promise<{ badge_valid: boolean; issues: unknown[]; checks: Record<string, boolean> }> {
    return this.rest(`/v1/check-badge/${encodeURIComponent(badge)}`);
  }
}
