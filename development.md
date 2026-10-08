# NiklasBot — Development Notes

## Current State

A single-file Discord bot in `index.js` with voice AI, text chat, and Fortnite integration. Runs on Node.js. Uses Groq (free tier) for chat and transcription, OpenAI for TTS.

---

## Issues — Status

### ✅ Resolved

**#2 Python subprocess for Whisper** — Replaced with Groq `whisper-large-v3-turbo` API. No Python dependency.

**#4 Global settings** — Replaced with per-guild `guildSettings.json`. `/setrecord` and `/setrepeat` are now server-scoped.

**#6 Dual command system** — All `!` prefix commands removed. Slash commands only.

**#7 Outdated AI model** — Switched to `llama-3.3-70b-versatile` via Groq (free tier).

**#8 Google TTS quality** — Replaced `gtts` with OpenAI `tts-1`. Removed `gtts` from `package.json`.

**#9 No voice reconnection** — Added `VoiceConnectionStatus.Disconnected` handler. Attempts reconnect for 25s, then cleans up and notifies the channel.

**#11 Duplicate slash command registration** — Extracted `SLASH_COMMANDS` constant shared by `registerSlashCommands()` and `guildCreate`.

**#12 No rate limiting** — Added 5-second per-user cooldown on `/message-nikbot` with ephemeral feedback.

---

### ❌ Remaining

**#1 Monolithic index.js** *(critical)*
Everything still lives in one file. Phase 1 refactor (extract services, commands, events into `src/`) is deferred until other features stabilize.

**#3 Fixed-interval recording / no VAD** *(critical)*
Bot still polls on a fixed timer rather than listening continuously. VAD via `EndBehaviorType.AfterSilence` would make voice chat feel real-time. This is the next high-impact change.

**#5 In-memory text history resets on restart** *(critical)*
`textMemory` Map is lost on every restart. Needs SQLite persistence via `better-sqlite3`.

**#10 Audio filename collision risk** *(minor)*
PCM files use millisecond timestamps now — collision risk is negligible but not zero. Can append a random suffix if it ever causes issues.

**#13 changingPrompt.txt is shared global state** *(minor)*
The fallback prompt for guilds without a custom prompt is loaded from disk. Fine for single-server use; would need to be seeded per-guild for multi-tenant use.

**#14 No structured logging** *(minor)*
All output is `console.log`. Add `pino` for log levels and timestamps when cloud hosting becomes a priority.

**#15 Stale voice memory on crash** *(minor)*
Voice memory is cleared on clean stop but not on crash. Low priority since voice memory is intentionally session-scoped.

**#16 README out of sync** *(minor)*
README still references Python, `gtts`, and prefix commands. Update after VAD is done so it reflects the final UX.

---

## Overhaul Plan — Phase Status

| Phase | Description | Status |
|---|---|---|
| 2 | Per-guild settings | ✅ Done |
| 3 | Replace Python transcription | ✅ Done |
| 4 | Replace gtts with OpenAI TTS | ✅ Done |
| 5 | Slash commands only | ✅ Done |
| 1 | Modular src/ structure | ❌ Pending |
| 6 | Voice Activity Detection | ❌ Next |

---

## Future Development Plans

### Short Term — Next Up

**Voice Activity Detection (VAD)**
Replace fixed-interval polling with continuous listening. Bot records each user until 1.5s of silence, then responds immediately. Eliminates the 2-minute repeat loop entirely. Uses the existing `EndBehaviorType.AfterSilence` that's already imported.

**Persistent text memory (SQLite)**
Use `better-sqlite3` to persist `textMemory` across restarts. Schema: `(guild_id, role, content, timestamp)`. Same 20-exchange window, survives restarts.

### Medium Term

**Web dashboard**
Simple Express status page: active guilds, current prompts, memory counts. Add controls later.

**League of Legends / Valorant integration**
- `/rank <summoner>` — LoL rank via Riot API
- `/valorant <username>` — Valorant rank/stats

### Long Term

**Multi-bot personas** — Multiple app IDs, same codebase, different prompts/voices.

**Image generation** — `/imagine <prompt>` via a free image API (Pollinations.ai or similar).

**Scheduled reminders** — `/remind @user <time> <message>` stored in SQLite.

**Music playback** — `/play <YouTube URL>` using `ytdl-core` + existing voice pipeline.

---

## Dependency Status

| Package | Purpose | Status |
|---|---|---|
| `discord.js` | Discord framework | Active |
| `@discordjs/voice` | Voice channel support | Active |
| `@discordjs/opus` | Audio encoding | Active |
| `openai` | TTS only (`tts-1`) | Active |
| `fluent-ffmpeg` | PCM → WAV conversion | Active |
| `ffmpeg-static` | FFmpeg binary | Active |
| `prism-media` | Opus decoding | Active |
| `dotenv` | Env config | Active |
| `gtts` | Google TTS | ✅ Removed |
| `better-sqlite3` | Persistent memory | ❌ Not yet added |
| `pino` | Structured logging | ❌ Not yet added |

---

## Environment Variables

```
DISCORD_TOKEN=          # Discord bot token (discord.com/developers/applications → Bot)
APPLICATION_ID=         # Discord application ID (General Information)
GROQ_API_KEY=           # Groq API key — free tier (console.groq.com)
OPENAI_API_KEY=         # OpenAI key — TTS only (platform.openai.com)
FORTNITE_API_KEY=       # Optional (fortnite-api.com)
```

---

## Hosting Notes

Oracle VM compatibility is maintained via `safeDeleteFile`, pre-created `audio/` directory, and the 10-minute orphaned file cleanup interval. Keep these regardless of host.
