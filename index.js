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
// lullThresholdMs: how long the whole channel must be quiet before Nikbot
// considers chiming in unprompted. Being directly addressed bypasses this.
const DEFAULT_SETTINGS = { lullThresholdMs: 9000 };
const guildSettings = new Map();

function getGuildSettings(guildId) {
  const s = guildSettings.get(guildId) || {};
  return {
    lullThresholdMs: (s.lullThresholdMs > 0) ? s.lullThresholdMs : DEFAULT_SETTINGS.lullThresholdMs,
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

// --- Voice session state ---
// One entry per guild currently in a call. Replaces the old fixed-interval
// recording loop: listening is continuous and event-driven instead.
const voiceSessions = new Map();
const textMemory = new Map();
const textCooldowns = new Map(); // userId -> last used timestamp

const TEXT_COOLDOWN_MS = 5000;
const PER_USER_SILENCE_MS = 1300;   // pause length that ends one person's utterance
const LULL_CHECK_INTERVAL_MS = 2000; // how often to check for dead air
const AMBIENT_COOLDOWN_MS = 25000;  // minimum gap between two unprompted comments
const MAX_SPEAK_WAIT_MS = 8000;     // give up waiting for quiet and speak anyway
const TRANSCRIPT_MAX_LINES = 40;    // rolling transcript kept per session (human lines + Nikbot's own)
const SILENT_TOKEN = "SILENT";

function createVoiceSession(connection) {
  return {
    connection,
    transcript: [],            // { speaker, text, ts }
    speakingUsers: new Set(),  // userIds currently talking right now
    activeRecordings: new Set(), // userIds mid-utterance capture
    lastActivityAt: Date.now(),
    lastAmbientAt: 0,
    processing: false,
    ttsPlayer: null,
    lullWatcher: null,
  };
}

function teardownVoiceSession(guildId) {
  const session = voiceSessions.get(guildId);
  if (session?.lullWatcher) clearInterval(session.lullWatcher);
  voiceSessions.delete(guildId);
}

// messageCreate is only used to handle the "stop" keyword
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const guildId = message.guild?.id;

  if (/stop/i.test(message.content) && voiceSessions.has(guildId)) {
    teardownVoiceSession(guildId);

    const connection = getVoiceConnection(guildId);
    if (connection) connection.destroy();

    message.channel.send("Stopped listening and left the voice channel. Voice memory cleared.");
  }
});

// Starts continuous listening for a guild's call: every user's speech is
// captured as its own utterance (no fixed window), transcribed as soon as
// they pause, and fed into one of two reply triggers — direct address
// (immediate) or dead-air ambient commentary (patient). Both triggers route
// through speakWhenClear() so Nikbot never starts talking over someone, and
// an active reply is cut off immediately if anyone starts speaking (barge-in).
function startListening(connection, guildId) {
  try { CHANGING_PROMPT = fs.readFileSync("changingPrompt.txt", "utf-8").trim(); } catch {}

  const session = createVoiceSession(connection);
  voiceSessions.set(guildId, session);

  const receiver = connection.receiver;

  receiver.speaking.on("start", (userId) => {
    session.speakingUsers.add(userId);
    session.lastActivityAt = Date.now();

    // Barge-in: anyone talking cuts off whatever Nikbot is currently saying.
    if (session.ttsPlayer) {
      try { session.ttsPlayer.stop(); } catch {}
    }

    if (session.activeRecordings.has(userId)) return; // already capturing this person
    beginUserRecording(guildId, userId).catch(e => console.error("beginUserRecording error:", e));
  });

  receiver.speaking.on("end", (userId) => {
    session.speakingUsers.delete(userId);
  });

  session.lullWatcher = setInterval(() => {
    checkForLull(guildId).catch(e => console.error("checkForLull error:", e));
  }, LULL_CHECK_INTERVAL_MS);

  console.log(`✅ Listening continuously in guild ${guildId}`);
}

async function beginUserRecording(guildId, userId) {
  const session = voiceSessions.get(guildId);
  if (!session) return;
  session.activeRecordings.add(userId);

  let username = userId;
  try {
    const user = await client.users.fetch(userId);
    username = user.username;
  } catch (e) {
    console.error(`Could not fetch username for ${userId}:`, e.message);
  }

  const pcmPath = `audio/${username}-${Date.now()}.pcm`;
  const fileStream = fs.createWriteStream(pcmPath);
  const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

  const userStream = session.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: PER_USER_SILENCE_MS },
  });

  userStream.pipe(opusDecoder).pipe(fileStream);

  fileStream.on("finish", () => {
    session.activeRecordings.delete(userId);
    finalizeUtterance(guildId, username, pcmPath).catch(e => console.error("finalizeUtterance error:", e));
  });
}

async function finalizeUtterance(guildId, username, pcmPath) {
  const wavPath = pcmPath.replace(".pcm", ".wav");

  const converted = await new Promise((resolve) => {
    exec(`"${ffmpegPath}" -y -f s16le -ar 48000 -ac 2 -i "${pcmPath}" -ar 16000 -ac 1 "${wavPath}"`, (err) => {
      resolve(!err && fs.existsSync(wavPath));
    });
  });

  if (!converted) {
    console.error(`FFmpeg failed for ${username}`);
    safeDeleteFile(wavPath, "failed WAV file");
    safeDeleteFile(pcmPath, "failed PCM file");
    return;
  }

  let text = "";
  try {
    text = await transcribeAudio(wavPath);
  } catch (e) {
    console.error(`Transcription failed for ${username}:`, e.message);
  } finally {
    safeDeleteFile(wavPath, "processed WAV file");
    safeDeleteFile(pcmPath, "processed PCM file");
  }

  text = text.trim();
  if (!text) return;
  console.log(`Transcribed ${username}: "${text}"`);

  const session = voiceSessions.get(guildId);
  if (!session) return; // session ended while we were transcribing

  session.transcript.push({ speaker: username, text, ts: Date.now() });
  if (session.transcript.length > TRANSCRIPT_MAX_LINES) {
    session.transcript.splice(0, session.transcript.length - TRANSCRIPT_MAX_LINES);
  }
  session.lastActivityAt = Date.now();

  await maybeRespondToAddress(guildId);
}

function formatTranscript(session, maxEntries = 16) {
  return session.transcript.slice(-maxEntries).map(l => `${l.speaker}: ${l.text}`).join("\n");
}

function isSilent(reply) {
  return reply.trim().replace(/[.!"'`]+$/g, "").toUpperCase() === SILENT_TOKEN;
}

// Records what Nikbot said back into the same rolling transcript everything
// else lives in, so its own prior remarks are part of the context for the
// next call — no separate chat-history store to keep in sync.
function recordOwnReply(session, text) {
  session.transcript.push({ speaker: "Nikbot", text, ts: Date.now() });
  if (session.transcript.length > TRANSCRIPT_MAX_LINES) {
    session.transcript.splice(0, session.transcript.length - TRANSCRIPT_MAX_LINES);
  }
}

// Single model call shared by both reply triggers — situationNote tells the
// model which mode it's in (addressed vs. ambient) and that SILENT is a
// valid, expected answer. The rolling transcript (human speech + Nikbot's
// own past replies) is the only context — no separate memory store.
async function callVoiceModel(guildId, situationNote) {
  const session = voiceSessions.get(guildId);
  const guildChangingPrompt = guildChangingPrompts.get(guildId) || CHANGING_PROMPT;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT + guildChangingPrompt },
    { role: "user", content: `${situationNote}\n\nRecent conversation:\n${formatTranscript(session)}` }
  ];

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages,
    temperature: 0.7
  });

  return response.choices[0].message.content.trim().replace(/^Nikbot:\s*/i, '');
}

// Fast path: fires after every finished utterance. Responds immediately if
// directly addressed, otherwise stays silent (the lull watcher handles
// unprompted commentary instead).
async function maybeRespondToAddress(guildId) {
  const session = voiceSessions.get(guildId);
  if (!session || session.processing) return;

  session.processing = true;
  try {
    const reply = await callVoiceModel(
      guildId,
      `Someone just finished speaking. If they were directly addressing you, respond now. ` +
      `If not, reply with exactly "${SILENT_TOKEN}" and nothing else.`
    );
    if (isSilent(reply)) return;

    console.log(`AI response (addressed): "${reply}"`);
    recordOwnReply(session, reply);
    await speakWhenClear(guildId, reply);
    session.lastAmbientAt = Date.now();
  } finally {
    session.processing = false;
  }
}

// Patient path: polled on a timer, only acts once the whole channel has been
// quiet for lullThresholdMs and an ambient cooldown has passed. Heavily
// biased toward staying silent — see prompt.txt.
async function checkForLull(guildId) {
  const session = voiceSessions.get(guildId);
  if (!session || session.processing) return;
  if (session.speakingUsers.size > 0) return;
  if (session.transcript.length === 0) return;

  const { lullThresholdMs } = getGuildSettings(guildId);
  if (Date.now() - session.lastActivityAt < lullThresholdMs) return;
  if (Date.now() - session.lastAmbientAt < AMBIENT_COOLDOWN_MS) return;

  session.processing = true;
  try {
    const reply = await callVoiceModel(
      guildId,
      `There's been a lull — nobody has spoken in a while. Only say something if you genuinely ` +
      `have something worth adding; staying quiet is the default and usually correct. If you have ` +
      `nothing worth adding, reply with exactly "${SILENT_TOKEN}" and nothing else.`
    );
    session.lastAmbientAt = Date.now();
    if (isSilent(reply)) return;

    console.log(`AI response (ambient): "${reply}"`);
    recordOwnReply(session, reply);
    await speakWhenClear(guildId, reply);
  } finally {
    session.processing = false;
  }
}

// Holds a reply until the whole channel is quiet (or MAX_SPEAK_WAIT_MS
// elapses) so Nikbot never starts talking over someone mid-sentence.
async function speakWhenClear(guildId, text) {
  const session = voiceSessions.get(guildId);
  if (!session) return;

  const start = Date.now();
  while (session.speakingUsers.size > 0 && Date.now() - start < MAX_SPEAK_WAIT_MS) {
    await new Promise(r => setTimeout(r, 250));
  }

  try {
    await speak(session.connection, text, session);
  } catch (e) {
    console.error("❌ TTS error:", e.message);
  }
}

async function transcribeAudio(audioPath) {
  const fileStream = fs.createReadStream(audioPath);
  const transcription = await groq.audio.transcriptions.create({
    file: fileStream,
    model: "whisper-large-v3-turbo",
  });
  return transcription.text;
}

// session is optional — when passed, its ttsPlayer is tracked so the
// channel-wide barge-in listener in startListening() can stop playback
// the instant someone starts talking.
async function speak(connection, text, session = null) {
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
    if (session) session.ttsPlayer = ttsPlayer;
    ttsPlayer.play(ttsResource);

    const clearSession = () => { if (session && session.ttsPlayer === ttsPlayer) session.ttsPlayer = null; };

    ttsPlayer.on(AudioPlayerStatus.Idle, () => {
      clearSession();
      safeDeleteFile(ttsPath, "TTS audio file");
      resolve();
    });

    ttsPlayer.on("error", (err) => {
      clearSession();
      console.error("TTS Playback Error:", err);
      reject(err);
    });
  });
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
    name: 'setpatience',
    description: 'Seconds of dead air before Nikbot might chime in unprompted (per-server)',
    options: [
      {
        name: 'seconds',
        description: 'Seconds of silence before considering an unprompted comment',
        type: 4,
        required: true,
        min_value: 3,
        max_value: 60
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
        teardownVoiceSession(guildId);
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

      const { lullThresholdMs } = getGuildSettings(guildId);

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
          teardownVoiceSession(guildId);
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
                     `**Listening continuously — jump in anytime**\n` +
                     `Replies right away when addressed by name; otherwise only chimes in after ~${lullThresholdMs / 1000}s of dead air\n` +
                     `**Session memory enabled**\n` +
                     `Type \`stop\` or \`/leavecall\` to end the session\n` +
                     `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
          });
        } catch (e) {
          console.log('⚠️ Could not send join confirmation');
        }
      }

      const startSession = () => startListening(connection, guildId);

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
      teardownVoiceSession(guildId);
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
        `• \`/setpatience seconds:<3-60>\` - Dead air before an unprompted comment\n` +
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
      const voiceSession = voiceSessions.get(guildId);
      const textMem = textMemory.get(guildId) || [];
      const { lullThresholdMs } = getGuildSettings(guildId);

      const settingsMessage = `**Nikbot Settings**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `**Voice (this server):**\n` +
        `• Patience before unprompted comment: ${lullThresholdMs / 1000}s\n` +
        `• Always responds immediately when addressed by name\n\n` +
        `**Memory:**\n` +
        `• Voice: ${voiceSession ? voiceSession.transcript.length : 0} lines (clears on exit)\n` +
        `• Text: ${textMem.length} messages (last 20 exchanges)\n\n` +
        `**Voice Session:** ${voiceSession ? 'Active' : 'Inactive'}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      await interaction.reply(settingsMessage);
    }

    else if (commandName === 'setpatience') {
      const seconds = options.getInteger('seconds');
      setGuildSetting(guildId, 'lullThresholdMs', seconds * 1000);
      await interaction.reply(`✅ Patience set to ${seconds}s of dead air before an unprompted comment, for this server`);
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
