require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} = require("@discordjs/voice");
const fs = require("fs");
const { exec } = require("child_process");
const path = require("path");
const prism = require("prism-media");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
process.env.FFMPEG_PATH = ffmpegPath; // prism-media / @discordjs/voice use this env var to find ffmpeg

const OpenAI = require("openai");

// OpenAI is used only for TTS (tts-1)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Groq handles chat completions and transcription (free tier, OpenAI-compatible)
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

ffmpeg.setFfmpegPath(ffmpegPath);

// Ensure audio directory exists for Oracle VM compatibility
if (!fs.existsSync('audio')) {
  fs.mkdirSync('audio', { recursive: true });
  console.log('📁 Created audio directory');
}

function safeFileOperation(operation, errorMessage) {
  try {
    return operation();
  } catch (error) {
    console.error(errorMessage, error);
    return null;
  }
}

function safeDeleteFile(filePath, description) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🗑️ Cleaned up ${description}: ${filePath}`);
    }
  } catch (error) {
    console.error(`❌ Failed to delete ${description}:`, error);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
});

let SYSTEM_PROMPT = fs.readFileSync("prompt.txt", "utf-8").trim();
let CHANGING_PROMPT = fs.readFileSync("changingPrompt.txt", "utf-8").trim();
let TEXT_SYSTEM_PROMPT = fs.readFileSync("textPrompt.txt", "utf-8").trim();

// --- Per-guild prompts ---
const guildChangingPrompts = new Map();

function loadGuildPrompts() {
  try {
    if (fs.existsSync("guildPrompts.json")) {
      const saved = JSON.parse(fs.readFileSync("guildPrompts.json", "utf-8"));
      for (const [guildId, prompt] of Object.entries(saved)) {
        guildChangingPrompts.set(guildId, prompt);
      }
      console.log(`📝 Loaded ${Object.keys(saved).length} guild-specific prompts`);
    }
  } catch (error) {
    console.error("❌ Failed to load guild prompts:", error.message);
  }
}

function saveGuildPrompts() {
  try {
    fs.writeFileSync("guildPrompts.json", JSON.stringify(Object.fromEntries(guildChangingPrompts), null, 2));
  } catch (error) {
    console.error("❌ Failed to save guild prompts:", error.message);
  }
}

// --- Per-guild settings ---
const DEFAULT_SETTINGS = { recordDuration: 10000, repeatInterval: 120000 };
const guildSettings = new Map();

function getGuildSettings(guildId) {
  const s = guildSettings.get(guildId) || {};
  return {
    recordDuration: (s.recordDuration > 0) ? s.recordDuration : DEFAULT_SETTINGS.recordDuration,
    repeatInterval: (s.repeatInterval > 0) ? s.repeatInterval : DEFAULT_SETTINGS.repeatInterval,
  };
}

function setGuildSetting(guildId, key, value) {
  const current = getGuildSettings(guildId);
  guildSettings.set(guildId, { ...current, [key]: value });
  saveGuildSettings();
}

function loadGuildSettings() {
  try {
    if (fs.existsSync("guildSettings.json")) {
      const saved = JSON.parse(fs.readFileSync("guildSettings.json", "utf-8"));
      for (const [guildId, s] of Object.entries(saved)) {
        guildSettings.set(guildId, { ...DEFAULT_SETTINGS, ...s });
      }
      console.log(`⚙️ Loaded settings for ${Object.keys(saved).length} guilds`);
    }
  } catch (error) {
    console.error("❌ Failed to load guild settings:", error.message);
  }
}

function saveGuildSettings() {
  try {
    fs.writeFileSync("guildSettings.json", JSON.stringify(Object.fromEntries(guildSettings), null, 2));
  } catch (error) {
    console.error("❌ Failed to save guild settings:", error.message);
  }
}

loadGuildPrompts();
loadGuildSettings();

// Periodic cleanup of orphaned audio files (Oracle VM safety)
setInterval(() => {
  try {
    if (fs.existsSync('audio')) {
      const files = fs.readdirSync('audio');
      const now = Date.now();
      const maxAge = 5 * 60 * 1000;
      files.forEach(file => {
        const filePath = path.join('audio', file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtime.getTime() > maxAge) {
          safeDeleteFile(filePath, "orphaned audio file");
        }
      });
    }
  } catch (error) {
    console.error("❌ Cleanup error:", error);
  }
}, 10 * 60 * 1000);

const activeLoops = new Map();
const voiceMemory = new Map();
const textMemory = new Map();
const textCooldowns = new Map(); // userId -> last used timestamp

const TEXT_COOLDOWN_MS = 5000;

// messageCreate is only used to handle the "stop" keyword
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const guildId = message.guild?.id;

  if (/stop/i.test(message.content) && activeLoops.has(guildId)) {
    clearInterval(activeLoops.get(guildId));
    activeLoops.delete(guildId);
    voiceMemory.delete(guildId);

    const connection = getVoiceConnection(guildId);
    if (connection) connection.destroy();

    message.channel.send("Stopped recording loop and left the voice channel. Voice memory cleared.");
  }
});

async function recordAndRespond(connection, guildId, channel) {
  // Reload the changing prompt before each cycle in case it was updated on disk
  try { CHANGING_PROMPT = fs.readFileSync("changingPrompt.txt", "utf-8").trim(); } catch {}

  const { recordDuration } = getGuildSettings(guildId);
  const receiver = connection.receiver;
  const activeUsers = new Map();
  console.log("Recording started...");

  receiver.speaking.on("start", async (userId) => {
    console.log(`🎤 Speaking event for userId: ${userId}`);
    if (activeUsers.has(userId)) return;

    let username = userId;
    try {
      const user = await client.users.fetch(userId);
      username = user.username;
    } catch (e) {
      console.error(`Could not fetch username for ${userId}:`, e.message);
    }

    const pcmPath = `audio/${username}-${Date.now()}.pcm`;
    const fileStream = fs.createWriteStream(pcmPath);

    const opusDecoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    const userStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 5000 },
    });

    userStream.pipe(opusDecoder).pipe(fileStream);
    activeUsers.set(userId, { username, fileStream, pcmPath });

    fileStream.on("finish", () => {
      console.log(`Finished writing for ${username}`);
    });
  });

  setTimeout(async () => {
    receiver.speaking.removeAllListeners("start");

    if (activeUsers.size === 0) {
      console.log("No speech detected this cycle — skipping.");
      return;
    }

    try { await speak(connection, "Got it, one moment."); }
    catch (e) { console.error("❌ TTS error:", e.message); }

    console.log(`Transcribing ${activeUsers.size} user(s)...`);

    const transcriptLines = [];

    for (const [userId, { username, pcmPath }] of activeUsers.entries()) {
      const wavPath = pcmPath.replace(".pcm", ".wav");

      await new Promise((resolve) => {
        exec(`"${ffmpegPath}" -y -f s16le -ar 48000 -ac 2 -i "${pcmPath}" -ar 16000 -ac 1 "${wavPath}"`, async (err) => {
          if (err || !fs.existsSync(wavPath)) {
            console.error(`FFmpeg failed for ${username}:`, err);
            safeDeleteFile(wavPath, "failed WAV file");
            safeDeleteFile(pcmPath, "failed PCM file");
            resolve();
            return;
          }
          try {
            const transcription = await transcribeAudio(wavPath);
            console.log(`Transcribed ${username}: "${transcription}"`);
            transcriptLines.push(`[${username}]: ${transcription}`);
          } catch (e) {
            console.error(`Transcription failed for ${username}:`, e);
          } finally {
            safeDeleteFile(wavPath, "processed WAV file");
            safeDeleteFile(pcmPath, "processed PCM file");
            resolve();
          }
        });
      });
    }

    const fullTranscript = transcriptLines.join("\n");
    if (!fullTranscript.trim()) {
      console.log("Transcription empty — skipping AI response.");
      return;
    }

    console.log("Sending to AI...");
    const chatGptReply = await askOpenAI(fullTranscript, guildId);
    console.log(`AI response: "${chatGptReply}"`);

    try { await speak(connection, chatGptReply); }
    catch (e) { console.error("❌ TTS error (response):", e.message); }

  }, recordDuration);
}

async function transcribeAudio(audioPath) {
  const fileStream = fs.createReadStream(audioPath);
  const transcription = await groq.audio.transcriptions.create({
    file: fileStream,
    model: "whisper-large-v3-turbo",
  });
  return transcription.text;
}

async function speak(connection, text) {
  const ttsPath = `audio/tts-${Date.now()}.mp3`;
  console.log(`Speaking: ${text}`);

  const mp3Response = await openai.audio.speech.create({
    model: "tts-1",
    voice: "alloy",
    input: text,
  });

  const buffer = Buffer.from(await mp3Response.arrayBuffer());
  fs.writeFileSync(ttsPath, buffer);

  return new Promise((resolve, reject) => {
    const ttsPlayer = createAudioPlayer();
    const ttsResource = createAudioResource(ttsPath);
    connection.subscribe(ttsPlayer);
    ttsPlayer.play(ttsResource);

    ttsPlayer.on(AudioPlayerStatus.Idle, () => {
      safeDeleteFile(ttsPath, "TTS audio file");
      resolve();
    });

    ttsPlayer.on("error", (err) => {
      console.error("TTS Playback Error:", err);
      reject(err);
    });
  });
}

async function askOpenAI(promptText, guildId) {
  try {
    const memory = voiceMemory.get(guildId) || [];
    const guildChangingPrompt = guildChangingPrompts.get(guildId) || CHANGING_PROMPT;

    const messages = [
      { role: "system", content: SYSTEM_PROMPT + guildChangingPrompt },
      ...memory.slice(-10),
      { role: "user", content: promptText }
    ];

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature: 0.7
    });

    let botResponse = response.choices[0].message.content.trim().replace(/^Nikbot:\s*/i, '');

    memory.push({ role: "user", content: promptText });
    memory.push({ role: "assistant", content: botResponse });
    if (memory.length > 40) memory.splice(0, memory.length - 40);
    voiceMemory.set(guildId, memory);

    return botResponse;
  } catch (error) {
    console.error("Groq error:", error.response?.data || error.message);
    return "Failed to contact Groq.";
  }
}

async function askOpenAIText(promptText, guildId) {
  try {
    const memory = textMemory.get(guildId) || [];

    const messages = [
      { role: "system", content: TEXT_SYSTEM_PROMPT },
      ...memory.slice(-10),
      { role: "user", content: promptText }
    ];

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature: 0.7
    });

    let botResponse = response.choices[0].message.content.trim().replace(/^Nikbot:\s*/i, '');

    memory.push({ role: "user", content: promptText });
    memory.push({ role: "assistant", content: botResponse });
    if (memory.length > 40) memory.splice(0, memory.length - 40);
    textMemory.set(guildId, memory);

    return botResponse;
  } catch (error) {
    console.error("Groq text error:", error.response?.data || error.message);
    return "Failed to contact Groq.";
  }
}

async function getFortniteShop() {
  try {
    const apiKey = process.env.FORTNITE_API_KEY;
    const headers = { 'User-Agent': 'NiklasBot/1.0' };
    if (apiKey) headers['Authorization'] = apiKey;

    const response = await fetch('https://fortnite-api.com/v2/cosmetics/new', { headers });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} - ${response.statusText}`);
    }

    const data = await response.json();

    if (!data || !data.data || !data.data.items) {
      throw new Error('No cosmetics data available');
    }

    let shopMessage = `**Latest Fortnite Cosmetics**\n`;
    shopMessage += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    const brItems = data.data.items.br || [];
    const legoItems = data.data.items.lego || [];
    const carItems = data.data.items.cars || [];

    if (brItems.length > 0) {
      shopMessage += `**🎮 Battle Royale Items:**\n`;
      brItems.slice(0, 8).forEach(item => {
        try {
          const name = item.name || 'Unknown Item';
          const type = item.type?.displayValue || 'Cosmetic';
          const rarity = item.rarity?.displayValue || 'Unknown';
          const set = item.set?.value || '';
          const description = item.description || '';

          let priceInfo = '';
          if (item.price) {
            priceInfo = ` • ${item.price} V-Bucks`;
          } else if (item.finalPrice) {
            priceInfo = ` • ${item.finalPrice} V-Bucks`;
          } else if (item.regularPrice) {
            priceInfo = ` • ${item.regularPrice} V-Bucks`;
          } else {
            const rarityPrices = {
              'Common': '500 V-Bucks',
              'Uncommon': '800 V-Bucks',
              'Rare': '1,200 V-Bucks',
              'Epic': '1,500 V-Bucks',
              'Legendary': '2,000 V-Bucks',
              'Mythic': '2,500 V-Bucks'
            };
            priceInfo = ` • ~${rarityPrices[rarity] || 'Unknown Price'}`;
          }

          shopMessage += `[${rarity.toUpperCase()}] **${name}**${priceInfo}\n`;
          shopMessage += `   ${type}${set ? ` • ${set}` : ''}\n`;
          if (description) shopMessage += `   *${description}*\n`;
          shopMessage += `\n`;
        } catch (itemError) {
          console.log('Error processing BR item:', itemError);
        }
      });
    }

    if (legoItems.length > 0) {
      shopMessage += `**LEGO Items:**\n`;
      legoItems.slice(0, 4).forEach(item => {
        try {
          const cosmeticId = item.cosmeticId || 'Unknown';
          const name = cosmeticId.replace('Character_', '').replace(/_/g, ' ');
          shopMessage += `• **${name}** • Free (LEGO Fortnite)\n`;
        } catch (itemError) {
          console.log('Error processing LEGO item:', itemError);
        }
      });
      shopMessage += `\n`;
    }

    if (carItems.length > 0) {
      shopMessage += `**Vehicle Items:**\n`;
      carItems.slice(0, 4).forEach(item => {
        try {
          const name = item.name || 'Unknown Vehicle';
          const rarity = item.rarity?.displayValue || 'Unknown';

          let priceInfo = '';
          if (item.price) {
            priceInfo = ` • ${item.price} V-Bucks`;
          } else if (item.finalPrice) {
            priceInfo = ` • ${item.finalPrice} V-Bucks`;
          } else if (item.regularPrice) {
            priceInfo = ` • ${item.regularPrice} V-Bucks`;
          } else {
            const vehiclePrices = {
              'Common': '200 V-Bucks',
              'Uncommon': '400 V-Bucks',
              'Rare': '600 V-Bucks',
              'Epic': '800 V-Bucks',
              'Legendary': '1,000 V-Bucks'
            };
            priceInfo = ` • ~${vehiclePrices[rarity] || 'Unknown Price'}`;
          }

          shopMessage += `[${rarity.toUpperCase()}] **${name}**${priceInfo}\n`;
        } catch (itemError) {
          console.log('Error processing car item:', itemError);
        }
      });
      shopMessage += `\n`;
    }

    if (data.data.build) {
      shopMessage += `**Build:** ${data.data.build.replace(/\\u002B/g, '+')}\n`;
    }
    if (data.data.lastAdditions) {
      shopMessage += `**Last Updated:** ${new Date(data.data.lastAdditions.br).toLocaleString()}\n`;
    }

    shopMessage += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    shopMessage += `Use \`/fortnite\` to check again!`;

    return shopMessage;

  } catch (error) {
    console.error("Fortnite shop fetch error:", error);

    try {
      const fallbackResponse = await fetch('https://fnbr.co/api/shop', {
        headers: { 'User-Agent': 'NiklasBot/1.0' }
      });
      if (fallbackResponse.ok) {
        const fallbackData = await fallbackResponse.json();
        if (fallbackData && fallbackData.data) {
          return `**Fortnite Cosmetics**\n` +
                 `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                 `Fallback data available — cosmetics update regularly.\n` +
                 `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        }
      }
    } catch (fallbackError) {
      console.log("Fallback API also failed:", fallbackError);
    }

    return `**Fortnite Cosmetics**\n` +
           `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
           `**Unable to fetch cosmetics data**\n\n` +
           `**Possible reasons:**\n` +
           `• Fortnite API requires authentication\n` +
           `• API is temporarily down\n` +
           `• Network connection issues\n\n` +
           `**To fix:** Add \`FORTNITE_API_KEY=your_key\` to your .env file\n` +
           `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }
}

// Slash command definitions — single source of truth used by both registerSlashCommands and guildCreate
const SLASH_COMMANDS = [
  {
    name: 'message-nikbot',
    description: 'Chat with Nikbot (text responses)',
    options: [
      {
        name: 'message',
        description: 'Your message to Nikbot',
        type: 3,
        required: true
      }
    ]
  },
  {
    name: 'joincall',
    description: 'Join voice channel and start listening for conversations'
  },
  {
    name: 'leavecall',
    description: 'Leave the voice channel and stop the session'
  },
  {
    name: 'fortnite',
    description: 'Get latest Fortnite cosmetics and shop items'
  },
  {
    name: 'help',
    description: 'Show all available commands and their usage'
  },
  {
    name: 'settings',
    description: 'Show current bot settings and memory status'
  },
  {
    name: 'setrecord',
    description: 'Set recording duration in seconds (per-server)',
    options: [
      {
        name: 'seconds',
        description: 'Recording duration in seconds',
        type: 4,
        required: true,
        min_value: 5,
        max_value: 60
      }
    ]
  },
  {
    name: 'setrepeat',
    description: 'Set repeat interval in seconds (per-server)',
    options: [
      {
        name: 'seconds',
        description: 'Repeat interval in seconds',
        type: 4,
        required: true,
        min_value: 120,
        max_value: 500
      }
    ]
  },
  {
    name: 'setprompt',
    description: 'Update the voice changing prompt for this server',
    options: [
      {
        name: 'prompt',
        description: 'New voice changing prompt text',
        type: 3,
        required: true
      }
    ]
  },
  {
    name: 'currentprompt',
    description: 'Show the current voice changing prompt for this server'
  }
];

const registeredGuilds = new Set();

async function registerSlashCommands() {
  try {
    for (const [guildId, guild] of client.guilds.cache) {
      if (registeredGuilds.has(guildId)) continue;
      try {
        await guild.commands.set(SLASH_COMMANDS);
        registeredGuilds.add(guildId);
        console.log(`✅ Slash commands registered for guild: ${guild.name} (${guildId})`);
      } catch (error) {
        console.error(`❌ Error registering commands for guild ${guild.name}:`, error);
      }
    }
    console.log('✅ All guild slash commands registered!');
  } catch (error) {
    console.error('❌ Error registering slash commands:', error);
  }
}

client.on('guildCreate', async (guild) => {
  console.log(`Bot joined new guild: ${guild.name}`);
  try {
    await guild.commands.set(SLASH_COMMANDS);
    registeredGuilds.add(guild.id);
    console.log(`✅ Slash commands registered for new guild: ${guild.name}`);
  } catch (error) {
    console.error(`❌ Error registering commands for new guild ${guild.name}:`, error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, guildId } = interaction;

  try {
    if (commandName === 'message-nikbot') {
      const now = Date.now();
      const lastUsed = textCooldowns.get(interaction.user.id) || 0;
      const remaining = TEXT_COOLDOWN_MS - (now - lastUsed);
      if (remaining > 0) {
        await interaction.reply({ content: `Please wait ${(remaining / 1000).toFixed(1)}s before sending another message.`, ephemeral: true });
        return;
      }
      textCooldowns.set(interaction.user.id, now);

      const message = options.getString('message');
      const response = await askOpenAIText(message, guildId);
      await interaction.reply(response);
    }

    else if (commandName === 'joincall') {
      const member = interaction.member;
      if (!member.voice.channel) {
        await interaction.reply('You need to be in a voice channel to use this command!');
        return;
      }

      const existingConnection = getVoiceConnection(guildId);
      if (existingConnection) {
        if (existingConnection.state.status === VoiceConnectionStatus.Ready) {
          await interaction.reply("I'm already in a voice channel in this server!");
          return;
        }
        // Stale/disconnected connection — destroy it and re-join
        clearInterval(activeLoops.get(guildId));
        activeLoops.delete(guildId);
        voiceMemory.delete(guildId);
        try { existingConnection.destroy(); } catch {}
      }

      // Acknowledge within 3s — if it fails (stale interaction on restart), join anyway
      let interactionDeferred = false;
      try {
        await interaction.deferReply();
        interactionDeferred = true;
      } catch (e) {
        console.log('⚠️ Interaction expired before deferReply — joining anyway');
      }

      const channel = interaction.channel;

      const connection = joinVoiceChannel({
        channelId: member.voice.channel.id,
        guildId: guildId,
        adapterCreator: member.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      voiceMemory.set(guildId, []);
      const { repeatInterval } = getGuildSettings(guildId);

      // Auto-reconnect on unexpected disconnect
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
          console.log(`🔄 Reconnected to voice in guild ${guildId}`);
        } catch {
          console.log(`❌ Could not reconnect in guild ${guildId}, cleaning up`);
          clearInterval(activeLoops.get(guildId));
          activeLoops.delete(guildId);
          voiceMemory.delete(guildId);
          try { connection.destroy(); } catch {}
          try {
            channel.send("Voice connection lost and could not reconnect. Use `/joincall` to start a new session.");
          } catch {}
        }
      });

      if (interactionDeferred) {
        try {
          await interaction.editReply({
            content: `**Nikbot joined the voice call!**\n` +
                     `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                     `**Listening for conversations...**\n` +
                     `Recording every ${repeatInterval / 1000} seconds\n` +
                     `**Session memory enabled**\n` +
                     `Type \`stop\` or \`/leavecall\` to end the session\n` +
                     `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
          });
        } catch (e) {
          console.log('⚠️ Could not send join confirmation');
        }
      }

      const startSession = () => {
        console.log(`✅ Voice connection Ready for guild ${guildId} — starting recording`);
        recordAndRespond(connection, guildId, channel).catch(e => console.error("Initial recording error:", e));
        const loop = setInterval(async () => {
          try {
            await recordAndRespond(connection, guildId, channel);
          } catch (error) {
            console.error("Recording loop error:", error);
          }
        }, getGuildSettings(guildId).repeatInterval);
        activeLoops.set(guildId, loop);
      };

      if (connection.state.status === VoiceConnectionStatus.Ready) {
        startSession();
      } else {
        connection.once(VoiceConnectionStatus.Ready, startSession);
      }
    }

    else if (commandName === 'leavecall') {
      const conn = getVoiceConnection(guildId);
      if (!conn) {
        await interaction.reply("I'm not in a voice channel.");
        return;
      }
      clearInterval(activeLoops.get(guildId));
      activeLoops.delete(guildId);
      voiceMemory.delete(guildId);
      try { conn.destroy(); } catch {}
      await interaction.reply("Left the voice channel. Session memory cleared.");
    }

    else if (commandName === 'fortnite') {
      await interaction.deferReply();
      const shopData = await getFortniteShop();
      await interaction.editReply(shopData);
    }

    else if (commandName === 'help') {
      const helpMessage = `**Nikbot Commands**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `**Voice:**\n` +
        `• \`/joincall\` - Join voice channel and start listening\n` +
        `• \`/leavecall\` - Leave voice channel and clear session\n` +
        `• \`stop\` - Also stops voice session and clears memory\n\n` +
        `**Text:**\n` +
        `• \`/message-nikbot message:<text>\` - Chat with Nikbot\n\n` +
        `**Game:**\n` +
        `• \`/fortnite\` - Get latest Fortnite cosmetics\n\n` +
        `**Settings (per-server):**\n` +
        `• \`/setrecord seconds:<5-60>\` - Set recording duration\n` +
        `• \`/setrepeat seconds:<120-500>\` - Set repeat interval\n` +
        `• \`/setprompt prompt:<text>\` - Update voice personality\n` +
        `• \`/currentprompt\` - Show current voice personality\n` +
        `• \`/settings\` - View current settings\n\n` +
        `**Memory:**\n` +
        `• Voice: Clears when bot leaves call\n` +
        `• Text: Remembers last 20 exchanges\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      await interaction.reply(helpMessage);
    }

    else if (commandName === 'settings') {
      const voiceMem = voiceMemory.get(guildId) || [];
      const textMem = textMemory.get(guildId) || [];
      const { recordDuration, repeatInterval } = getGuildSettings(guildId);

      const settingsMessage = `**Nikbot Settings**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `**Recording (this server):**\n` +
        `• Record Duration: ${recordDuration / 1000}s\n` +
        `• Repeat Interval: ${repeatInterval / 1000}s\n\n` +
        `**Memory:**\n` +
        `• Voice: ${voiceMem.length} messages (clears on exit)\n` +
        `• Text: ${textMem.length} messages (last 20 exchanges)\n\n` +
        `**Voice Loop:** ${activeLoops.has(guildId) ? 'Active' : 'Inactive'}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      await interaction.reply(settingsMessage);
    }

    else if (commandName === 'setrecord') {
      const seconds = options.getInteger('seconds');
      setGuildSetting(guildId, 'recordDuration', seconds * 1000);
      await interaction.reply(`✅ Recording duration set to ${seconds} seconds for this server`);
    }

    else if (commandName === 'setrepeat') {
      const seconds = options.getInteger('seconds');
      setGuildSetting(guildId, 'repeatInterval', seconds * 1000);
      await interaction.reply(`✅ Repeat interval set to ${seconds} seconds for this server`);
    }

    else if (commandName === 'setprompt') {
      const prompt = options.getString('prompt');
      guildChangingPrompts.set(guildId, prompt);
      saveGuildPrompts();
      await interaction.reply(`✅ Voice personality updated for this server`);
    }

    else if (commandName === 'currentprompt') {
      const currentPrompt = guildChangingPrompts.get(guildId) || CHANGING_PROMPT;
      const promptMessage = `**Current Voice Personality**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `\`\`\`\n${currentPrompt}\n\`\`\`\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `*Use \`/setprompt\` to change it*`;
      await interaction.reply(promptMessage);
    }

  } catch (error) {
    console.error('Slash command error:', error);
    try {
      if (interaction.deferred) {
        await interaction.editReply('Sorry, there was an error processing that command.');
      } else {
        await interaction.reply('Sorry, there was an error processing that command.');
      }
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN).then(async () => {
  console.log("Bot login attempt successful.");
  await registerSlashCommands();
}).catch(err => {
  console.error("Login failed:", err);
});
