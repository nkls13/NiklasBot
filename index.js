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
let CHANGING_TEXT_PROMPT = fs.readFileSync("changingTextPrompt.txt", "utf-8").trim();

// Function to reload the changing prompt from file
function reloadChangingPrompt() {
  try {
    CHANGING_PROMPT = fs.readFileSync("changingPrompt.txt", "utf-8").trim();
    console.log("📝 Reloaded changing prompt from file");
  } catch (error) {
    console.error("❌ Failed to reload changing prompt:", error.message);
  }
}

// Function to reload the text prompts from file
function reloadTextPrompts() {
  try {
    TEXT_SYSTEM_PROMPT = fs.readFileSync("textPrompt.txt", "utf-8").trim();
    CHANGING_TEXT_PROMPT = fs.readFileSync("changingTextPrompt.txt", "utf-8").trim();
    console.log("📝 Reloaded text prompts from file");
  } catch (error) {
    console.error("❌ Failed to reload text prompts:", error.message);
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
      console.log("📋 Loaded settings from file");
    }
  } catch (error) {
    console.error("❌ Failed to load settings:", error.message);
  }
}

// Save settings to file
function saveSettings() {
  try {
    fs.writeFileSync("settings.json", JSON.stringify(settings, null, 2));
    console.log("💾 Settings saved to file");
  } catch (error) {
    console.error("❌ Failed to save settings:", error.message);
  }
}

// Load settings on startup
loadSettings();

const activeLoops = new Map();
const sessionMemory = new Map(); // Key: guildId, Value: array of conversation messages

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const guildId = message.guild?.id;

  if (/stop/i.test(message.content) && activeLoops.has(guildId)) {
    clearInterval(activeLoops.get(guildId));
    activeLoops.delete(guildId);
    sessionMemory.delete(guildId); // Clear session memory when stopping

    const connection = getVoiceConnection(guildId);
    if (connection) connection.destroy();

    message.channel.send("🛑 Stopped recording loop and left the voice channel. Session memory cleared.");
    return;
  }

  if (/^!setrecord (\d+)/i.test(message.content)) {
    const match = message.content.match(/^!setrecord (\d+)/i);
    settings.recordDuration = parseInt(match[1]) * 1000;
    saveSettings();
    return message.reply(`⏱️ Set recording duration to ${match[1]} seconds.`);
  }

  if (/^!setrepeat (\d+)/i.test(message.content)) {
    const match = message.content.match(/^!setrepeat (\d+)/i);
    settings.repeatInterval = parseInt(match[1]) * 1000;
    saveSettings();
    return message.reply(`🔁 Set repeat interval to ${match[1]} seconds.`);
  }

  if (/^!setprompt /i.test(message.content)) {
    CHANGING_PROMPT = message.content.replace(/^!setprompt /i, '').trim();
    fs.writeFileSync("changingPrompt.txt", CHANGING_PROMPT);
    reloadChangingPrompt(); // Reload to ensure consistency
    return message.reply("✏️ Updated changing prompt.");
  }

  if (/^!reloadprompt$/i.test(message.content)) {
    reloadChangingPrompt();
    return message.reply("🔄 Reloaded changing prompt from file.");
  }

  if (/^!settextprompt /i.test(message.content)) {
    TEXT_SYSTEM_PROMPT = message.content.replace(/^!settextprompt /i, '').trim();
    fs.writeFileSync("textPrompt.txt", TEXT_SYSTEM_PROMPT);
    reloadTextPrompts(); // Reload to ensure consistency
    return message.reply("✏️ Updated text base prompt.");
  }

  if (/^!reloadtextprompt$/i.test(message.content)) {
    reloadTextPrompts();
    return message.reply("🔄 Reloaded text prompts from file.");
  }


  if (/^!nikbot /i.test(message.content)) {
    const userMessage = message.content.replace(/^!nikbot /i, '').trim();
    if (!userMessage) {
      return message.reply("❌ Please provide a message for Nikbot to respond to!");
    }
    
    // Get or create memory for this guild
    if (!sessionMemory.has(guildId)) {
      sessionMemory.set(guildId, []);
    }
    
    // Use text-specific AI function
    askOpenAIText(userMessage, guildId).then(response => {
      message.reply(`**Nikbot:** ${response}`);
    }).catch(error => {
      console.error("❌ Nikbot text response error:", error);
      message.reply("❌ Sorry, I couldn't process that request.");
    });
    return;
  }

  if (/^!help$/i.test(message.content)) {
    const helpMessage = `🤖 **Nikbot Commands Help**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `**Voice Commands:**\n` +
      `• \`!joincall\` - Join voice channel and start listening\n` +
      `• \`stop\` - Stop voice session and clear memory\n\n` +
      `**Text Commands:**\n` +
      `• \`!nikbot <message>\` - Get text response from Nikbot (fixed personality)\n` +
      `• \`!setprompt <text>\` - Update the voice changing prompt\n` +
      `• \`!reloadprompt\` - Reload voice prompt from file\n` +
      `• \`!settextprompt <text>\` - Update text base prompt (affects all text responses)\n` +
      `• \`!reloadtextprompt\` - Reload text prompts from file\n\n` +
      `**Settings Commands:**\n` +
      `• \`!setrecord <seconds>\` - Set recording duration\n` +
      `• \`!setrepeat <seconds>\` - Set repeat interval\n` +
      `• \`!settings\` - View current settings\n` +
      `• \`!reloadsettings\` - Reload settings from file\n\n` +
      `**Current Settings:**\n` +
      `• Recording: ${settings.recordDuration / 1000}s\n` +
      `• Repeat: ${settings.repeatInterval / 1000}s\n` +
      `• Session Memory: Auto-clears when bot leaves\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    return message.reply(helpMessage);
  }

  if (/^!settings$/i.test(message.content)) {
    const settingsMessage = `⚙️ **Current Settings**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `• **Recording Duration:** ${settings.recordDuration / 1000} seconds\n` +
      `• **Repeat Interval:** ${settings.repeatInterval / 1000} seconds\n` +
      `• **Session Memory:** Auto-clears when bot leaves\n` +
      `• **Memory Status:** ${sessionMemory.has(guildId) ? 'Active (will clear on exit)' : 'Inactive'}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    return message.reply(settingsMessage);
  }

  if (/^!reloadsettings$/i.test(message.content)) {
    loadSettings();
    return message.reply("🔄 Reloaded settings from file.");
  }

  // Command suggestions for invalid commands
  if (message.content.startsWith('!') && !message.content.match(/^!(joincall|nikbot|setrecord|setrepeat|setprompt|reloadprompt|settextprompt|reloadtextprompt|help|settings|reloadsettings)$/i)) {
    const suggestions = `❓ **Unknown command!** Here are available commands:\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `**Quick Commands:**\n` +
      `• \`!joincall\` - Start voice session\n` +
      `• \`!nikbot <message>\` - Text chat with Nikbot\n` +
      `• \`!help\` - Full command list\n` +
      `• \`!settings\` - View current settings\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    return message.reply(suggestions);
  }

  if (message.content !== "!joincall" || activeLoops.has(guildId)) return;

  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) return message.reply("❌ Join a voice channel first!");

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: message.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  // Initialize session memory for this guild
  sessionMemory.set(guildId, []);

  // Create visual feedback for joining the call
  const joinMessage = await message.channel.send({
    content: `🎤 **Nikbot joined the voice call!**\n` +
             `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
             `🔊 **Listening for conversations...**\n` +
             `⏱️ Recording every ${settings.repeatInterval / 1000} seconds\n` +
             `🧠 **Session memory enabled**\n` +
             `🛑 Type \`stop\` to end the session\n` +
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
  console.log("🔁 Recording started...");

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
      console.log(`🛑 Finished writing for ${username}`);
    });
  });

  setTimeout(async () => {
    receiver.speaking.removeAllListeners("start");
    await speak(connection, "Stopped listening");
    
    // Send visual feedback that processing has started
    const processingMessage = await message.channel.send({
      content: `🔄 **Processing conversation...**\n` +
               `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    });
    
    const transcriptLines = [];

    for (const [userId, { username, pcmPath }] of activeUsers.entries()) {
      const wavPath = pcmPath.replace(".pcm", ".wav");

      await new Promise((resolve) => {
        exec(`ffmpeg -y -f s16le -ar 48000 -ac 2 -i ${pcmPath} -ar 16000 -ac 1 ${wavPath}`, (err) => {
          if (err || !fs.existsSync(wavPath)) {
            console.error(`❌ FFmpeg failed for ${username}:`, err);
            resolve();
            return;
          }

          transcribeAudio(wavPath).then((transcription) => {
            transcriptLines.push(`[${username}]: ${transcription}`);
            fs.unlinkSync(wavPath);
            fs.unlinkSync(pcmPath);
            resolve();
          }).catch((e) => {
            console.error(`❌ Transcription failed for ${username}:`, e);
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
        content: `✅ **Response generated!**\n` +
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
        fs.unlinkSync(ttsPath);
      });
    });

  }, settings.recordDuration);
}

function transcribeAudio(audioPath) {
  return new Promise((resolve, reject) => {
    const fullPath = path.resolve(audioPath);
    exec(`python transcribe.py "${fullPath}"`, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ Transcription error:", error.message);
        reject(error);
        return;
      }
      if (stderr) {
        console.error("🐍 Python stderr:", stderr);
      }
      resolve(stdout.trim());
    });
  });
}

function speak(connection, text, lang = 'en') {
  return new Promise((resolve, reject) => {
    const ttsPath = `audio/tts-${Date.now()}.mp3`;
    const gtts = new gTTS(text, lang);
    console.log(`🗣️ Speaking: ${text}`);

    gtts.save(ttsPath, () => {
      console.log(`📁 Saved TTS audio to ${ttsPath}`);

      const ttsPlayer = createAudioPlayer();
      const ttsResource = createAudioResource(ttsPath);
      connection.subscribe(ttsPlayer);
      ttsPlayer.play(ttsResource);

      ttsPlayer.on(AudioPlayerStatus.Idle, () => {
        fs.unlinkSync(ttsPath);
        resolve();
      });

      ttsPlayer.on("error", (err) => {
        console.error("🔊 TTS Playback Error:", err);
        reject(err);
      });
    });
  });
}


async function askOpenAI(promptText, guildId) {
  try {
    // Get session memory for this guild
    const memory = sessionMemory.get(guildId) || [];
    
    // Build messages array with system prompt, memory, and current conversation
    const messages = [
      { role: "system", content: SYSTEM_PROMPT + CHANGING_PROMPT }
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

    const botResponse = response.choices[0].message.content.trim();
    
    // Store the conversation in session memory
    memory.push({ role: "user", content: promptText });
    memory.push({ role: "assistant", content: botResponse });
    
    // Limit memory to last 20 exchanges (40 messages) to prevent memory overflow
    if (memory.length > 40) {
      memory.splice(0, memory.length - 40);
    }
    
    sessionMemory.set(guildId, memory);

    return botResponse;
  } catch (error) {
    console.error("🛑 OpenAI error:", error.response?.data || error.message);
    return "❌ Failed to contact OpenAI.";
  }
}

async function askOpenAIText(promptText, guildId) {
  try {
    // Reload text prompts before each request
    reloadTextPrompts();
    
    // Get session memory for this guild
    const memory = sessionMemory.get(guildId) || [];
    
    // Build messages array with text-specific system prompt only (no changing prompt)
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

    const botResponse = response.choices[0].message.content.trim();
    
    // Store the conversation in session memory
    memory.push({ role: "user", content: promptText });
    memory.push({ role: "assistant", content: botResponse });
    
    // Limit memory to last 20 exchanges (40 messages) to prevent memory overflow
    if (memory.length > 40) {
      memory.splice(0, memory.length - 40);
    }
    
    sessionMemory.set(guildId, memory);

    return botResponse;
  } catch (error) {
    console.error("🛑 OpenAI text error:", error.response?.data || error.message);
    return "❌ Failed to contact OpenAI.";
  }
}


client.login(process.env.DISCORD_TOKEN).then(() => {
  console.log("🔐 Bot login attempt successful.");
}).catch(err => {
  console.error("❌ Login failed:", err);
});
