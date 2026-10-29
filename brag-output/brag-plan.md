# brag-plan.md — Coco launch video

## What it is
Coco is a local AI browser agent that runs Telegram-side: you text it a goal, it drives a real
browser (browser-use + cloakbrowser) to do it, pauses for approve/deny before any charge, and
reads fast-path data (YouTube etc.) without opening a browser at all.

- **Who / what for:** people who already have a chat app and don't want another dashboard —
  the product's own line: "The interface is invisible. You don't need to learn a new app. Just text it."
- **Sets it apart:** runs entirely on your machine; the LLM never needs your passwords typed in
  chat (encrypted local vault); human-in-the-loop gate before any payment.
- **Most impressive claim:** you text "book me a flight" and it checks out, pausing once for you to approve.
- **Visual hook:** a Telegram chat where Coco replies and then the actual browser pays — in one cut.
- **Tone:** `default` (punchy, playful, clean) — the product's own visual language is
  "Stark Editorial Minimalism": warm paper `#FAF9F5`, ink `#111111`, muted `#6B6B6B`,
  serif headlines (Georgia) + clean sans.
- **Share caption:** "I gave my Telegram bot my browser. It books the flight, asks me to approve
  the charge, and passwords never leave the machine."

## Shape (20s @ 30fps = 600 frames, 1920×1080)

| # | Scene | Time | Beats |
|---|---|---|---|
| 1 | Hook — Telegram chat | 0.0–3.2s | User bubble pops: "Book me the cheapest flight to Delhi." Coco replies: "✈️ On it — spawned the browser agent…" (real gateway copy) |
| 2 | Reveal — editorial type | 3.2–6.8s | Serif statement, word by word: "Coco lives in your chat. **It acts on your behalf.**" |
| 3 | Highlight A — browser + HITL gate | 6.8–12.2s | Chrome window mock: checkout page fills itself ("Checkout reached. Total: ₹5,214 / Should I pay?"), Telegram panel slides in: "approve" → "✅ Task #14 finished." |
| 4 | Highlight B — fast path | 12.2–15.8s | Chat: "summarize the top YouTube videos on local AI agents" → reply + badge "query_agent_reach · step 1 · 0 browser steps" |
| 5 | Punchline | 15.8–20.0s | "The interface is invisible. Just text it." → wordmark + "runs on your machine · open source" |

Poster frame: settled punchline (~19.4s), baked as frame 0.

## Sound
One piece: warm minimal arpeggio (F#m–Dmaj7–A6–E, 96 BPM) with soft sub; SFX written into the
same key and space — message "pip"s at bubble pops, quiet typing ticks, an approve "ding" (major
3rd) at the HITL moment, a low thump on scene cuts. Effects sit ~12 dB under the music; master
fades in/out. 44.1 kHz stereo WAV, muxed with imageio-ffmpeg's bundled ffmpeg (no system ffmpeg).

## Fictional stand-ins
Chat text and checkout totals are illustrative (task numbers, price): task IDs and the price are
plausible dummies; all other chat strings are real gateway/landing copy. No secrets, tokens,
real chats or personal data appear — the video is built from code, not from a live chat log.