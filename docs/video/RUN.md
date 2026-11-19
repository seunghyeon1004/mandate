# Capture run (the transactions the video shows)

Captured 2026-11-19 02:07 to 02:10 UTC with `node scripts/video/capture.ts` (Playwright `recordVideo`, bundled Chromium, 1920x1080, page only) against Concordium testnet, right after the final integration run (docs/EVIDENCE.md). Mandate `44746cd5-2007-462e-b1a1-e2c43a9d52c6`, issued in shot 3 and revoked in shot 6. Agent token 1261.

| Shot | What | Transaction |
| --- | --- | --- |
| 3 | Age proof requested (VRA) | [3dfdf0eefc…](https://ccdexplorer.io/testnet/transaction/3dfdf0eefccdd3d463436ec52f05cb767fa6381b0ac1dddae5c471b5b61d5965) |
| 3 | Age proof verified, audit anchored (VAA) | [f08d66a23b…](https://ccdexplorer.io/testnet/transaction/f08d66a23bbfc4bc292ab3668549eebc84d241b83bfdbc0a9c5ddccd06f9099e) |
| 3 | Mandate hash anchored (sponsored) | [1fb8e531f2…](https://ccdexplorer.io/testnet/transaction/1fb8e531f2316fc9b5bb544236fd7226830d59485d0161414d075abfbb463cf0) |
| 4 | Signup receipt (finalized) | [9d7301a7dd…](https://ccdexplorer.io/testnet/transaction/9d7301a7dd9962677c9dfb4250ba601c49b8d7d6f6a2012cfa2d0513a5e615d8) |
| 5 | x402 payment 0.05 CCD from the agent wallet | [907a0357c7…](https://ccdexplorer.io/testnet/transaction/907a0357c73352fd78690828d761827364de41b3fe7b6b2461ec6a5dcf749e45) |
| 5 | Report receipt (finalized) | [4ef6ca25c1…](https://ccdexplorer.io/testnet/transaction/4ef6ca25c18b6f64996babfb85791d3f27d4badebc3e0f44a88fbb3d699a1f93) |
| 5 | 0.08 CCD bundle refused: over the per-action cap, nothing paid | none |
| 6 | Revoke (one setMetadata, sponsored) | [e7f4b344eb…](https://ccdexplorer.io/testnet/transaction/e7f4b344eb3de5fd8c9160797cf843ae3773cc72486d4ae6c18c95538256574a) |
| 6 | Retry refused: mandate revoked | none |
| 7 | Public verify page on GitHub Pages, demo-valid and demo-revoked | read only |
