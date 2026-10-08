# Decisions Log

Judgment calls made outside an explicit roadmap task, so later sessions (scheduled or interactive) have the reasoning without re-deriving it. Newest at the bottom.

- **2026-10-08 — Landed a pre-existing uncommitted rewrite as the new baseline.** Found a substantial uncommitted Groq/slash-command rewrite already sitting in the working tree, diverged from the last pushed commit (`cfb4cb3`). Diffed it against the last two pushed commits to confirm nothing from them — ffmpeg path quoting, the Oracle VM safety helpers, the immediate first-recording fix — had been lost, before committing it as the new baseline. Also untracked `node_modules` (was committed before `.gitignore` caught it).

- **2026-10-08 — Replaced the fixed-interval voice loop with continuous ambient listening.** The original design recorded on a timer and replied once per cycle, which was the main source of the "slow" and "talks over people" complaints. Redesigned around per-utterance capture, two reply triggers (direct address vs. dead-air), a shared "wait until quiet" output gate, and barge-in cancellation. Full reasoning and design tradeoffs were worked out collaboratively with Niklas in chat before implementation — see that conversation for the "why," this file just records the parts an automated run needs to know are intentional.

- **2026-10-08 — Dropped the separate `voiceMemory` chat-history array.** The original per-cycle design needed it for continuity across batched windows. Once replies became per-utterance (far more turns per call), reusing it would have pushed a growing, overlapping snapshot of the transcript into memory on every single turn. Replaced it with the existing rolling `session.transcript` (now including Nikbot's own replies) as the single context source — simpler and not duplicative.

- **2026-10-08 — Automation scope excludes all voice-feel work.** Niklas chose "scheduled for backend-only tasks" as the automation mode. Reply-trigger logic, timing constants, and `prompt.txt` are therefore a hard boundary a scheduled run must never cross (see `AUTOMATION.md`) — only he can judge whether the ambient behavior feels right, and running headlessly doesn't test that at all.

- **2026-10-08 — Chose `node --test` over adding a test framework.** No existing test tooling, and the project's own stated preference (`development.md`'s dependency table, "keep dependencies boring and minimal") favors the standard library. Node 24 is in use locally, well past `node:test`'s stabilization (Node 20+), so no version risk.
