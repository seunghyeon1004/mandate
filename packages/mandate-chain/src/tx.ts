// Transaction helpers: plain and protocol-level (V1) sponsored contract updates, and registerData receipts.
import {
  AccountAddress, CcdAmount, ContractAddress, DataBlob, Energy, ReceiveName, Parameter, TransactionExpiry, TransactionHash,
  type AccountSigner, type ConcordiumGRPCClient,
} from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { invoke, receiveName, serializeParams, toArrayBuffer, type ContractHandle } from "./contracts.js";

export interface AccountKey {
  account: string;
  signer: AccountSigner;
}

/** What a sender asks a sponsor to pay for. The sponsor builds the transaction itself from this, so it decides what it pays for. */
export interface SponsorRequest {
  sender: string;
  contract: { index: string; subindex: string };
  receiveName: string;
  parameterHex: string;
  energy: number;
}

/** Returns the sponsor-signed transaction as `Transaction.toJSONString` output; the sender then adds its own signature. */
export interface SponsorClient {
  sponsorContractUpdate(req: SponsorRequest): Promise<string>;
}

export interface TxOutcome {
  hash: string;
  ok: boolean;
  rejectReason?: string;
  /** Fee in micro-CCD. */
  cost?: string;
  /** Account that paid the fee (sponsor when sponsored). */
  feePayer?: string;
  sponsored?: boolean;
  blockHash?: string;
}

const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? String(v) : v));

async function submit(client: ConcordiumGRPCClient, signed: Transaction.Signable): Promise<TxOutcome> {
  const hash = await client.sendTransaction(Transaction.finalize(signed));
  return txOutcome(client, hash.toString());
}

/** Wait for (or look up) a transaction and summarise it: ok/rejected, fee, who paid the fee. */
export async function txOutcome(client: ConcordiumGRPCClient, hashHex: string): Promise<TxOutcome> {
  const hash = TransactionHash.fromHexString(hashHex);
  const out = await client.waitForTransactionFinalization(hash, 120_000);
  // Summary shape (web-sdk 12): { cost, sender, sponsor?: { cost, sponsor }, transactionType, rejectReason? }. For a sponsored
  // transaction `cost` is the sender's share (0) and `sponsor.cost` is what the sponsor paid.
  const s = out.summary as unknown as { transactionType?: string; rejectReason?: unknown; cost?: unknown; sender?: { address?: string }; sponsor?: { cost?: unknown; sponsor?: { address?: string } | string } };
  const failed = s.transactionType === "failed" || !!s.rejectReason;
  const amt = (c: unknown): string | undefined => (c === undefined || c === null ? undefined : typeof c === "object" && "microCcdAmount" in (c as object) ? String((c as { microCcdAmount: bigint }).microCcdAmount) : String(c));
  const sponsorAddr = typeof s.sponsor?.sponsor === "string" ? s.sponsor.sponsor : s.sponsor?.sponsor?.address;
  const cost = s.sponsor ? amt(s.sponsor.cost) : amt(s.cost);
  return {
    hash: hash.toString(),
    ok: !failed,
    ...(failed ? { rejectReason: j(s.rejectReason).slice(0, 300) } : {}),
    ...(cost !== undefined ? { cost } : {}),
    feePayer: sponsorAddr ?? s.sender?.address,
    ...(sponsorAddr ? { sponsored: true } : { sponsored: false }),
    blockHash: out.blockHash.toString(),
  };
}

/** Build and sponsor-sign a contract update (used by the sponsor service, and in-process in tests). */
export async function buildSponsoredContractUpdate(client: ConcordiumGRPCClient, sponsor: AccountKey, req: SponsorRequest): Promise<string> {
  const sender = AccountAddress.fromBase58(req.sender);
  const nonce = await client.getNextAccountNonce(sender);
  const tx = Transaction.updateContract(
    { amount: CcdAmount.zero(), address: ContractAddress.create(BigInt(req.contract.index), BigInt(req.contract.subindex)), receiveName: ReceiveName.fromString(req.receiveName), message: Parameter.fromHexString(req.parameterHex) },
    Energy.create(BigInt(req.energy)),
  )
    .addMetadata({ sender, nonce: nonce.nonce, expiry: TransactionExpiry.futureMinutes(5) })
    .addSponsor(AccountAddress.fromBase58(sponsor.account))
    .build();
  const sponsored = await Transaction.sponsor(tx, sponsor.signer);
  return Transaction.toJSONString(sponsored as unknown as Transaction.Type);
}

/** In-process sponsor (same rules as the HTTP service are applied by the service, not here). */
export function localSponsor(client: ConcordiumGRPCClient, sponsor: AccountKey): SponsorClient {
  return { sponsorContractUpdate: (req) => buildSponsoredContractUpdate(client, sponsor, req) };
}

export function httpSponsor(baseUrl: string): SponsorClient {
  return {
    async sponsorContractUpdate(req) {
      const r = await fetch(`${baseUrl}/sponsor/contract-update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(30_000) });
      const body = (await r.json()) as { transaction?: string; error?: string };
      if (!r.ok || !body.transaction) throw new Error(`sponsor refused: ${body.error ?? r.status}`);
      return body.transaction;
    },
  };
}

export interface ContractCall {
  handle: ContractHandle;
  entrypoint: string;
  params: unknown;
  energy?: number;
}

/**
 * Dry-run first (cheap, catches rejections without spending fees), then submit. With a sponsor, the sender pays nothing:
 * sponsor signs first, sender signs second (protocol-level V1 sponsored transaction).
 */
export async function sendContractUpdate(client: ConcordiumGRPCClient, call: ContractCall, sender: AccountKey, sponsor?: SponsorClient): Promise<TxOutcome> {
  await invoke(client, call.handle, call.entrypoint, call.params, sender.account);
  const parameter = serializeParams(call.handle, call.entrypoint, call.params);
  const energy = call.energy ?? 30_000;
  if (sponsor) {
    const json = await sponsor.sponsorContractUpdate({
      sender: sender.account,
      contract: { index: String(call.handle.address.index), subindex: String(call.handle.address.subindex) },
      receiveName: receiveName(call.handle, call.entrypoint).value,
      parameterHex: parameter.toString(),
      energy,
    });
    const sponsored = Transaction.fromJSONString(json, Transaction.signableFromJSON);
    const signed = await Transaction.sign(sponsored, sender.signer);
    return submit(client, signed);
  }
  const nonce = await client.getNextAccountNonce(AccountAddress.fromBase58(sender.account));
  const tx = Transaction.updateContract({ amount: CcdAmount.zero(), address: call.handle.address, receiveName: receiveName(call.handle, call.entrypoint), message: parameter }, Energy.create(BigInt(energy)))
    .addMetadata({ sender: AccountAddress.fromBase58(sender.account), nonce: nonce.nonce, expiry: TransactionExpiry.futureMinutes(5) })
    .build();
  return submit(client, await Transaction.sign(tx, sender.signer));
}

/** registerData (<= 256 bytes): used for action receipts. */
export async function registerData(client: ConcordiumGRPCClient, sender: AccountKey, data: Uint8Array, wait = true): Promise<TxOutcome> {
  if (data.length > 256) throw new RangeError(`registerData payload is ${data.length} bytes, max 256`);
  const nonce = await client.getNextAccountNonce(AccountAddress.fromBase58(sender.account));
  const tx = Transaction.registerData({ data: new DataBlob(toArrayBuffer(data)) })
    .addMetadata({ sender: AccountAddress.fromBase58(sender.account), nonce: nonce.nonce, expiry: TransactionExpiry.futureMinutes(5) })
    .build();
  const signed = await Transaction.sign(tx, sender.signer);
  if (wait) return submit(client, signed);
  const hash = await client.sendTransaction(Transaction.finalize(signed));
  return { hash: hash.toString(), ok: true };
}
