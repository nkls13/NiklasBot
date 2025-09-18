require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
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
const gTTS = require("gtts");
const fetch = require("node-fetch");

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

ffmpeg.setFfmpegPath(ffmpegPath);

// Ensure audio directory exists for Oracle VM compatibility
if (!fs.existsSync('audio')) {
  fs.mkdirSync('audio', { recursive: true });
  console.log('📁 Created audio directory');
}

// Helper function for safe file operations
function safeFileOperation(operation, errorMessage) {
  try {
    return operation();
  } catch (error) {
    console.error(errorMessage, error);
    return null;
  }
}

// Helper function to safely delete files
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

// Per-guild changing prompts
const guildChangingPrompts = new Map(); // Key: guildId, Value: changing prompt text

// Load guild-specific prompts from file
function loadGuildPrompts() {
  try {
    if (fs.existsSync("guildPrompts.json")) {
      const savedPrompts = JSON.parse(fs.readFileSync("guildPrompts.json", "utf-8"));
      for (const [guildId, prompt] of Object.entries(savedPrompts)) {
        guildChangingPrompts.set(guildId, prompt);
      }
      console.log(`📝 Loaded ${Object.keys(savedPrompts).length} guild-specific prompts`);
    }
  } catch (error) {
    console.error("❌ Failed to load guild prompts:", error.message);
  }
}

// Save guild-specific prompts to file
function saveGuildPrompts() {
  try {
    const promptsObj = Object.fromEntries(guildChangingPrompts);
    fs.writeFileSync("guildPrompts.json", JSON.stringify(promptsObj, null, 2));
    console.log("💾 Saved guild prompts to file");
  } catch (error) {
    console.error("❌ Failed to save guild prompts:", error.message);
  }
}

// Function to reload the changing prompt from file
function reloadChangingPrompt() {
  try {
    CHANGING_PROMPT = fs.readFileSync("changingPrompt.txt", "utf-8").trim();
    console.log("Reloaded changing prompt from file");
  } catch (error) {
    console.error("Failed to reload changing prompt:", error.message);
  }
}

// Function to reload the text prompt from file
function reloadTextPrompt() {
  try {
    TEXT_SYSTEM_PROMPT = fs.readFileSync("textPrompt.txt", "utf-8").trim();
    console.log("Reloaded text prompt from file");
  } catch (error) {
    console.error("Failed to reload text prompt:", error.message);
  }
}
// Load settings from file or use defaults
let settings = {
  recordDuration: 20000, // in ms
  repeatInterval: 120000 // in ms
};

// Load settings from file
function loadSettings() {
  try {
    if (fs.existsSync("settings.json")) {
      const savedSettings = JSON.parse(fs.readFileSync("settings.json", "utf-8"));
      settings = { ...settings, ...savedSettings };
      console.log("Loaded settings from file");
    }
  } catch (error) {
    console.error("Failed to load settings:", error.message);
  }
}

// Save settings to file
function saveSettings() {
  try {
    fs.writeFileSync("settings.json", JSON.stringify(settings, null, 2));
    console.log("Settings saved to file");
  } catch (error) {
    console.error("Failed to save settings:", error.message);
  }
}

// Load settings and guild prompts on startup
loadSettings();
loadGuildPrompts();

// Periodic cleanup of orphaned audio files (Oracle VM safety)
setInterval(() => {
  try {
    if (fs.existsSync('audio')) {
      const files = fs.readdirSync('audio');
      const now = Date.now();
      const maxAge = 5 * 60 * 1000; // 5 minutes
      
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
}, 10 * 60 * 1000); // Run every 10 minutes

const activeLoops = new Map();
const voiceMemory = new Map(); // Key: guildId, Value: array of voice conversation messages (clears on exit)
const textMemory = new Map(); // Key: guildId, Value: array of text conversation messages (persistent, 20 exchanges)

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const guildId = message.guild?.id;

  if (/stop/i.test(message.content) && activeLoops.has(guildId)) {
    clearInterval(activeLoops.get(guildId));
    activeLoops.delete(guildId);
    voiceMemory.delete(guildId); // Clear voice memory when stopping

    const connection = getVoiceConnection(guildId);
    if (connection) connection.destroy();

    message.channel.send("Stopped recording loop and left the voice channel. Voice memory cleared.");
    return;
  }

    if (/^!setrecord (\d+)/i.test(message.content)) {
    const match = message.content.match(/^!setrecord (\d+)/i);
    settings.recordDuration = parseInt(match[1]) * 1000;
    saveSettings();
    return message.reply(`Set recording duration to ${match[1]} seconds.`);
  }

  if (/^!setrepeat (\d+)/i.test(message.content)) {
    const match = message.content.match(/^!setrepeat (\d+)/i);
    settings.repeatInterval = parseInt(match[1]) * 1000;
    saveSettings();
    return message.reply(`Set repeat interval to ${match[1]} seconds.`);
  }

  if (/^!setprompt /i.test(message.content)) {
    const prompt = message.content.replace(/^!setprompt /i, '').trim();
    guildChangingPrompts.set(guildId, prompt);
    saveGuildPrompts(); // Persist to file
    return message.reply("Updated changing prompt for this server.");
  }

  if (/^!reloadprompt$/i.test(message.content)) {
    reloadChangingPrompt();
    return message.reply("Reloaded changing prompt from file.");
  }


  if (/^!fortnite$/i.test(message.content)) {
    getFortniteShop().then(shopData => {
      message.reply(shopData);
    }).catch(error => {
      console.error("Fortnite API error:", error);
      message.reply("Sorry, couldn't fetch the Fortnite cosmetics right now. Try again later!");
    });
    return;
  }


  if (/^!nikbot /i.test(message.content)) {
    const userMessage = message.content.replace(/^!nikbot /i, '').trim();
    if (!userMessage) {
      return message.reply("Please provide a message for Nikbot to respond to!");
    }
    
    // Get or create text memory for this guild
    if (!textMemory.has(guildId)) {
      textMemory.set(guildId, []);
    }
    
    // Use text-specific AI function
    askOpenAIText(userMessage, guildId).then(response => {
      message.reply(`${response}`);
    }).catch(error => {
      console.error("Nikbot text response error:", error);
      message.reply("Sorry, I couldn't process that request.");
    });
    return;
  }

  if (/^!help$/i.test(message.content)) {
    const helpMessage = `**Nikbot Commands Help**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `**Voice Commands:**\n` +
      `• \`/joincall\` - Join voice channel and start listening\n` +
      `• \`stop\` - Stop voice session and clear memory\n\n` +
      `**Text Commands:**\n` +
      `• \`/message-nikbot message:<text>\` - Get text response from Nikbot (fixed personality)\n` +
      `• \`!setprompt <text>\` - Update the voice changing prompt (per-server)\n` +
      `• \`!reloadprompt\` - Reload voice prompt from file\n\n` +
      `**Game Commands:**\n` +
      `• \`/fortnite\` - Show latest Fortnite cosmetics\n\n` +
      `**Settings Commands:**\n` +
      `• \`/setrecord seconds:<number>\` - Set recording duration (5-60 seconds)\n` +
      `• \`/setrepeat seconds:<number>\` - Set repeat interval (120-500 seconds)\n` +
      `• \`/setprompt prompt:<text>\` - Update voice changing prompt (per-server)\n` +
      `• \`/currentprompt\` - Show current voice changing prompt\n` +
      `• \`/settings\` - View current settings\n` +
      `• \`!reloadsettings\` - Reload settings from file\n\n` +
      `**Current Settings:**\n` +
      `• Recording: ${settings.recordDuration / 1000}s\n` +
      `• Repeat: ${settings.repeatInterval / 1000}s\n` +
      `• Voice Memory: Clears when bot leaves call\n` +
      `• Text Memory: Persistent, remembers last 20 exchanges\n\n` +
      `**Note:** Slash commands (/) provide autocomplete and better UX!\n` +
      `**Legacy:** Prefix commands (!) still work for advanced features\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    return message.reply(helpMessage);
  }

  if (/^!settings$/i.test(message.content)) {
    const voiceMemCount = voiceMemory.get(guildId)?.length || 0;
    const textMemCount = textMemory.get(guildId)?.length || 0;
    
    const settingsMessage = `**Current Settings**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `• **Recording Duration:** ${settings.recordDuration / 1000} seconds\n` +
      `• **Repeat Interval:** ${settings.repeatInterval / 1000} seconds\n` +
      `• **Voice Memory:** ${voiceMemCount} messages (clears on exit)\n` +
      `• **Text Memory:** ${textMemCount} messages (persistent, 20 exchanges)\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    return message.reply(settingsMessage);
  }

  if (/^!reloadsettings$/i.test(message.content)) {
    loadSettings();
    return message.reply("Reloaded settings from file.");
  }

  // Command suggestions for invalid commands
  if (message.content.startsWith('!') && !message.content.match(/^!(joincall|nikbot|setrecord|setrepeat|setprompt|reloadprompt|fortnite|help|settings|reloadsettings)$/i)) {
    const suggestions = `**Unknown command!** Here are available commands:\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `**Recommended (Slash Commands):**\n` +
      `• \`/joincall\` - Start voice session\n` +
      `• \`/message-nikbot message:<text>\` - Text chat with Nikbot\n` +
      `• \`/fortnite\` - Check Fortnite item shop\n` +
      `• \`/help\` - Full command list\n` +
      `• \`/settings\` - View current settings\n\n` +
      `**Legacy (Prefix Commands):**\n` +
      `• \`!joincall\` - Start voice session\n` +
      `• \`!nikbot <message>\` - Text chat with Nikbot\n` +
      `• \`!fortnite\` - Check Fortnite item shop\n` +
      `• \`!help\` - Full command list\n` +
      `• \`!settings\` - View current settings\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    return message.reply(suggestions);
  }

  if (message.content !== "!joincall" || activeLoops.has(guildId)) return;

  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) return message.reply("Join a voice channel first!");

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: message.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  // Initialize voice memory for this guild
  voiceMemory.set(guildId, []);

  // Create visual feedback for joining the call
  const joinMessage = await message.channel.send({
    content: `**Nikbot joined the voice call!**\n` +
             `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
             `**Listening for conversations...**\n` +
             `Recording every ${settings.repeatInterval / 1000} seconds\n` +
             `**Session memory enabled**\n` +
             `Type \`stop\` to end the session\n` +
             `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  });

  // Record immediately
  await speak(connection, "I'm listening");
  recordAndRespond(connection, message);

  const intervalId = setInterval(() => {
    speak(connection, "Recording again");
    recordAndRespond(connection, message);

  }, settings.repeatInterval);

  activeLoops.set(guildId, intervalId);
});

async function recordAndRespond(connection, message) {
  // Reload the changing prompt before each conversation cycle
  reloadChangingPrompt();
  
  const receiver = connection.receiver;
  const activeUsers = new Map();
  console.log("Recording started...");

  receiver.speaking.on("start", (userId) => {
    const user = message.guild.members.cache.get(userId)?.user;
    if (!user || activeUsers.has(userId)) return;

    const username = user.username;
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
    await speak(connection, "Stopped listening");
    
    // Send visual feedback that processing has started
    const processingMessage = await message.channel.send({
      content: `**Processing conversation...**\n` +
               `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    });
    
    const transcriptLines = [];

    for (const [userId, { username, pcmPath }] of activeUsers.entries()) {
      const wavPath = pcmPath.replace(".pcm", ".wav");

      await new Promise((resolve) => {
        exec(`ffmpeg -y -f s16le -ar 48000 -ac 2 -i ${pcmPath} -ar 16000 -ac 1 ${wavPath}`, (err) => {
          if (err || !fs.existsSync(wavPath)) {
            console.error(`FFmpeg failed for ${username}:`, err);
            // Clean up files even on failure
            safeDeleteFile(wavPath, "failed WAV file");
            safeDeleteFile(pcmPath, "failed PCM file");
            resolve();
            return;
          }

          transcribeAudio(wavPath).then((transcription) => {
            transcriptLines.push(`[${username}]: ${transcription}`);
            safeDeleteFile(wavPath, "processed WAV file");
            safeDeleteFile(pcmPath, "processed PCM file");
            resolve();
          }).catch((e) => {
            console.error(`Transcription failed for ${username}:`, e);
            safeDeleteFile(wavPath, "failed WAV file");
            safeDeleteFile(pcmPath, "failed PCM file");
            resolve();
          });
        });
      });
    }
    const fullTranscript = transcriptLines.join("\n");
    const chatGptReply = await askOpenAI(fullTranscript, message.guild.id);

    // Update processing message to show completion
    if (processingMessage) {
      await processingMessage.edit({
        content: `**Response generated!**\n` +
                 `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      });
    }

    const ttsPath = `audio/reply-${Date.now()}.mp3`;
    const gtts = new gTTS(chatGptReply, 'en');


    gtts.save(ttsPath, () => {
      const ttsPlayer = createAudioPlayer();
      const ttsResource = createAudioResource(ttsPath);
      connection.subscribe(ttsPlayer);
      ttsPlayer.play(ttsResource);

      ttsPlayer.on(AudioPlayerStatus.Idle, () => {
        safeDeleteFile(ttsPath, "TTS audio file");
      });
    });

  }, settings.recordDuration);
}

function transcribeAudio(audioPath) {
  return new Promise((resolve, reject) => {
    const fullPath = path.resolve(audioPath);
    exec(`python transcribe.py "${fullPath}"`, (error, stdout, stderr) => {
      if (error) {
        console.error("Transcription error:", error.message);
        reject(error);
        return;
      }
      if (stderr) {
        console.error("Python stderr:", stderr);
      }
      resolve(stdout.trim());
    });
  });
}

function speak(connection, text, lang = 'en') {
  return new Promise((resolve, reject) => {
    const ttsPath = `audio/tts-${Date.now()}.mp3`;
    const gtts = new gTTS(text, lang);
    console.log(`Speaking: ${text}`);

    gtts.save(ttsPath, () => {
      console.log(`Saved TTS audio to ${ttsPath}`);

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
  });
}


async function askOpenAI(promptText, guildId) {
  try {
    // Get voice memory for this guild
    const memory = voiceMemory.get(guildId) || [];
    
    // Get guild-specific changing prompt or use default
    const guildChangingPrompt = guildChangingPrompts.get(guildId) || CHANGING_PROMPT;
    
    // Build messages array with system prompt, memory, and current conversation
    const messages = [
      { role: "system", content: SYSTEM_PROMPT + guildChangingPrompt }
    ];
    
    // Add conversation history (limit to last 10 exchanges to avoid token limits)
    if (memory.length > 0) {
      messages.push(...memory.slice(-10));
    }
    
    // Add current conversation
    messages.push({ role: "user", content: promptText });

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // or "gpt-4"
      messages: messages,
      temperature: 0.7
    });

    let botResponse = response.choices[0].message.content.trim();
    
    // Remove "Nikbot:" prefix if it exists
    botResponse = botResponse.replace(/^Nikbot:\s*/i, '');
    
    // Store the conversation in voice memory
    memory.push({ role: "user", content: promptText });
    memory.push({ role: "assistant", content: botResponse });
    
    // Limit memory to last 20 exchanges (40 messages) to prevent memory overflow
    if (memory.length > 40) {
      memory.splice(0, memory.length - 40);
    }
    
    voiceMemory.set(guildId, memory);

    return botResponse;
  } catch (error) {
    console.error("OpenAI error:", error.response?.data || error.message);
    return "Failed to contact OpenAI.";
  }
}

async function askOpenAIText(promptText, guildId) {
  try {
    // Get text memory for this guild
    const memory = textMemory.get(guildId) || [];
    
    // Build messages array with text-specific system prompt only
    const messages = [
      { role: "system", content: TEXT_SYSTEM_PROMPT }
    ];
    
    // Add conversation history (limit to last 10 exchanges to avoid token limits)
    if (memory.length > 0) {
      messages.push(...memory.slice(-10));
    }
    
    // Add current conversation
    messages.push({ role: "user", content: promptText });

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // or "gpt-4"
      messages: messages,
      temperature: 0.7
    });

    let botResponse = response.choices[0].message.content.trim();
    
    // Remove "Nikbot:" prefix if it exists
    botResponse = botResponse.replace(/^Nikbot:\s*/i, '');
    
    // Store the conversation in text memory
    memory.push({ role: "user", content: promptText });
    memory.push({ role: "assistant", content: botResponse });
    
    // Limit memory to last 20 exchanges (40 messages) to prevent memory overflow
    if (memory.length > 40) {
      memory.splice(0, memory.length - 40);
    }
    
    textMemory.set(guildId, memory);

    return botResponse;
  } catch (error) {
    console.error("OpenAI text error:", error.response?.data || error.message);
    return "Failed to contact OpenAI.";
  }
}

async function getFortniteShop() {
  try {
    const apiKey = process.env.FORTNITE_API_KEY;
    const headers = {
      'User-Agent': 'NiklasBot/1.0'
    };
    
    // Add API key if available
    if (apiKey) {
      headers['Authorization'] = apiKey;
    }
    
    // Try the cosmetics/new endpoint first (shows latest items)
    const response = await fetch('https://fortnite-api.com/v2/cosmetics/new', {
      headers: headers
    });
    
    if (!response.ok) {
      throw new Error(`API Error: ${response.status} - ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Check if we have valid data
    if (!data || !data.data || !data.data.items) {
      throw new Error('No cosmetics data available');
    }
    
    let shopMessage = `**Latest Fortnite Cosmetics**\n`;
    shopMessage += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    // Get BR (Battle Royale) items
    const brItems = data.data.items.br || [];
    const legoItems = data.data.items.lego || [];
    const carItems = data.data.items.cars || [];
    
    // Show BR items (most relevant)
    if (brItems.length > 0) {
      shopMessage += `**🎮 Battle Royale Items:**\n`;
      brItems.slice(0, 8).forEach(item => {
        try {
          const name = item.name || 'Unknown Item';
          const type = item.type?.displayValue || 'Cosmetic';
          const rarity = item.rarity?.displayValue || 'Unknown';
          const set = item.set?.value || '';
          const description = item.description || '';
          
          // Try to get price information
          let priceInfo = '';
          if (item.price) {
            priceInfo = ` • ${item.price} V-Bucks`;
          } else if (item.finalPrice) {
            priceInfo = ` • ${item.finalPrice} V-Bucks`;
          } else if (item.regularPrice) {
            priceInfo = ` • ${item.regularPrice} V-Bucks`;
          } else {
            // Try to determine price based on rarity
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
          if (description) {
            shopMessage += `   *${description}*\n`;
          }
          shopMessage += `\n`;
        } catch (itemError) {
          console.log('Error processing BR item:', itemError);
        }
      });
    }
    
    // Show LEGO items if available
    if (legoItems.length > 0) {
      shopMessage += `**LEGO Items:**\n`;
      legoItems.slice(0, 4).forEach(item => {
        try {
          const cosmeticId = item.cosmeticId || 'Unknown';
          const name = cosmeticId.replace('Character_', '').replace(/_/g, ' ');
          // LEGO items are typically free or part of LEGO Fortnite
          shopMessage += `• **${name}** • Free (LEGO Fortnite)\n`;
        } catch (itemError) {
          console.log('Error processing LEGO item:', itemError);
        }
      });
      shopMessage += `\n`;
    }
    
    // Show car items if available
    if (carItems.length > 0) {
      shopMessage += `**Vehicle Items:**\n`;
      carItems.slice(0, 4).forEach(item => {
        try {
          const name = item.name || 'Unknown Vehicle';
          const rarity = item.rarity?.displayValue || 'Unknown';
          
          // Try to get price for vehicle items
          let priceInfo = '';
          if (item.price) {
            priceInfo = ` • ${item.price} V-Bucks`;
          } else if (item.finalPrice) {
            priceInfo = ` • ${item.finalPrice} V-Bucks`;
          } else if (item.regularPrice) {
            priceInfo = ` • ${item.regularPrice} V-Bucks`;
          } else {
            // Vehicle items typically cost less than cosmetics
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
    
    // Add build info
    if (data.data.build) {
      const build = data.data.build.replace(/\\u002B/g, '+');
      shopMessage += `**Build:** ${build}\n`;
    }
    
    // Add last update info
    if (data.data.lastAdditions) {
      const lastUpdate = new Date(data.data.lastAdditions.br).toLocaleString();
      shopMessage += `**Last Updated:** ${lastUpdate}\n`;
    }
    
    shopMessage += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    shopMessage += `Use \`!fortnite\` to check again!`;
    
    return shopMessage;
    
  } catch (error) {
    console.error("Fortnite shop fetch error:", error);
    
    // Try alternative API as fallback
    try {
      const fallbackResponse = await fetch('https://fnbr.co/api/shop', {
        headers: {
          'User-Agent': 'NiklasBot/1.0'
        }
      });
      
      if (fallbackResponse.ok) {
        const fallbackData = await fallbackResponse.json();
        if (fallbackData && fallbackData.data) {
          return `**Fortnite Cosmetics**\n` +
                 `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                 `**Fallback data available**\n\n` +
                 `**Featured Items:**\n` +
                 `• Check for current items\n\n` +
                 `**Daily Items:**\n` +
                 `• Cosmetics update regularly\n\n` +
                 `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        }
      }
    } catch (fallbackError) {
      console.log("Fallback API also failed:", fallbackError);
    }
    
    // Return a fallback message instead of throwing
    return `**Fortnite Cosmetics**\n` +
           `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
           ` **Unable to fetch cosmetics data**\n\n` +
           `**Possible reasons:**\n` +
           `• Fortnite API requires authentication\n` +
           `• API is temporarily down\n` +
           `• Network connection issues\n\n` +
           `**To fix this:**\n` +
           `• Get a free API key from fortnite-api.com\n` +
           `• Add \`FORTNITE_API_KEY=your_key\` to your .env file\n\n` +
           `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
           `Use \`!fortnite\` to try again!`;
  }
}



// Track which guilds have been registered to prevent duplicates
const registeredGuilds = new Set();

// Register slash commands for each guild (instant updates)
async function registerSlashCommands() {
  const commands = [
    {
      name: 'message-nikbot',
      description: 'Chat with Nikbot (text responses)',
      options: [
        {
          name: 'message',
          description: 'Your message to Nikbot',
          type: 3, // STRING
          required: true
        }
      ]
    },
    {
      name: 'joincall',
      description: 'Join voice channel and start listening for conversations'
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
      description: 'Set recording duration in seconds',
      options: [
        {
          name: 'seconds',
          description: 'Recording duration in seconds',
          type: 4, // INTEGER
          required: true,
          min_value: 5,
          max_value: 60
        }
      ]
    },
    {
      name: 'setrepeat',
      description: 'Set repeat interval in seconds',
      options: [
        {
          name: 'seconds',
          description: 'Repeat interval in seconds',
          type: 4, // INTEGER
          required: true,
          min_value: 120,
          max_value: 500
        }
      ]
    },
    {
      name: 'setprompt',
      description: 'Update the voice changing prompt',
      options: [
        {
          name: 'prompt',
          description: 'New voice changing prompt text',
          type: 3, // STRING
          required: true
        }
      ]
    },
    {
      name: 'currentprompt',
      description: 'Show the current voice changing prompt for this server'
    }
  ];

  try {
    // Register guild commands for each guild the bot is in (instant updates)
    for (const [guildId, guild] of client.guilds.cache) {
      // Skip if already registered
      if (registeredGuilds.has(guildId)) {
        console.log(`⏭️ Commands already registered for guild: ${guild.name}`);
        continue;
      }

      try {
        await guild.commands.set(commands);
        registeredGuilds.add(guildId);
        console.log(`✅ Slash commands registered for guild: ${guild.name} (${guildId})`);
      } catch (error) {
        console.error(`❌ Error registering commands for guild ${guild.name}:`, error);
      }
    }
    console.log('✅ All guild slash commands registered! (Instant updates)');
  } catch (error) {
    console.error('❌ Error registering slash commands:', error);
  }
}

// Register commands when bot joins a new guild
client.on('guildCreate', async (guild) => {
  console.log(`Bot joined new guild: ${guild.name}`);
  // Only register for the new guild, not all guilds
  const commands = [
    {
      name: 'message-nikbot',
      description: 'Chat with Nikbot (text responses)',
      options: [
        {
          name: 'message',
          description: 'Your message to Nikbot',
          type: 3, // STRING
          required: true
        }
      ]
    },
    {
      name: 'joincall',
      description: 'Join voice channel and start listening for conversations'
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
      description: 'Set recording duration in seconds',
      options: [
        {
          name: 'seconds',
          description: 'Recording duration in seconds',
          type: 4, // INTEGER
          required: true,
          min_value: 5,
          max_value: 60
        }
      ]
    },
    {
      name: 'setrepeat',
      description: 'Set repeat interval in seconds',
      options: [
        {
          name: 'seconds',
          description: 'Repeat interval in seconds',
          type: 4, // INTEGER
          required: true,
          min_value: 120,
          max_value: 500
        }
      ]
    },
    {
      name: 'setprompt',
      description: 'Update the voice changing prompt',
      options: [
        {
          name: 'prompt',
          description: 'New voice changing prompt text',
          type: 3, // STRING
          required: true
        }
      ]
    },
    {
      name: 'currentprompt',
      description: 'Show the current voice changing prompt for this server'
    }
  ];

  try {
    await guild.commands.set(commands);
    registeredGuilds.add(guild.id);
    console.log(`✅ Slash commands registered for new guild: ${guild.name}`);
  } catch (error) {
    console.error(`❌ Error registering commands for new guild ${guild.name}:`, error);
  }
});

// Handle slash command interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, guildId } = interaction;

  try {
    if (commandName === 'message-nikbot') {
      const message = options.getString('message');
      const response = await askOpenAIText(message, guildId);
      await interaction.reply(`${response}`);
    }
    
    else if (commandName === 'joincall') {
      // Check if user is in a voice channel
      const member = interaction.member;
      if (!member.voice.channel) {
        await interaction.reply('You need to be in a voice channel to use this command!');
        return;
      }

      // Check if bot is already in a voice channel in this guild
      const existingConnection = getVoiceConnection(guildId);
      if (existingConnection) {
        await interaction.reply('I\'m already in a voice channel in this server!');
        return;
      }

      // Join the voice channel
      const connection = joinVoiceChannel({
        channelId: member.voice.channel.id,
        guildId: guildId,
        adapterCreator: member.guild.voiceAdapterCreator,
      });

      // Initialize voice memory for this guild
      voiceMemory.set(guildId, []);

      // Create visual feedback for joining the call
      const joinMessage = await interaction.reply({
        content: `🎤 **Nikbot joined the voice call!**\n` +
                 `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                 `🔊 **Listening for conversations...**\n` +
                 `⏱️ Recording every ${settings.repeatInterval / 1000} seconds\n` +
                 `🧠 **Session memory enabled**\n` +
                 `🛑 Type \`stop\` to end the session\n` +
                 `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        fetchReply: true
      });

      // Start the recording loop
      const loop = setInterval(async () => {
        try {
          await recordAndRespond(connection, guildId, joinMessage.channel);
        } catch (error) {
          console.error("Recording loop error:", error);
        }
      }, settings.repeatInterval);

      activeLoops.set(guildId, loop);
    }
    
    else if (commandName === 'fortnite') {
      const shopData = await getFortniteShop();
      await interaction.reply(shopData);
    }
    
    else if (commandName === 'help') {
      const helpMessage = `**Nikbot Commands Help**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `**Voice Commands:**\n` +
        `• \`/joincall\` - Join voice channel and start listening\n` +
        `• \`stop\` - Stop voice session and clear memory\n\n` +
        `**Text Commands:**\n` +
        `• \`/message-nikbot message:<text>\` - Get text response from Nikbot (fixed personality)\n` +
        `• \`!setprompt <text>\` - Update the voice changing prompt (per-server)\n` +
        `• \`!reloadprompt\` - Reload the voice changing prompt from file\n\n` +
        `**Fortnite Commands:**\n` +
        `• \`/fortnite\` - Get latest Fortnite cosmetics\n\n` +
        `**Settings Commands:**\n` +
        `• \`/setrecord seconds:<number>\` - Set recording duration (5-60 seconds)\n` +
        `• \`/setrepeat seconds:<number>\` - Set repeat interval (120-500 seconds)\n` +
        `• \`/setprompt prompt:<text>\` - Update voice changing prompt (per-server)\n` +
        `• \`/currentprompt\` - Show current voice changing prompt\n` +
        `• \`/settings\` - Show current settings and memory status\n\n` +
        `**Memory System:**\n` +
        `• **Voice Memory**: Clears when bot leaves call or someone says \`stop\`\n` +
        `• **Text Memory**: Remembers last 20 exchanges (persistent)\n\n` +
        `**Note:** Slash commands (/) provide autocomplete and better UX!\n` +
        `**Legacy:** Prefix commands (!) still work for advanced features\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      
      await interaction.reply(helpMessage);
    }
    
    else if (commandName === 'settings') {
      const voiceMem = voiceMemory.get(guildId) || [];
      const textMem = textMemory.get(guildId) || [];
      
      const settingsMessage = `**Nikbot Settings**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `**Recording Settings:**\n` +
        `• Record Duration: ${settings.recordDuration / 1000} seconds\n` +
        `• Repeat Interval: ${settings.repeatInterval / 1000} seconds\n\n` +
        `**Memory Status:**\n` +
        `• Voice Memory: ${voiceMem.length} messages (clears on exit)\n` +
        `• Text Memory: ${textMem.length} messages (last 20 exchanges)\n\n` +
        `**Active Sessions:**\n` +
        `• Voice Loops: ${activeLoops.has(guildId) ? 'Active' : 'Inactive'}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      
      await interaction.reply(settingsMessage);
    }
    
    else if (commandName === 'setrecord') {
      const seconds = options.getInteger('seconds');
      settings.recordDuration = seconds * 1000;
      saveSettings();
      await interaction.reply(`✅ Recording duration set to ${seconds} seconds`);
    }
    
    else if (commandName === 'setrepeat') {
      const seconds = options.getInteger('seconds');
      settings.repeatInterval = seconds * 1000;
      saveSettings();
      await interaction.reply(`✅ Repeat interval set to ${seconds} seconds`);
    }
    
    else if (commandName === 'setprompt') {
      const prompt = options.getString('prompt');
      guildChangingPrompts.set(guildId, prompt);
      saveGuildPrompts(); // Persist to file
      await interaction.reply(`✅ Voice changing prompt updated for this server`);
    }
    
    else if (commandName === 'currentprompt') {
      const currentPrompt = guildChangingPrompts.get(guildId) || CHANGING_PROMPT;
      const promptMessage = `**Current Voice Changing Prompt**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `\`\`\`\n${currentPrompt}\n\`\`\`\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `*This prompt is specific to this server*\n` +
        `*Use \`/setprompt\` to change it*`;
      
      await interaction.reply(promptMessage);
    }
    
  } catch (error) {
    console.error('Slash command error:', error);
    await interaction.reply('Sorry, there was an error processing that command.');
  }
});

client.login(process.env.DISCORD_TOKEN).then(async () => {
  console.log("Bot login attempt successful.");
  // Register slash commands after login
  await registerSlashCommands();
}).catch(err => {
  console.error("Login failed:", err);
});
