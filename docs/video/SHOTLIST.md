# Demo video: proposed shot list (Gate 2 proposal, not produced yet)

Target 2:40 (limit 3:00). English. 16:9. Captions understandable with sound off. Page-only captures with Playwright `recordVideo` (no screen recording); cursor moves, click ripples and zooms are added in code at render time. Every number on screen comes from docs/EVIDENCE.md or a live page. Three features only: **mandate instead of CAPTCHA**, **pay within caps**, **revoke in one transaction**.

| # | Time | Screen (capture) | Narration (draft) | Caption |
| --- | --- | --- | --- | --- |
| 1 | 0:00 to 0:08 | Demo site sign-up, zoom on the puzzle box | "Websites can't tell a person's AI agent from a bot farm, so they block both." | Agents hit CAPTCHAs |
| 2 | 0:08 to 0:22 | Console: "Your agent" panel, badge valid | "Mandate lets a verified adult give their agent a signed, limited permission, checked on Concordium." | A human's signed permission |
| 3 | 0:22 to 0:50 | Console: issue form, then the five progress steps filling with transaction links | "I prove I'm over 18 with a zero-knowledge proof: no birth date leaves my wallet. I pick what the agent may do, where, until when, and for how much. One anchor on chain. I pay no fees." | Age proved, nothing revealed |
| 4 | 0:50 to 1:15 | Terminal-free: demo site feed, new entry "Agent 1261 signed up, Accepted, no puzzle", expand the 15 checks | "The agent signs up. The site checks fifteen things, from the agent's key to my proof, and lets it in. A receipt lands on chain." | 15 checks, no puzzle |
| 5 | 1:15 to 1:40 | Feed: "bought a report for 0.05 CCD" with payment link; then the 0.08 CCD bundle rejected | "Paid content: x402 in CCD, from the agent's own registered wallet. Above my cap, the site refuses before any payment." | Pays within the cap |
| 6 | 1:40 to 2:05 | Console: Revoke, typed confirmation, transaction link; cut to feed: "Rejected: mandate revoked" | "I change my mind. One transaction. The next request is refused, seconds later." | Revoked in one transaction |
| 7 | 2:05 to 2:30 | Public verify page (GitHub Pages), valid then revoked demo, "Answered by" column | "Anyone can check a mandate in their browser, straight from testnet. Each answer names its source." | Verify it yourself |
| 8 | 2:30 to 2:40 | Pages landing, repo URL and verify URL | "Mandate. Open source, on Concordium testnet today, mainnet-ready registry." | github.com/seunghyeon1004/mandate |

Honesty line in shot 3 or 7 (caption): "Testnet identity with invented attributes."

Materials to prepare at the final gate: Playwright captures of shots 1 to 8 at 1920x1080 from seeded runs, the `.srt` captions, the script with timings, and narration text for TTS. The optional phone-wallet moment (shot 3) is the lead's decision; the video works without it.
