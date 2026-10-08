# Roadmap

Tags:
- `[locked]` — safe for a scheduled, unattended run to pick up and complete. Doesn't require judging how the bot feels in a live call.
- `[gate]` — needs Niklas in an actual Discord call to judge feel/behavior. A scheduled run must never touch these; skip to the next `[locked]` item instead.
- `[provisional]` — an idea, not a commitment. Never touch without Niklas explicitly confirming he wants it first.

See `AUTOMATION.md` for the protocol a scheduled run follows. See `DECISIONS.md` for judgment calls made along the way.

## Now

- [x] [locked] Test baseline — `node --test` runner; extract `isSilent`/`formatTranscript`/`pushTranscriptEntry`/settings-resolution into `lib/` so they're unit testable without Discord
- [ ] [gate] Live-tune ambient reply cadence (dev notes #17) — test in a real multi-person call; adjust `lullThresholdMs`, `AMBIENT_COOLDOWN_MS`, `PER_USER_SILENCE_MS`, and the silence-bias wording in `prompt.txt` based on how it actually feels
- [ ] [locked] Persistent text memory (SQLite via `better-sqlite3`) — `textMemory` currently resets on every restart

## Next

- [ ] [locked] Structured logging (`pino`) — replace `console.log`/`console.error` with real log levels, opportunistic as other work touches affected code
- [ ] [locked] Modular `src/` structure (dev notes #1) — extract services/commands/events out of `index.js`; do this incrementally as other `[locked]` tasks touch the file rather than as one big-bang rewrite
- [ ] [gate] Custom voice — only revisit after the ambient cadence feels right (above). Cartesia Sonic is the pick if/when this becomes a priority (cheap, ~40ms latency, real cloning); currently stays on OpenAI `tts-1` by choice, not because it's blocked
- [ ] [provisional] Web dashboard (Express status page: active guilds, current prompts, memory counts)
- [ ] [provisional] League of Legends / Valorant stat commands (`/rank`, `/valorant`)

## Later / unscoped

- [ ] [provisional] Multi-bot personas (multiple app IDs, same codebase, different prompts/voices)
- [ ] [provisional] Image generation (`/imagine`)
- [ ] [provisional] Scheduled reminders (`/remind`)
- [ ] [provisional] Music playback (`/play`)

## Hosting

Not scheduled or planned yet — explicitly deferred until the bot's behavior is solid under local testing. See `development.md`'s Hosting Notes for what's already in place (Oracle VM compatibility) whenever this does come up.
