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
let recordDuration = 20000; // in ms
let repeatInterval = 120000; // in ms
const activeLoops = new Map();

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const guildId = message.guild?.id;

  if (/stop/i.test(message.content) && activeLoops.has(guildId)) {
    clearInterval(activeLoops.get(guildId));
    activeLoops.delete(guildId);

    const connection = getVoiceConnection(guildId);
    if (connection) connection.destroy();

    message.channel.send("🛑 Stopped recording loop and left the voice channel.");
    return;
  }

    if (/^!setrecord (\d+)/i.test(message.content)) {
    const match = message.content.match(/^!setrecord (\d+)/i);
    recordDuration = parseInt(match[1]) * 1000;
    return message.reply(`⏱️ Set recording duration to ${match[1]} seconds.`);
  }

  if (/^!setrepeat (\d+)/i.test(message.content)) {
    const match = message.content.match(/^!setrepeat (\d+)/i);
    repeatInterval = parseInt(match[1]) * 1000;
    return message.reply(`🔁 Set repeat interval to ${match[1]} seconds.`);
  }

  if (/^!setprompt /i.test(message.content)) {
    CHANGING_PROMPT = message.content.replace(/^!setprompt /i, '').trim();
    fs.writeFileSync("changingPrompt.txt", CHANGING_PROMPT);
    return message.reply("✏️ Updated changing prompt.");
  }

  if (message.content !== "!joincall" || activeLoops.has(guildId)) return;

  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) return message.reply("❌ Join a voice channel first!");

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: message.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  message.channel.send("🔁 Started recording every minute. Type `stop` to end.");

  // Record immediately
  await speak(connection, "I'm listening");
  recordAndRespond(connection, message);

  const intervalId = setInterval(() => {
    speak(connection, "Recording again");
    recordAndRespond(connection, message);

  }, repeatInterval);

  activeLoops.set(guildId, intervalId);
});

async function recordAndRespond(connection, message) {
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
    const chatGptReply = await askOpenAI(fullTranscript);

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

  }, recordDuration);
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


async function askOpenAI(promptText) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // or "gpt-4"
      messages: [
        { role: "system", content: SYSTEM_PROMPT + CHANGING_PROMPT },
        { role: "user", content: promptText }
      ],
      temperature: 0.7
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("🛑 OpenAI error:", error.response?.data || error.message);
    return "❌ Failed to contact OpenAI.";
  }
}


client.login(process.env.DISCORD_TOKEN).then(() => {
  console.log("🔐 Bot login attempt successful.");
}).catch(err => {
  console.error("❌ Login failed:", err);
});
