# Submission draft: Mandate

## One line
A verified adult gives an AI agent a scoped, expiring, revocable mandate; websites check it against Concordium and let the agent in instead of showing a CAPTCHA, take x402 payments within its caps, and see a revocation within seconds.

## Description

Agents now sign up, buy and post for people, and websites cannot tell a person's agent from a bot farm, so they block both with CAPTCHAs and SMS checks. Mandate replaces that wall with a check a site can run against Concordium.

A human with a Concordium ID proves, with a zero-knowledge proof bound to their account, that they are 18 or older, and signs a mandate for their agent: which actions, on which sites, until when, and for how much. The mandate's hash is anchored in the agent's own Agent Registry entry. The agent signs every HTTP request with its key, which is bound to the human through CIS-8 and named by the agent NFT. A website installs one Express middleware that runs 15 checks and lets the agent through. Paid routes take x402 payments in CCD, only from the agent's registered wallet and only within the mandate's caps. Every accepted action leaves a receipt on chain, and one transaction revokes the mandate.

The human never needs CCD: all their transactions are sponsored. Anyone can re-verify a mandate in the browser on the public verify page, straight from testnet, with each answer naming its source.

What we built: a TypeScript core library (mandate schema, JCS hashing, human and agent signatures, `verifyMandateRequest`), a Concordium access layer (runtime-loaded registry schemas, gRPC and hosted-MCP reads with fallback, adult-proof re-verification, V1 sponsored transactions), drop-in verifier middleware, an operator service (fee sponsor with an allow-list policy, self-hosted x402 facilitator for `ccd:*`), an issuer console, a demo website, an agent runtime, and the public verify page. Tests: 53 unit, property and table tests (one row per rejection reason, concurrency of spend caps), 20 browser tests on desktop and phone with axe, and an on-demand integration test of the whole flow on testnet.

## Concordium components used, and where in the code

| Component | Use | Code |
| --- | --- | --- |
| Concordium ID + Verify & Access | Account-bound ZK age proof per mandate; VRA and VAA anchored; re-verified by any website | [`proveAdult`](https://github.com/seunghyeon1004/mandate/blob/main/apps/console/src/issuer.ts#L137), [`verifyAdultProof`](https://github.com/seunghyeon1004/mandate/blob/main/packages/mandate-chain/src/adult.ts#L35) |
| Agent Registry (CIS-8004) | Agent NFT naming its signing key; mandate anchor `mandate:<id>` in agent metadata; revocation | [`registerAgent`](https://github.com/seunghyeon1004/mandate/blob/main/apps/console/src/issuer.ts#L56), [`issueMandate`](https://github.com/seunghyeon1004/mandate/blob/main/apps/console/src/issuer.ts#L166) |
| CIS-8 external keys | Agent's ed25519 key bound to the human's account | [`registerAgent`](https://github.com/seunghyeon1004/mandate/blob/main/apps/console/src/issuer.ts#L69), [`grpcOwnerOfKey`](https://github.com/seunghyeon1004/mandate/blob/main/packages/mandate-chain/src/reads.ts#L63) |
| Agent Card + Verified by Concordium badge | Card on GitHub Pages with our Mandate A2A extension, hash pinned; hosted badge check valid | [`buildCard`, `pinCard`](https://github.com/seunghyeon1004/mandate/blob/main/apps/console/src/issuer.ts#L232) |
| Agent Registry MCP server | Reads, builders, badge check; gRPC fallback; source reported per check | [`McpClient`](https://github.com/seunghyeon1004/mandate/blob/main/packages/mandate-chain/src/mcp.ts#L12), [`ConcordiumChainView`](https://github.com/seunghyeon1004/mandate/blob/main/packages/mandate-chain/src/view.ts#L43) |
| x402 | CCD payments from the registered agent wallet, caps checked before the 402, self-hosted facilitator | [site](https://github.com/seunghyeon1004/mandate/blob/main/apps/demo-site/src/main.ts), [payer binding](https://github.com/seunghyeon1004/mandate/blob/main/packages/mandate-verifier/src/index.ts), [facilitator](https://github.com/seunghyeon1004/mandate/blob/main/apps/facilitator/src/main.ts) |
| Sponsored transactions (V1) | Every human transaction and every x402 transfer fee paid by the sponsor | [`buildSponsoredContractUpdate`](https://github.com/seunghyeon1004/mandate/blob/main/packages/mandate-chain/src/tx.ts#L70), [policy](https://github.com/seunghyeon1004/mandate/blob/main/apps/facilitator/src/policy.ts) |
| registerData | One receipt per accepted action | [receipts](https://github.com/seunghyeon1004/mandate/blob/main/apps/demo-site/src/receipts.ts) |

## CCDExplorer links (Concordium testnet)

- Agent Registry contract: https://ccdexplorer.io/testnet/instance/12802/0 ; agent token 1261, badge `JyP9YMpKL9vhHC2hgA2pc`
- Human (agent owner, 0 CCD, never pays fees): https://ccdexplorer.io/testnet/account/4jjXocyWa2vkaRjW7BAvQEvF8zzjrLRrktDFjExXkzKMKztn3b
- Agent registration (CIS-8004 register): https://ccdexplorer.io/testnet/transaction/47e647d26a404eefc9b052bb9a256560d3e228a7a48a125158973169dc3c2336
- Key binding (CIS-8 registerExternalKey): https://ccdexplorer.io/testnet/transaction/692b7c27174a2d35c5bde071585ed74cda0e6fd4a12dc556586a0be2419def57
- Agent wallet (setAgentWallet): https://ccdexplorer.io/testnet/transaction/12ac45f805e0fe4085bbf5c01282e9baca3bc7b0a1041b9d4bd72033ecd6ec33
- Agent Card pinned (setAgentURI): https://ccdexplorer.io/testnet/transaction/a4d2eebda15dac1618ce99505d25720d846616e3ee65e8d98d41af3f116fe2e1
- Age proof anchors (final evidence run): VRA https://ccdexplorer.io/testnet/transaction/c82d6cc49cc1037933b3d70d18e38b0e8a91a99137ceec88465ee63169b7ef1a , VAA https://ccdexplorer.io/testnet/transaction/4b26e22c9083a67f96f9e225a079e2704e56152a74b854788d02790db38559ae
- Mandate anchor: https://ccdexplorer.io/testnet/transaction/1dddca8b87c28ab29b6bb327f26505bb67ed803cd4c49cb09c3d9392680ad311
- Action receipt: https://ccdexplorer.io/testnet/transaction/7f7654dc536f45e42556e9c5486cfe17f3c2df7e8b68e2b1411c4dc04ae7aea2
- x402 payment (0.05 CCD from the agent wallet, fee sponsored): https://ccdexplorer.io/testnet/transaction/0c0943cb6292cf95a46fe3291054cc9409e55a9906c066a802013e9ea25c826a
- Revocation: https://ccdexplorer.io/testnet/transaction/d81ed5e6b4c94086eaaf173eff58e54a74edbad59a9e5fb7c441b0888091193f (the next request was refused 2.7 s later)

Full table with every step of the run: https://github.com/seunghyeon1004/mandate/blob/main/docs/EVIDENCE.md

## Path to production (summary)

- The mainnet Agent Registry (CIS-8004 `<10082,0>`, CIS-8 `<10081,0>`) runs the same modules as testnet (checked with the hosted MCP), and Mandate loads schemas at runtime with a start-up check, so moving is configuration.
- Real users: the Concordium ID app and wallet replace the headless test wallet (`signMessage` gives the same signature type; Verify & Access answers over WalletConnect); the console becomes a dApp with no keys; businesses issue mandates under an LEI company identity.
- Websites install `@mandate/verifier` with a shared replay store and a database spend ledger (reservations as one conditional update), read from their own node, and state their revocation bound.
- Fees: sponsorship with per-issuer quotas; prices in a stable Protocol-Level Token so a cap means the same every day.
- Full note: https://github.com/seunghyeon1004/mandate/blob/main/docs/PATH_TO_PRODUCTION.md

## Demo links

- Public verify page (live): https://seunghyeon1004.github.io/mandate/verify/?m=demo-valid and https://seunghyeon1004.github.io/mandate/verify/?m=demo-revoked
- Landing page: https://seunghyeon1004.github.io/mandate/
- Repository: https://github.com/seunghyeon1004/mandate (Apache-2.0); local demo: `node scripts/demo.mjs setup` then `node scripts/demo.mjs run`
- Video: (to be added)

## Honesty notes

- Testnet identities were created on Concordium's self-service testnet identity provider with invented attributes; "verified adult" proves the mechanism, not a real person.
- In the demo, the human's signature is made by a local test wallet; the browser and mobile wallet `signMessage` flow produces the same signature type but was not exercised.
- Spending caps are enforced off chain by each website's verifier; the chain holds the evidence. Protocol-Level Locks are not live and are not used.

## What existed before 19 November

Design notes and throwaway spikes (testnet experiments with throwaway keys) from 5 November, not part of the repository. The repository's first commit is on 19 November 2026; all project code was written from then on.

## Use of AI

Built by an AI coding agent (Claude, by Anthropic) under a human lead who set the direction, approved each milestone and verified results from fresh clones. Commits carry a `Co-Authored-By` trailer naming the model. Every claim above is backed by a test, a command or a transaction in docs/EVIDENCE.md.
