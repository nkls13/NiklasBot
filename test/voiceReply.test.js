const test = require("node:test");
const assert = require("node:assert/strict");
const { isSilent, formatTranscript, pushTranscriptEntry } = require("../lib/voiceReply");

test("isSilent matches the bare token", () => {
  assert.equal(isSilent("SILENT"), true);
  assert.equal(isSilent("silent"), true);
  assert.equal(isSilent("  Silent  "), true);
});

test("isSilent tolerates trailing punctuation/quotes the model sometimes adds", () => {
  assert.equal(isSilent("Silent."), true);
  assert.equal(isSilent("SILENT!"), true);
  assert.equal(isSilent('"Silent"'), true);
});

test("isSilent rejects an actual reply", () => {
  assert.equal(isSilent("Hey, what's up?"), false);
  assert.equal(isSilent("Silently, he walked away."), false); // contains SILENT but isn't just the token
});

test("formatTranscript joins speaker:text lines in order", () => {
  const transcript = [
    { speaker: "Alice", text: "hey nikbot" },
    { speaker: "Nikbot", text: "what's up" },
  ];
  assert.equal(formatTranscript(transcript), "Alice: hey nikbot\nNikbot: what's up");
});

test("formatTranscript only keeps the most recent maxEntries", () => {
  const transcript = Array.from({ length: 20 }, (_, i) => ({ speaker: "U", text: `line${i}` }));
  const result = formatTranscript(transcript, 3);
  assert.equal(result, "U: line17\nU: line18\nU: line19");
});

test("pushTranscriptEntry appends and trims from the front once over maxLines", () => {
  const transcript = [{ speaker: "A", text: "1" }, { speaker: "A", text: "2" }];
  pushTranscriptEntry(transcript, { speaker: "A", text: "3" }, 2);
  assert.deepEqual(transcript, [{ speaker: "A", text: "2" }, { speaker: "A", text: "3" }]);
});

test("pushTranscriptEntry does not trim while under the limit", () => {
  const transcript = [{ speaker: "A", text: "1" }];
  pushTranscriptEntry(transcript, { speaker: "A", text: "2" }, 5);
  assert.equal(transcript.length, 2);
});
