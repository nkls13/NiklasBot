# NiklasBot

A Discord bot that joins voice calls and talks back — ambient voice AI plus text chat. Groq (chat + transcription, free tier) and OpenAI (`tts-1` for voice).

**Any agent session in this repo:** read `development.md` (architecture/status) and `ROADMAP.md` (what's next, and what's off-limits unattended) before writing code. Scheduled/unattended runs follow `AUTOMATION.md` exactly. `DECISIONS.md` has the reasoning behind non-obvious choices already made.

- Stack: Node.js, `discord.js` + `@discordjs/voice`. `npm test` (unit tests, no Discord needed), `node --check index.js` (syntax). No lint script yet.
- Hard rule for scheduled runs: voice personality (`prompt.txt`/`textPrompt.txt`) and reply-trigger logic/timing in `index.js` need Niklas in a live Discord call to judge — never touched unattended. See `AUTOMATION.md`'s hard boundary.
- `lib/` holds pure logic extracted specifically so it's unit-testable without Discord/fs/network. New testable logic belongs there, not inline in `index.js`.
- Tested locally against Discord by Niklas directly — not hosted anywhere yet, and that's deliberate (see `ROADMAP.md`'s Hosting section).
- `.env` holds real secrets — never read, print, or commit it.
