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
