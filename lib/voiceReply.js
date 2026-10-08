// Pure helpers for the ambient voice-reply loop — no Discord/fs/network
// dependency, so they're unit testable on their own.

const SILENT_TOKEN = "SILENT";

// The model is told to reply with exactly this token when it has nothing to
// add. Tolerate trailing punctuation/quotes it sometimes appends anyway.
function isSilent(reply) {
  return reply.trim().replace(/^[."'`]+|[.!"'`]+$/g, "").toUpperCase() === SILENT_TOKEN;
}

function formatTranscript(transcript, maxEntries = 16) {
  return transcript.slice(-maxEntries).map(l => `${l.speaker}: ${l.text}`).join("\n");
}

// Appends in place and trims from the front once over maxLines — shared by
// both human utterances and Nikbot's own recorded replies.
function pushTranscriptEntry(transcript, entry, maxLines) {
  transcript.push(entry);
  if (transcript.length > maxLines) {
    transcript.splice(0, transcript.length - maxLines);
  }
}

module.exports = { SILENT_TOKEN, isSilent, formatTranscript, pushTranscriptEntry };
