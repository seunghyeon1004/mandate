# Mandate

A verified adult human gives an AI agent a scoped, expiring, revocable mandate. A website verifies the agent's signed request and the mandate against Concordium and lets the agent through instead of showing a CAPTCHA. Paid actions use x402 in CCD. Every action leaves an on-chain receipt. The human revokes in one transaction and the site sees it.

Status: core flow works end to end on Concordium **testnet** from the CLI (Gate 1, 2026-11-19). Evidence with explorer links: [docs/EVIDENCE.md](docs/EVIDENCE.md). Web console and demo UI are next.

## How a site verifies an agent (15 checks, no trust in us)

| Check | Against |
| --- | --- |
| request signature (method, URL, body hash, timestamp, nonce, mandate hash) | the agent key named in the mandate |
| freshness (60 s skew), replay (nonce) | verifier clock, replay store |
| validity window, action, domain, per-action and total spend caps | the signed mandate |
| human signature (`signMessage`) | the issuer account's keys on chain |
| mandate anchor `mandate:<id>` = `sha256:<hash>|exp:<unix>` (or `revoked`) | CIS-8004 agent metadata (MCP, gRPC fallback) |
| agent NFT owned by the issuer, active, its external reference is this key | CIS-8004 `agentOf` |
| agent key bound to the issuer | CIS-8 `ownerOfKey` (MCP, gRPC fallback) |
| verified adult: account-bound ZK proof of age >= 18 made for this mandate | VRA + VAA anchors, `verifyWithNode`, credential -> issuer account |

Each check reports which source answered (`mcp`, `grpc`, `cache`, `local`). If the hosted MCP is down the verifier still works over gRPC.

## Packages

- `packages/mandate-core`: mandate schema, JCS canonicalisation, hash/anchor, human and agent signatures, `verifyMandateRequest()`.
- `packages/mandate-chain`: Agent Registry access (schemas loaded at runtime from the deployed modules, start-up entrypoint check), MCP + gRPC reads, adult-proof re-verification, V1 sponsored transactions.
- `packages/mandate-verifier`: Express middleware for relying parties (replay, skew, scope, caps, bounded revocation cache, x402 payer binding).
- `apps/facilitator`: operator service: fee sponsor with an allow-list policy, self-hosted x402 facilitator for `ccd:*`, audit-record host.
- `apps/console`: issuer CLI (`register`, `issue`, `revoke`, `status`).
- `apps/demo-site`: relying party with free and x402-paid routes and on-chain receipts.
- `apps/agent`: agent runtime with one tool, `callWithMandate`.

## Run it (testnet)

Requires Node 24. Secrets are created outside the repo in `../.secrets` (testnet only).

```sh
npm install && npx tsc -b
# one-time: two testnet identities with invented attributes, four accounts (three get one faucet drop)
node scripts/setup/identity-start.mjs human && node scripts/setup/identity-form.mjs human Test Human 19900101 && node scripts/setup/identity-finish.mjs human human:0 agentWallet:1:faucet
node scripts/setup/identity-start.mjs operator && node scripts/setup/identity-form.mjs operator Test Operator 19850101 && node scripts/setup/identity-finish.mjs operator sponsor:0:faucet site:1:faucet
npm run operator &            # 127.0.0.1:4022
node apps/demo-site/src/main.ts &   # 127.0.0.1:4021
npm run mandate -- register   # CIS-8 key binding, CIS-8004 register, setAgentWallet (all sponsored)
npm run mandate -- issue      # age proof (VRA/VAA), human signature, anchor
node apps/agent/src/cli.ts signup && node apps/agent/src/cli.ts report
npm run mandate -- revoke && node apps/agent/src/cli.ts signup   # -> 403 revoked
npm test                      # unit, property and verifier table tests (offline)
npm run test:integration      # full flow on testnet, rewrites docs/EVIDENCE.md
```

## Honesty notes

- Testnet identities come from the self-service testnet identity provider with invented attributes. "Verified adult" on testnet proves the mechanism, not a real person.
- Spending limits are enforced off chain by each relying party's verifier; the on-chain receipts and payments are evidence after the fact. Protocol-Level Locks are not live and are not used.
- Replay store and spend ledger are in memory in this demo (single process). A multi-instance site needs a shared store.
- What existed before the build window (Nov 19): design notes and throwaway spikes, not part of this repository. The first commit is on 2026-11-19.
- Use of AI in development: this code was written by an AI coding agent (Claude) working under a human lead's direction and review; see commit trailers.

License: Apache-2.0.
