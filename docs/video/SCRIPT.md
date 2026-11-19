# Demo video script (2:40, English)

Three features: mandate instead of a CAPTCHA, pay within the caps, revoke in one transaction. Every number on screen comes from the capture run (docs/video/RUN.md) or the live pages. Narration lines are complete sentences. The human's signature in this demo is made by a local test wallet; the browser and mobile wallet `signMessage` flow produces the same signature type but was not exercised, and the video says so in shot 3.

| # | Time | Capture (docs/video/captures) | Narration | On-screen caption |
| --- | --- | --- | --- | --- |
| 1 | 0:00-0:08 | shot-1.webm 0.0-6.8 s, hold last frame 1.2 s; zoom 1.4x on the puzzle box at 1.9 s | Websites can't tell a person's AI agent from a bot farm, so they block both. | Agents hit CAPTCHAs |
| 2 | 0:08-0:22 | shot-2.webm 0.0-8.5 s, hold 5.5 s; zoom 1.4x on the badge at 3.6 s | Mandate lets a verified adult give their agent a signed, limited permission that any website can check on Concordium. | A human's signed permission, checked on chain |
| 3 | 0:22-0:50 | shot-3.webm 0.0-30.0 s at 1.07x speed; cursor click on "Prove age and issue" at 1.9 s; zoom on the new Active row at 25.2 s | I prove I'm over eighteen with a zero-knowledge proof, so no birth date leaves my wallet. I choose what my agent may do, where, until when and for how much. One anchor goes on chain, and I pay no fees. | 0:24-0:36 "Age proved, nothing revealed" / 0:36-0:43 "Testnet identity with invented attributes" / 0:43-0:50 "Signed by a local test wallet; wallet popup not used" |
| 4 | 0:50-1:15 | shot-4.webm 0.0-22.7 s, hold 2.3 s; click "All 15 checks passed" at 9.2 s; zoom on "finalized" at 16.5 s | My agent signs up. The site runs fifteen checks, from the agent's key to my age proof, and lets it in without a puzzle. A receipt is written on chain. | 15 checks, no puzzle |
| 5 | 1:15-1:40 | shot-5.webm 0.0-22.6 s, hold 2.4 s; zoom "paid 0.05 CCD" at 12.4 s; zoom "refused" at 18.3 s | Paid content uses x402 in CCD, paid from the agent's own registered wallet. Above my cap, the site refuses before any money moves. | Pays within the cap |
| 6 | 1:40-2:05 | shot-6.webm 0.0-20.2 s, hold 4.8 s; clicks "Revoke" 2.1 s and "Revoke now" 2.9 s (typing between); zoom "Rejected: mandate revoked" at 15.8 s | If I change my mind, one transaction revokes the mandate. Seconds later, the site refuses my agent. | Revoked in one transaction |
| 7 | 2:05-2:30 | shot-7.webm 0.0-25.2 s; zoom "Valid" 7.5 s, "Answered by" 10.0 s, "Revoked" 18.4 s | Anyone can check a mandate in their own browser, straight from testnet. Each answer names its source. | Verify it yourself |
| 8 | 2:30-2:40 | shot-8.webm 0.0-7.6 s, hold 2.4 s; zoom on "Verify the demo mandate" at 1.7 s | Mandate is open source and runs on Concordium testnet today. Try the verifier at the link below. | github.com/seunghyeon1004/mandate · seunghyeon1004.github.io/mandate |

Word count: about 175 words of narration over 160 s (about 1.1 words per second, room for pauses).
