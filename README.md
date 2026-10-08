# NiklasBot

A Discord bot that joins voice calls and talks back — ambient voice AI plus text chat, powered by Groq (chat + transcription) and OpenAI (text-to-speech).

## Setup

1. Copy `.env.example` to `.env`
2. Fill in your API keys in `.env`:
   - `DISCORD_TOKEN` - Your Discord bot token
   - `APPLICATION_ID` - Your Discord application ID
   - `GROQ_API_KEY` - Your Groq API key (free tier)
   - `OPENAI_API_KEY` - Your OpenAI API key (TTS only)
   - `FORTNITE_API_KEY` - Your Fortnite API key (optional)

3. Install dependencies:
   ```bash
   npm install
   ```

4. Run the bot:
   ```bash
   node index.js
   ```

## Commands

- `/joincall` - Join your voice channel and start listening continuously
- `/leavecall` - Leave the voice channel and clear session memory
- `stop` (typed in a text channel) - Also stops the voice session
- `/message-nikbot message:<text>` - Chat with Nikbot over text
- `/fortnite` - Get latest Fortnite cosmetics and shop items
- `/settings` - View current per-server settings and memory status
- `/setpatience seconds:<3-60>` - Seconds of dead air before Nikbot might chime in unprompted
- `/setprompt prompt:<text>` - Update Nikbot's voice personality for this server
- `/currentprompt` - Show the current voice personality
- `/help` - Show all commands

## Features

- **Ambient voice conversations**: joins a voice channel and listens continuously — no fixed recording window. Replies immediately when addressed by name (or a mangled version of it); otherwise only chimes in unprompted after a configurable stretch of dead air, and stays quiet the rest of the time.
- **Turn-aware**: waits for the channel to actually go quiet before speaking, and stops immediately if anyone starts talking while it's replying.
- **Text chat**: `/message-nikbot` for direct text conversation with the same personality.
- **Per-server prompts and settings**: each server can customize Nikbot's personality and patience.
- **Fortnite integration**: shows latest cosmetics and shop items.
- **Session memory**: remembers the conversation while connected; voice memory clears when it leaves the call, text memory keeps the last 20 exchanges.
- **Oracle VM compatible**: robust file handling for cloud hosting (not required for local use).

See `development.md` for implementation notes and the current status of known issues.
