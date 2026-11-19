import {
  ContractAddress, ContractName, EntrypointName, ReceiveName, Parameter, AccountAddress, Energy,
  serializeUpdateContractParameters, deserializeReceiveReturnValue, type ConcordiumGRPCClient,
} from "@concordium/web-sdk";

export const TESTNET = {
  network: "ccd:4221332d34e1694168c2a0c0b3fd0f27",
  grpcHost: "grpc.testnet.concordium.com",
  grpcPort: 20000,
  cis8004: { index: 12802n, subindex: 0n },
  cis8: { index: 12801n, subindex: 0n },
  mcpUrl: "https://agent-registry-mcp.concordium.com",
  indexerUrl: "https://agent-registry-indexer.concordium.com",
  explorer: "https://testnet.ccdscan.io",
} as const;

/** Entry points Mandate uses. Start-up fails loudly if any is missing from the deployed instance. */
export const REQUIRED_ENTRYPOINTS = {
  cis8004: ["register", "setMetadata", "getMetadata", "setAgentURI", "setAgentWallet", "agentOf", "revoke"],
  cis8: ["registerExternalKey", "ownerOfKey", "revoke"],
} as const;

export class RegistryStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryStartupError";
  }
}

export interface ContractHandle {
  address: ContractAddress.Type;
  name: string;
  moduleRef: string;
  schema: ArrayBuffer;
  entrypoints: string[];
}

/** Loads the contract's CURRENT module schema from chain (contracts can be upgraded in place; never hard-code a module ref). */
/** Node or proxy hiccups worth retrying (seen on testnet: "Received HTTP status code 502" at start-up). */
export function isTransientNodeError(e: unknown): boolean {
  return /HTTP status code 50[234]|\bUNAVAILABLE\b|ECONNRESET|ETIMEDOUT|DEADLINE_EXCEEDED/i.test(String((e as Error)?.message ?? e));
}

/** Retry `fn` on transient node errors only, waiting delaysMs[i] before retry i+1 (default: 2 retries, 500 ms then 1500 ms). */
export async function withNodeRetry<T>(fn: () => Promise<T>, delaysMs: readonly number[] = [500, 1500]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= delaysMs.length || !isTransientNodeError(e)) throw e;
      await new Promise((r) => setTimeout(r, delaysMs[i]));
    }
  }
}

export async function loadContract(client: ConcordiumGRPCClient, index: bigint, subindex: bigint, expectedName: string, required: readonly string[], retryDelaysMs?: readonly number[]): Promise<ContractHandle> {
  const address = ContractAddress.create(index, subindex);
  let info;
  try {
    info = await withNodeRetry(() => client.getInstanceInfo(address), retryDelaysMs);
  } catch (e) {
    throw new RegistryStartupError(`contract <${index},${subindex}> not readable: ${(e as Error).message}`);
  }
  const name = info.name.value.replace(/^init_/, "");
  if (name !== expectedName) throw new RegistryStartupError(`contract <${index},${subindex}> is "${name}", expected "${expectedName}"`);
  const entrypoints = info.methods.map((m) => m.value.slice(name.length + 1));
  const missing = required.filter((e) => !entrypoints.includes(e));
  if (missing.length) throw new RegistryStartupError(`contract ${name} <${index},${subindex}> (module ${info.sourceModule.moduleRef}) is missing entry points: ${missing.join(", ")}. The registry was changed; Mandate must be updated before use.`);
  let schema;
  try {
    schema = await withNodeRetry(() => client.getEmbeddedSchema(info.sourceModule), retryDelaysMs);
  } catch (e) {
    throw new RegistryStartupError(`contract ${name} module ${info.sourceModule.moduleRef} schema not readable: ${(e as Error).message}`);
  }
  if (!schema) throw new RegistryStartupError(`contract ${name} module ${info.sourceModule.moduleRef} has no embedded schema`);
  return { address, name, moduleRef: info.sourceModule.moduleRef, schema: toArrayBuffer(schema.buffer), entrypoints };
}

export interface Registry {
  cis8004: ContractHandle;
  cis8: ContractHandle;
}

export async function loadRegistry(client: ConcordiumGRPCClient, cfg: { cis8004: { index: bigint; subindex: bigint }; cis8: { index: bigint; subindex: bigint } } = TESTNET): Promise<Registry> {
  const [cis8004, cis8] = await Promise.all([
    loadContract(client, cfg.cis8004.index, cfg.cis8004.subindex, "CIS-8004", REQUIRED_ENTRYPOINTS.cis8004),
    loadContract(client, cfg.cis8.index, cfg.cis8.subindex, "CIS-8", REQUIRED_ENTRYPOINTS.cis8),
  ]);
  return { cis8004, cis8 };
}

export function serializeParams(h: ContractHandle, entrypoint: string, params: unknown): Parameter.Type {
  return serializeUpdateContractParameters(ContractName.fromString(h.name), EntrypointName.fromString(entrypoint), params, h.schema);
}

export function receiveName(h: ContractHandle, entrypoint: string): ReceiveName.Type {
  return ReceiveName.create(ContractName.fromString(h.name), EntrypointName.fromString(entrypoint));
}

export class ContractRejected extends Error {
  readonly reason: unknown;
  constructor(reason: unknown) {
    super(`contract rejected: ${JSON.stringify(reason, (_k, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 300)}`);
    this.reason = reason;
  }
}

/** Dry-run / read an entry point and decode its return value with the contract's own schema. */
export async function invoke(client: ConcordiumGRPCClient, h: ContractHandle, entrypoint: string, params: unknown, invoker?: string): Promise<unknown> {
  const r = await client.invokeContract({
    contract: h.address,
    method: receiveName(h, entrypoint),
    parameter: serializeParams(h, entrypoint, params),
    ...(invoker ? { invoker: AccountAddress.fromBase58(invoker) } : {}),
    energy: Energy.create(100_000n),
  });
  if (r.tag !== "success") throw new ContractRejected(r.reason);
  if (!r.returnValue || r.returnValue.buffer.length === 0) return undefined;
  try {
    return decodeReturn(h, entrypoint, r.returnValue.buffer);
  } catch (e) {
    // State-changing entry points (e.g. registerExternalKey) declare no return value schema; a successful dry-run is all we need.
    if (/no return value schema/i.test(String((e as Error).message))) return undefined;
    throw e;
  }
}

function decodeReturn(h: ContractHandle, entrypoint: string, buf: Uint8Array): unknown {
  return deserializeReceiveReturnValue(toArrayBuffer(buf), h.schema, ContractName.fromString(h.name), EntrypointName.fromString(entrypoint));
}

/** CIS-8004 token ids on the wire: lowercase hex of the u64 little-endian bytes. */
export function tokenIdHex(tokenId: string | bigint): string {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(tokenId), true);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Copy a byte view into a standalone ArrayBuffer (SDK APIs differ in which they accept). */
export function toArrayBuffer(b: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (b instanceof ArrayBuffer) return b;
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
}

export function hexToBytes(h: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

export function bytesToHex(b: ArrayLike<number | string>): string {
  return Array.from(b, (x) => Number(x).toString(16).padStart(2, "0")).join("");
}

/** Schema enums decode as {"Variant": [...]}; return the variant name. */
export function enumTag(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return Object.keys(v)[0] ?? "Unknown";
  return "Unknown";
}

/** Option<T> decodes as {"Some":[T]} | {"None":[]}. */
export function option<T>(v: unknown): T | null {
  if (v && typeof v === "object" && "Some" in (v as object)) return ((v as { Some: T[] }).Some[0] ?? null) as T | null;
  return null;
}
