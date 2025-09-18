# NiklasBot

A Discord bot that joins voice calls and responds to conversations using OpenAI and text-to-speech.

## Setup

1. Copy `.env.example` to `.env`
2. Fill in your API keys in `.env`:
   - `DISCORD_TOKEN` - Your Discord bot token
   - `OPENAI_API_KEY` - Your OpenAI API key
   - `FORTNITE_API_KEY` - Your Fortnite API key (optional)
   - `APPLICATION_ID` - Your Discord application ID

3. Install dependencies:
   ```bash
   npm install
   ```

4. Run the bot:
   ```bash
   node index.js
   ```

## Commands

### Slash Commands (Recommended)
- `/joincall` - Join voice channel and start listening
- `/message-nikbot message:<text>` - Chat with Nikbot
- `/fortnite` - Get latest Fortnite cosmetics
- `/settings` - View current settings
- `/currentprompt` - Show current voice changing prompt
- `/setrecord seconds:<number>` - Set recording duration
- `/setrepeat seconds:<number>` - Set repeat interval
- `/setprompt prompt:<text>` - Update voice changing prompt

### Legacy Commands
- `!joincall` - Join voice channel
- `!nikbot <message>` - Chat with Nikbot
- `!fortnite` - Get Fortnite cosmetics
- `!help` - Show all commands
- `!settings` - View settings

## Features

- **Voice Conversations**: Joins voice channels and responds to conversations
- **Text Chat**: Responds to text messages with AI
- **Per-Server Prompts**: Each server can customize the bot's personality
- **Fortnite Integration**: Shows latest cosmetics and shop items
- **Memory System**: Remembers conversations within sessions
- **Oracle VM Compatible**: Robust file handling for cloud hosting
