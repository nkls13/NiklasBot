const test = require("node:test");
const assert = require("node:assert/strict");
const { createLogger } = require("../lib/logger");

function fakeSink() {
  const calls = { log: [], warn: [], error: [] };
  return {
    calls,
    log: (...args) => calls.log.push(args),
    warn: (...args) => calls.warn.push(args),
    error: (...args) => calls.error.push(args),
  };
}

test("info routes through sink.log with a timestamped INFO prefix", () => {
  const sink = fakeSink();
  const logger = createLogger({ sink, now: () => new Date("2026-01-01T00:00:00.000Z") });

  logger.info("guild joined", "abc123");

  assert.deepEqual(sink.calls.log, [["[2026-01-01T00:00:00.000Z] [INFO]", "guild joined", "abc123"]]);
  assert.equal(sink.calls.warn.length, 0);
  assert.equal(sink.calls.error.length, 0);
});

test("warn routes through sink.warn with a WARN prefix", () => {
  const sink = fakeSink();
  const logger = createLogger({ sink, now: () => new Date("2026-01-01T00:00:00.000Z") });

  logger.warn("reconnect failed");

  assert.deepEqual(sink.calls.warn, [["[2026-01-01T00:00:00.000Z] [WARN]", "reconnect failed"]]);
});

test("error routes through sink.error with an ERROR prefix", () => {
  const sink = fakeSink();
  const logger = createLogger({ sink, now: () => new Date("2026-01-01T00:00:00.000Z") });

  const err = new Error("boom");
  logger.error("transcription failed:", err);

  assert.deepEqual(sink.calls.error, [["[2026-01-01T00:00:00.000Z] [ERROR]", "transcription failed:", err]]);
});

test("debug is suppressed at the default (info) level", () => {
  const sink = fakeSink();
  const logger = createLogger({ sink, now: () => new Date() });

  logger.debug("very chatty");

  assert.equal(sink.calls.log.length, 0);
});

test("debug is emitted once the level is lowered to debug", () => {
  const sink = fakeSink();
  const logger = createLogger({ sink, level: "debug", now: () => new Date("2026-01-01T00:00:00.000Z") });

  logger.debug("very chatty");

  assert.deepEqual(sink.calls.log, [["[2026-01-01T00:00:00.000Z] [DEBUG]", "very chatty"]]);
});

test("raising the level to error suppresses info and warn", () => {
  const sink = fakeSink();
  const logger = createLogger({ sink, level: "error", now: () => new Date() });

  logger.info("routine stuff");
  logger.warn("heads up");
  logger.error("actual problem");

  assert.equal(sink.calls.log.length, 0);
  assert.equal(sink.calls.warn.length, 0);
  assert.equal(sink.calls.error.length, 1);
});

test("falls back to sink.log when sink has no dedicated warn/error methods", () => {
  const calls = [];
  const bareSink = { log: (...args) => calls.push(args) };
  const logger = createLogger({ sink: bareSink, now: () => new Date("2026-01-01T00:00:00.000Z") });

  logger.warn("heads up");
  logger.error("boom");

  assert.deepEqual(calls, [
    ["[2026-01-01T00:00:00.000Z] [WARN]", "heads up"],
    ["[2026-01-01T00:00:00.000Z] [ERROR]", "boom"],
  ]);
});

test("an unknown level string falls back to the info threshold", () => {
  const sink = fakeSink();
  const logger = createLogger({ sink, level: "verbose", now: () => new Date() });

  logger.debug("suppressed");
  logger.info("shown");

  assert.equal(sink.calls.log.length, 1);
});
