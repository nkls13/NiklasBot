// Minimal leveled logger. Deliberately not a dependency (pino, etc.) — see
// DECISIONS.md: AUTOMATION.md's "keep dependencies boring and minimal; prefer
// the standard library" rule applies here too, and console-with-levels covers
// what this project actually needs. Factory takes an injectable sink/clock so
// it's unit testable without touching the real console.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger({ level = process.env.LOG_LEVEL || "info", sink = console, now = () => new Date() } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(levelName, args) {
    if (LEVELS[levelName] < threshold) return;
    const prefix = `[${now().toISOString()}] [${levelName.toUpperCase()}]`;
    const method = (levelName === "error" && sink.error) || (levelName === "warn" && sink.warn) || sink.log;
    method(prefix, ...args);
  }

  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}

module.exports = { createLogger, LEVELS };
