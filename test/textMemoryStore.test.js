const test = require("node:test");
const assert = require("node:assert/strict");
const { createTextMemoryStore, MAX_MESSAGES } = require("../lib/textMemoryStore");

// ":memory:" keeps this a pure unit test — a real on-disk db is only used by index.js.
function freshStore() {
  return createTextMemoryStore(":memory:");
}

test("getMemory returns empty array for a guild with no history", () => {
  const store = freshStore();
  assert.deepEqual(store.getMemory("guild-1"), []);
  store.close();
});

test("appendExchange stores the user/assistant pair in order", () => {
  const store = freshStore();
  store.appendExchange("guild-1", "hi", "hello there");
  assert.deepEqual(store.getMemory("guild-1"), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello there" },
  ]);
  store.close();
});

test("memory persists across store instances pointed at the same file", async () => {
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const path = require("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "textmem-test-"));
  const dbPath = path.join(dir, "memory.sqlite");

  const store1 = createTextMemoryStore(dbPath);
  store1.appendExchange("guild-1", "remember this", "I will");
  store1.close();

  const store2 = createTextMemoryStore(dbPath);
  assert.deepEqual(store2.getMemory("guild-1"), [
    { role: "user", content: "remember this" },
    { role: "assistant", content: "I will" },
  ]);
  store2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("guilds don't see each other's memory", () => {
  const store = freshStore();
  store.appendExchange("guild-1", "a", "b");
  store.appendExchange("guild-2", "c", "d");
  assert.deepEqual(store.getMemory("guild-1"), [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ]);
  assert.equal(store.countMemory("guild-2"), 2);
  store.close();
});

test("appendExchange prunes down to the last MAX_MESSAGES messages", () => {
  const store = freshStore();
  for (let i = 0; i < 25; i++) {
    store.appendExchange("guild-1", `q${i}`, `a${i}`); // 50 messages total
  }
  const memory = store.getMemory("guild-1");
  assert.equal(memory.length, MAX_MESSAGES);
  assert.equal(store.countMemory("guild-1"), MAX_MESSAGES);
  // Oldest exchanges should have been dropped; the most recent one survives.
  assert.deepEqual(memory[memory.length - 1], { role: "assistant", content: "a24" });
  assert.deepEqual(memory[0], { role: "user", content: "q5" });
  store.close();
});
