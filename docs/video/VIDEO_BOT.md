# Edit list for the video bot (render on the video machine, not here)

Follows `~/hackathons-2026/VIDEO_GUIDE.md`. Inputs in this folder:

- `captures/shot-1.webm` to `shot-8.webm`: page-only Playwright `recordVideo` captures, 1920x1080 (a 1280x720 layout rendered at 1.5x zoom, so text is sharp). No terminal, no OS chrome, no cursor. `shot-N.png` is the last frame of each.
- `captures/events.json`: per shot, the time (seconds from the start of that capture) and the 1920x1080 frame position of every click and zoom target, for the coded cursor and zooms.
- `SCRIPT.md` (shot timings, trims, holds, narration per shot, captions), `narration.txt` (TTS input), `captions.srt` (sound-off captions), `RUN.md` (the on-chain transactions behind the footage).

## Assembly (HyperFrames, or Remotion)

1. Timeline 0:00 to 2:40 at 30 fps, 1920x1080, per the time column in SCRIPT.md. Where a capture is shorter than its slot, hold its last frame; shot 3 plays at 1.07x so 30 s fits 28 s.
2. Cursor: coded, slow, with a pause of 300 to 400 ms before each click and a click ripple, moving to the `click` positions in `events.json` at their times (plus the shot's offset). Shot 6 has typing between the two clicks: keep the cursor still while the confirmation text types.
3. Zooms: 1.3x to 1.5x on each `zoom` target in `events.json`, eased in over 400 ms, held about 2 s, eased out; explicit start values (fromTo). Never zoom during a click.
4. Captions: from `captions.srt`, white box with dark text, at most 2 lines, placed near the object the shot is about (shot 1 near the puzzle box, shot 4 to 6 above the feed, shot 7 under the verdict), never over a transaction link being zoomed. Highlight one or two words: "no puzzle", "within the cap", "one transaction".
5. Narration: TTS from `narration.txt` (Qwen3-TTS via mlx-audio, or macOS `say`), one paragraph per shot, starting 0.3 s into each shot. Music: quiet bed; no sound effects on text.
6. End card (shot 8): keep `github.com/seunghyeon1004/mandate` and `seunghyeon1004.github.io/mandate` on screen for the last 8 s.

## Content rules for this video

- The demo website is fictional (Larchfield Reports); its puzzle box is a neutral placeholder and must not be dressed up to look like any real CAPTCHA product.
- Shot 3 must carry the two honesty captions: "Testnet identity with invented attributes" and "Signed by a local test wallet; wallet popup not used".
- No number on screen that is not in the captures or RUN.md. Fees are not shown.
- No phone-wallet moment (decided out).

## Mandatory checks before handing back (report each with evidence)

- [ ] Render twice, frames identical (`ffmpeg -i a.mp4 -i b.mp4 -lavfi psnr -f null -` reports inf)
- [ ] No one-frame flashes (frame-diff check)
- [ ] First 2 s understandable (the puzzle box and "Agents hit CAPTCHAs")
- [ ] Understandable with sound off (captions carry every claim)
- [ ] Legible at phone size (check a 390 px wide preview)
- [ ] Loudness -14 to -16 LUFS (`ffmpeg -af ebur128`)
- [ ] Narration verified with whisper.cpp large-v3-turbo against narration.txt, numbers normalised
- [ ] Final scene has the call to action
- [ ] Length under 3:00 (target 2:40)
