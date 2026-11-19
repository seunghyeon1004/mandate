# NOTES: verified facts and decisions

Every line here was checked by running a command on the date shown. Testnet only. Gate 0 scripts and raw output are outside the repo in `../.g0/`.

## Gate 0 re-verification (2026-11-19, ~00:20 UTC)

### Packages (npm registry)
| Package | Version pinned | Note |
| --- | --- | --- |
| `@concordium/web-sdk` | 12.0.2 | unchanged since Nov 5 (latest) |
| `@x402/concordium`, `@x402/core`, `@x402/express`, `@x402/fetch` | 2.31.0 | published 2026-11-12. `@x402/concordium` dist is byte-identical to 2.30.0 (`diff -rq` empty). `@x402/core` changed (new `prepareHttpServer`); the APIs we use (`x402Facilitator`, `x402ResourceServer`, `paymentMiddleware`, `x402Client.setSpendControls`) still exist. Paid flow to be re-run at Gate 1. |
| `@concordium/browser-wallet-api-helpers` | 3.3.0 | unchanged |
| `@concordium/wallet-connectors` | 0.9.0 | unchanged |
| `@concordium/verification-web-ui` | 0.2.1 | only needed for a live wallet QR moment |
| `typescript` | 7.0.2 | `tsc -b` on the skeleton passes |
| `vitest` | 5.1.1 | Node `^24` supported |
| `@playwright/test` / `@axe-core/playwright` | 1.65.1 / 4.14.0 | bundled Chromium only |
| `express` | 5.3.0 | |

### Testnet
- gRPC `grpc.testnet.concordium.com:20000`: genesis `4221332d34e1694168c2a0c0b3fd0f27...`, protocol version 10 (unchanged).
- CIS-8004 still at `<12802,0>`, CIS-8 still at `<12801,0>`.
- **Change since Nov 5:** the CIS-8004 instance was upgraded. Module is now `0e57473715d1c2a364fa626b8783688db32b7fac9d0e2fc97043da91e1a7d3eb` (was `142462ff...a5c6`). Entry points and parameter schemas of `register`, `setMetadata`, `getMetadata`, `revoke`, `setAgentURI`, `agentOf` are identical; the only schema difference is an added error schema for `migrate`. State was migrated: `getMetadata(1005, "mandate:m1")` still returns the Nov 5 value.
  Decision: never hard-code a module ref. Read the schema from `getInstanceInfo(...).sourceModule` at start-up.
- CIS-8 module unchanged (`3236c12f...9afd`).
- Agents registered on testnet: 1259 (`list_agents` total).

### Hosted Agent Registry MCP (`https://agent-registry-mcp.concordium.com/mcp`)
| Nov 5 bug | Status 2026-11-19 | Evidence |
| --- | --- | --- |
| 1. `build_cis8_register` used entry point `register` | **Fixed.** Returns `receive_name: "CIS-8.registerExternalKey"` and `parameter_hex`. Dry-run (`invokeContract`, no tx) of the MCP-built parameter with a fresh ed25519 key: valid signature -> `success` (1722 NRG), tampered -> `RejectedReceive` | `.g0/mcp3.out.txt` |
| 2. `get_metadata` sent `token_id` as a number | **Fixed.** `get_metadata(token_id "1005" or 1005, "mandate:m1")` returns `value_text` | `.g0/mcp.out.txt` |
| 3. Docker image `concordium/agent-registry-mcp` not public | **Still present.** Docker Hub repo API 404, registry manifest 401 | curl output |

Decision: use the MCP builders and reads where they work, but keep our own gRPC paths for `getMetadata` and CIS-8 serialization as a fallback, and cross-check MCP output against our own serialization in tests (the service could regress again).

- Testnet Indexer is public: `https://agent-registry-indexer.concordium.com` (`/agents/:id/history`, `/events/recent`, `/cis8/keys`).
- CORS from a GitHub Pages origin: gRPC-web on the testnet node allows it (preflight 200, origin echoed), MCP REST and Indexer send `access-control-allow-origin: *`. A static page can verify against testnet with no backend of ours.
- Docs pages for MCP service, CIS-8 and the sponsor service are textually unchanged since Nov 5. The `how-to/integrations/x402-integration` page is conceptual only (no SDK detail; describes a ZKP-in-facilitator variant that `@x402/concordium` does not implement).

### Workshops 3, 5, 6
Logged-out event pages show only agenda and attachment titles; "Summary" and "Watch Recording" need an Encode login. No public recordings found by web search. Not verified beyond agendas:
- W3: PLTs, x402 on Concordium, sponsored tx, agent-to-agent payment demo. Matches the design (native CCD, own facilitator).
- W5: LEI business identity, Dfns wallets-as-a-service, wallet SDKs (Tether WDK), "sponsorship limits and the economics for enterprises". Feeds the path-to-production note; no design change.
- W6: Agent Registry MCP, A2A, agent swarms and marketplaces, interface roadmap. No design change.

## Decisions
- Monorepo with npm workspaces (pnpm not installed; not needed).
- Commit trailer: see Gate 0 report (open question to the lead).

## Gate 1 findings (2026-11-19, testnet, each found by running it)

### Accounts (new, throwaway, testnet only)
Two identities from the self-service IdP 0 form, filled with Playwright's bundled Chromium with invented values ("Test Human" DOB 1990-01-01, "Test Operator" DOB 1985-01-01, document number TEST-0001). Seeds are in `../.secrets` (chmod 600), never in the repo.
| Role | Account | Funded |
| --- | --- | --- |
| human (issuer, NFT owner) | `4jjXocyWa2vkaRjW7BAvQEvF8zzjrLRrktDFjExXkzKMKztn3b` | no: 0 CCD, all its transactions are sponsored |
| agentWallet | `4CZmvBRju8WLtp2mrbqeZvGJ5jmPyX9p3xuNfWLHmqdfManc6U` | one faucet drop |
| sponsor / facilitator / verifier | `3jBkXyEm6pSUwXqvyFptgtg3xN3LdBcSfmcnguGdtNtn7bJgnT` | one faucet drop |
| site (payee, receipts) | `4KGQ9ExEqXKjrEMDsqf6WJtVCyFxC4g1qYCShPsni2UyMa7yey` | one faucet drop |
Agent token 1261, badge `JyP9YMpKL9vhHC2hgA2pc`.

### Protocol and registry details not in the docs
- **setAgentWallet proof for a native Concordium wallet**: ed25519 signature by the wallet account's key over the bytes from MCP `set_agent_wallet_canonical_bytes`, serialized as concordium-std `AccountSignatures` = `01 00 01 00 00 || sig64`. Raw 64-byte signature, SHA-256 pre-hash and the `signMessage` digest all reject with `-7212`. Found by dry-run of 9 combinations.
- `set_agent_wallet_canonical_bytes` returns **162** bytes (its tool description says 122): prefix(26) + token u64 LE + owner(32) + new wallet(32) + 8 bytes (zero; looks like the wallet nonce) + deadline u64 LE + contract address(16) + genesis hash(32).
- `CIS-8004.register` accepts `external_reference = Cis8 key` when that key is already bound to the sender through CIS-8; `agentByExternalReference` then returns the **full agent record** (with `token_id` as LE hex), not just an id.
- MCP `agent_of` does **not** return `external_reference` (4th MCP gap). The verifier therefore reads the agent record over gRPC; `get_metadata` and `owner_of_key` are answered by MCP. Shown per check in the result (`source`).
- Sponsored transaction summary (web-sdk 12): `cost` is the sender's share ("0") and `sponsor: { cost, sponsor }` holds what the sponsor paid.
- Entry points without a return-value schema (e.g. `registerExternalKey`) make `deserializeReceiveReturnValue` throw; a successful dry-run is enough there.
- Account-bound age claims work: `claimsBuilder().addAccountClaims(...)` + `createAccountClaims(network, credId, 0, ...)` + `{type:"account", issuer, values, randomness}` input. The presentation's `credentialSubject.id` is `did:ccd:testnet:cred:<credId>`, which `getAccountInfo(credId)` resolves to the issuer's account; the request context `ConnectionID` carries `mandate:<id>`. A relying party re-verifies with `VerificationAuditRecordV1.verifyAnchor` + `VerificationRequestV1.verifyAnchor` + `VerifiablePresentationV1.verifyWithNode`; nothing has to be trusted from us.
- Range statements are `lower <= dob < upper` (upper exclusive): a proof made on 2026-11-19 has `upper = 20081120`.
- x402 2.31.0: payment flow re-proven (`docs/EVIDENCE.md`). `onAfterVerify` gives `result.payer`, used to refuse payment from any wallet other than the agent's registered wallet.
- Explorer links: `https://ccdexplorer.io/testnet/transaction/<hash>` and `/testnet/account/<address>` render server-side (checked with curl); CCDScan testnet links are client-rendered.

### Tooling
- npm drops rolldown's native binding on a second `npm i` with an existing lockfile (npm/cli#4828). Fixed by listing `@rolldown/binding-darwin-arm64` and `@rolldown/binding-linux-x64-gnu` (same version) in `optionalDependencies`.
- Apps run as TypeScript directly on Node 24 (type stripping); `erasableSyntaxOnly` is on, so no parameter properties or enums anywhere.

### Decisions
- Revocation = overwrite the anchor with `revoked|at:<unix>` (one sponsored `setMetadata`). The agent NFT stays active for other mandates.
- Verifier caches revocable state (anchor, agent record, key binding) for at most `revocationBoundMs` (site default 10 s); account keys 60 s; a verified adult proof is cached by (mandate id, record hash, VAA tx, issuer) because that evidence is immutable. Measured: the revoked mandate was rejected 2.7 s after the revoke finalized.
- The agent NFT names its signing key (external_reference), CIS-8 binds the key to the human, and the mandate names both. The verifier checks all three agree.
- Paid routes: mandate check runs before x402, so an unauthorised or over-cap agent never receives a 402; spend is added to the ledger only after settlement.
- Known limits (to state in README): replay store and spend ledger are in memory (single process); concurrent paid requests can overshoot `maxTotal` by in-flight amounts (production: reserve at verify time); receipts are submitted without waiting for finalization.
- Recording content of workshops 3, 5 and 6 is unverified (Encode login needed); nothing from the recordings is cited.

## Gate 2 (2026-11-19)

- **Badge**: Agent Card built with MCP `build_agent_card` (badge extension included), our Mandate A2A extension appended, published on GitHub Pages, served bytes checked (SHA-256 `20d9555f…`), pinned with a sponsored `setAgentURI` (tx `a4d2eebd…`). Hosted `check_badge`: `badge_valid: true`, `issues: []`. Now a step of the integration run.
- **Public verify page** (`apps/verify-page`, built by the Pages workflow): web-sdk with `ConcordiumGRPCWebClient`, our packages and the ZK verifier (wasm) run in the browser; ~5 s per mandate. Demo mandates on Pages: `demo-valid` (bc003940…, expires 2027-02-17 01:06 UTC) and `demo-revoked` (7da0d55c…, revoked in tx `00dd4ec6…`). Their audit records are on Pages (content-addressed).
- `verifyMandate()` (mandate-only checks) shares the chain checks with `verifyMandateRequest()`.
- **Spend reservations**: `SpendLedger.reserve/commit/release`; paid requests that carry a payment reserve atomically, released on any failure, on a 4xx response, or after a TTL. Test: three concurrent 0.05 payments against a 0.12 cap give two holds and one `over_cap_total`.
- **Receipts** are tracked from "submitted" to "finalized" in the background; the demo site shows both states.
- **UI**: one shared stylesheet (`site/assets/mandate.css`), Hallmark theme Cobalt (app scope); sloplint clean on all pages. Playwright web tests (bundled Chromium, desktop 1280x900 and phone 390x844): 16 pass, axe 0 serious or critical.
- **Console server** refuses POSTs whose Origin is not the console itself, so another web page cannot drive sponsored transactions through it.
- **Mainnet**: MCP `contract_info(mainnet)` shows CIS-8004 `<10082,0>` and CIS-8 `<10081,0>` on the same module refs as testnet.
- Lockfile: npm drops platform optional packages (lightningcss) when updating an existing lockfile; regenerate from scratch and check for `lightningcss-linux-x64-gnu` before pushing (CI `npm ci` fails otherwise).
- LLM agent mode: not built at Gate 2 (optional, last). The scripted agent carries the demo.

## Final gate (2026-11-19)

- **Judge path proven once, end to end**: `MANDATE_SECRETS_DIR=../.secrets/judge-run MANDATE_STATE_DIR=../.state/judge-run node scripts/demo.mjs setup`, exit 0 in 5:59. Two new identities (Test Human, Test Operator) via the self-service testnet IdP in bundled Chromium; accounts human `4VU5bwd5…GU7`, agentWallet `4XCS4ePF…a70e`-deploy, sponsor `4TEXtnkG…7pRv`, site `3otdkm35…MK7`; three faucet drops; CIS-8 key binding `c0758569…3d42` (fee payer: the new sponsor), CIS-8004 register `27ffb990…98f1` -> token 1264, setAgentWallet `51300f60…6450`, mandate `9012029d…` with VRA `03fc275c…`, VAA `18b6579b…`, anchor `deca660e…`. Those accounts are left alone from here.
- **Integration**: the first final-gate run failed at the issue step before any transaction (error text lost to a truncated log); the next two runs passed 9/9. The test now records an issue error in its evidence JSON. docs/EVIDENCE.md is from the run started 01:53:55 UTC.
- **Verify page** retries up to 3 times with a visible "Retrying" state and renders node or MCP failures as "Could not check", never as a failed check (two Playwright tests simulate a full outage and a transient one).
- **Layout guard** in Playwright (no horizontal overflow, no overlapping cells in a row, no wrapping nav link); with the old phone table restored it reports 5 problems, with the fix 0.
- **Video captures**: `scripts/video/capture.ts`, 8 page-only shots at 1920x1080 from a real testnet run (docs/video/RUN.md). Videos are not committed (`docs/video/captures/*.webm` is gitignored; an early set is in commit 6f3f2d9's history).
