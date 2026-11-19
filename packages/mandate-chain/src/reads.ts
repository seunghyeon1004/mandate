import type { ConcordiumGRPCClient } from "@concordium/web-sdk";
import { bytesToHex, enumTag, hexToBytes, invoke, option, tokenIdHex, type Registry } from "./contracts.js";

export interface AgentRecord {
  owner: string;
  status: string;
  wallet: string | null;
  externalKey: { namespace: string; keyType: string; publicKeyHex: string } | null;
  agentUri: string | null;
  metadataHashHex: string | null;
}

export interface KeyRecord {
  owner: string;
  status: string;
}

export interface ExternalKey {
  namespace: string;
  keyType: string;
  publicKeyHex: string;
}

const dec = new TextDecoder();

/** CIS-8004.getMetadata through gRPC. Returns the UTF-8 value or null when the key is not set. */
export async function grpcGetMetadata(client: ConcordiumGRPCClient, reg: Registry, tokenId: string, key: string): Promise<string | null> {
  const v = option<Array<number | string>>(await invoke(client, reg.cis8004, "getMetadata", { key, token_id: tokenIdHex(tokenId) }));
  return v === null ? null : dec.decode(Uint8Array.from(v, Number));
}

interface RawAgent {
  owner_account: string;
  status: unknown;
  agent_wallet: unknown;
  agent_uri: unknown;
  metadata_hash: unknown;
  external_reference: unknown;
}

/** CIS-8004.agentOf through gRPC, normalised. */
export async function grpcAgentOf(client: ConcordiumGRPCClient, reg: Registry, tokenId: string): Promise<AgentRecord | null> {
  const raw = option<RawAgent>(await invoke(client, reg.cis8004, "agentOf", tokenIdHex(tokenId)));
  if (!raw) return null;
  const ext = option<{ kind: unknown }>(raw.external_reference);
  let externalKey: AgentRecord["externalKey"] = null;
  if (ext && enumTag(ext.kind) === "Cis8") {
    const k = (ext.kind as { Cis8: Array<{ key_type: string; namespace: string; public_key: Array<number | string> }> }).Cis8[0]!;
    externalKey = { namespace: k.namespace, keyType: k.key_type, publicKeyHex: bytesToHex(k.public_key) };
  }
  const mh = option<Array<number | string>>(raw.metadata_hash);
  return {
    owner: raw.owner_account,
    status: enumTag(raw.status),
    wallet: option<string>(raw.agent_wallet),
    externalKey,
    agentUri: option<string>(raw.agent_uri),
    metadataHashHex: mh ? bytesToHex(mh) : null,
  };
}

/** CIS-8.ownerOfKey through gRPC, normalised. */
export async function grpcOwnerOfKey(client: ConcordiumGRPCClient, reg: Registry, key: ExternalKey): Promise<KeyRecord | null> {
  const raw = option<{ owner: string; status?: unknown }>(await invoke(client, reg.cis8, "ownerOfKey", { external_key: { key_type: key.keyType, namespace: key.namespace, public_key: hexToBytes(key.publicKeyHex) } }));
  if (!raw) return null;
  return { owner: raw.owner, status: raw.status === undefined ? "Active" : enumTag(raw.status) };
}
