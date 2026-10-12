// Persistent per-guild text chat memory, backed by node:sqlite (built-in,
// no native dependency to add/compile — see DECISIONS.md). Replaces the old
// in-memory Map so /message-nikbot history survives a restart.

const { DatabaseSync } = require("node:sqlite");

// Same window the old in-memory Map enforced: 20 exchanges == 40 messages.
const MAX_MESSAGES = 40;

function createTextMemoryStore(dbPath) {
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS text_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_text_memory_guild ON text_memory(guild_id, id);
  `);

  const selectStmt = db.prepare(
    `SELECT role, content FROM text_memory WHERE guild_id = ? ORDER BY id DESC LIMIT ?`
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS c FROM text_memory WHERE guild_id = ?`);
  const insertStmt = db.prepare(
    `INSERT INTO text_memory (guild_id, role, content, timestamp) VALUES (?, ?, ?, ?)`
  );
  const pruneStmt = db.prepare(`
    DELETE FROM text_memory
    WHERE guild_id = ? AND id NOT IN (
      SELECT id FROM text_memory WHERE guild_id = ? ORDER BY id DESC LIMIT ?
    )
  `);

  // Oldest-first, like the array the old Map-based memory held.
  function getMemory(guildId) {
    return selectStmt.all(guildId, MAX_MESSAGES).reverse().map((row) => ({
      role: row.role,
      content: row.content,
    }));
  }

  function countMemory(guildId) {
    return countStmt.get(guildId).c;
  }

  function appendExchange(guildId, userContent, botContent) {
    const now = Date.now();
    insertStmt.run(guildId, "user", userContent, now);
    insertStmt.run(guildId, "assistant", botContent, now);
    pruneStmt.run(guildId, guildId, MAX_MESSAGES);
  }

  function close() {
    db.close();
  }

  return { getMemory, countMemory, appendExchange, close };
}

module.exports = { createTextMemoryStore, MAX_MESSAGES };
