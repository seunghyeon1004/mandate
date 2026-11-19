# Path to production

What it takes to run Mandate on Concordium mainnet in front of real users. Facts marked "checked" were verified by command on 2026-11-19; the rest is the plan.

## 1. The registry code moves unchanged

- Mainnet Agent Registry: CIS-8004 `<10082,0>` and CIS-8 `<10081,0>` run the **same module refs** as testnet (`0e574737…d3eb` and `3236c12f…9afd`; checked with the hosted MCP `contract_info` for both networks).
- Mandate already loads each contract's schema from the deployed module at start-up and refuses to start if an entry point it uses is missing (`loadRegistry`, `REQUIRED_ENTRYPOINTS`), so a registry upgrade is caught before it can mis-serialise anything. The testnet instance was upgraded in place during the hackathon window and Mandate kept working because of this.
- Network switch: `CCD_MAINNET = ccd:9dd9ca4d19e9393877d2c44b70f89acb`, mainnet gRPC, the mainnet registry addresses above. All are configuration.

## 2. Real people, real wallets

| Demo (testnet) | Production |
| --- | --- |
| Identity from the self-service testnet identity provider, invented attributes | Concordium ID app with a production identity provider |
| Human's key held by the local console; mandate signed with `signMessage` headlessly | The Concordium wallet signs the mandate (`signMessage`, same signature type, verified with `verifyMessageSignature`) and the sponsored anchor transaction; the console becomes a dApp that holds no keys |
| Age proof made headlessly from the identity object | The wallet answers the Verify & Access request over WalletConnect (`@concordium/verification-web-ui`); the presentation is the same account-bound V1 presentation |
| Business owners not covered | Company identity with an LEI (Concordium company identity flow) as the issuer of mandates for a business's agents |

## 3. The website side (the verifier)

The middleware is the product a website installs. To run it across several instances:

- **Replay guard:** a shared store with expiry, e.g. Redis `SET key 1 NX PX <skew + 1 s>`; the interface is already `ReplayGuard.remember(key, expiresAt) -> boolean`.
- **Spend ledger:** one row per mandate hash; `reserve` is a single conditional update (`spent + reserved + amount <= cap`), `commit` after x402 settlement, `release` on failure, reservations expire. The in-memory `MemoryLedger` has the same contract and its concurrency test (three simultaneous payments against a cap that fits two) is in `packages/mandate-verifier/test/table.test.ts`.
- **Chain reads:** the site's own Concordium node (or a node provider) as primary; the hosted MCP as a convenience, never as the only source. The verifier already falls back to gRPC and says which source answered each check.
- **Revocation bound:** revocable state (anchor, agent record, key binding) is cached for at most `revocationBoundMs` (10 s in the demo). A site states its bound; a revocation is seen within it (measured: 2.7 s after finalization in the evidence run).
- **Audit records:** content-addressed (their SHA-256 is inside the signed mandate), so any host works: the issuer's site, the agent's own endpoint, or IPFS. The default fetcher is https-only with a size cap and timeout; production adds an allow-list or a proxy to rule out SSRF.
- **Receipts:** the site's account writes one `registerData` per accepted action. At volume, batch receipts into a Merkle root per minute and keep the leaves off chain.

## 4. Fees and sponsorship

- The human never needs CCD: every human transaction in the demo is a V1 sponsored transaction (checked: the human account balance is 0 after every run).
- Fees observed on testnet, paid by the sponsor (from transaction summaries): CIS-8 key binding 16.29 CCD, CIS-8004 register 26.33 CCD. Concordium fees are set in euros and converted at the on-chain exchange rate, so the CCD amount on mainnet will differ; the energy per call is what carries over.
- Sponsorship policy is explicit: allow-listed contracts and entry points, energy cap, enrolled senders, rate limit, and a dry-run before the sponsor signs. Production adds per-issuer quotas and billing (the issuer platform or the website pays, as a cost of replacing CAPTCHAs and SMS checks).
- x402 transfers are sponsored by the facilitator. Production uses a hosted facilitator for `ccd:*` once one exists, or runs this one; prices in a stable Protocol-Level Token (e.g. a euro or dollar PLT) instead of CCD so a cap means the same thing every day.

## 5. Security and privacy

- Agent keys: the agent holds only its ed25519 request key and its wallet key, never the human's key; the agent is not an operator of its NFT, so it cannot revoke or rewrite itself.
- The issuer account is public on chain by design (accountability). Scope and expiry are public once a mandate is presented; a human who wants unlinkable mandates uses a separate account per purpose.
- Spending limits are enforced off chain by each website. Until Protocol-Level Locks ship, a mandate cannot stop an agent's wallet from paying elsewhere; the registered agent wallet and the on-chain receipts make every payment attributable.

## 6. Steps to go live

1. Switch configuration to mainnet; re-run the start-up schema check and the integration flow against mainnet with small amounts.
2. Replace the console's local signing with the Concordium wallet (WalletConnect for mobile, the browser wallet API on desktop); test the real popup flow.
3. Package `@mandate/verifier` with Redis and Postgres adapters; publish to npm with the 25-row rejection table as its contract test.
4. Run the sponsor and facilitator as a service with quotas; choose the PLT for prices.
5. Pilot with one website that today gates sign-ups with a CAPTCHA or SMS check, and one agent framework (A2A, MCP) whose agents carry the Mandate extension in their Agent Card.
