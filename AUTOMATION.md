# Automation Protocol — Backend-Only Scheduled Runs

This governs unattended/scheduled runs only. Interactive sessions with Niklas present aren't bound by the "never touch" boundary below — he can ask for anything directly.

NiklasBot's actual value (does the ambient listening feel right in a live call) can't be verified headlessly. `make`-equivalent checks here (`npm test`, `node --check`) only prove the code runs, not that it feels good. So scheduled runs are scoped to work that's genuinely verifiable without a human in a Discord call.

## Hard boundary — never touch in a scheduled run

- `prompt.txt` / `textPrompt.txt` (voice personality and reply-behavior instructions)
- Reply-trigger logic in `index.js`: `maybeRespondToAddress`, `checkForLull`, `speakWhenClear`, and the tuning constants (`PER_USER_SILENCE_MS`, `LULL_CHECK_INTERVAL_MS`, `AMBIENT_COOLDOWN_MS`, `MAX_SPEAK_WAIT_MS`, `DEFAULT_SETTINGS.lullThresholdMs`)
- Anything tagged `[gate]` or `[provisional]` in `ROADMAP.md`
- Hosting/deployment — not in scope at all right now (see `ROADMAP.md`)

If every remaining `[locked]` task would require touching the above, stop and report rather than improvising around the boundary.

## Work loop (one run)

1. Pull latest `main`.
2. Re-read this file and `ROADMAP.md` fresh — don't rely on memory of a prior run; either file may have changed.
3. Run `npm test` before starting anything. If it's not already green, stop and report — don't build on a broken baseline.
4. Pick the first unchecked `[locked]` task, top to bottom. Skip `[gate]` and `[provisional]` tasks without stopping the run — just move to the next eligible `[locked]` item. Note any skipped `[gate]` tasks in the commit message so Niklas sees what's waiting on him.
5. If the task is too large for one commit, split it into smaller `[locked]` subtasks by editing `ROADMAP.md` first (that edit is its own commit), then do the first subtask.
6. Implement with tests. `npm test` and `node --check index.js` must both pass before committing.
7. Commit atomically: code + tests + the flipped `ROADMAP.md` checkbox, same commit. Push directly to `main` — no branches or PRs for this solo project.
8. If a judgment call comes up that isn't obviously right, record it in `DECISIONS.md` and keep going — unless it touches the hard boundary above, credentials, money, or anything irreversible, in which case stop and leave it for Niklas.
9. Repeat from step 4 until no eligible `[locked]` tasks remain, then stop.

## Hard rules

- Never commit a broken state (red tests, invalid syntax).
- Never add a paid dependency or API without flagging it in `DECISIONS.md` first — this project runs on free-tier Groq + low-cost OpenAI TTS by choice.
- Keep dependencies boring and minimal; prefer the standard library (this is why tests use `node:test`, not an added framework).
- `.env` holds real secrets — never read, print, or commit it.
- Never touch hosting/deployment unprompted.
