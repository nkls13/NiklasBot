const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_SETTINGS, resolveSettings } = require("../lib/settings");

test("resolveSettings falls back to defaults when nothing is stored", () => {
  assert.deepEqual(resolveSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(resolveSettings({}), DEFAULT_SETTINGS);
});

test("resolveSettings keeps a valid stored value", () => {
  assert.deepEqual(resolveSettings({ lullThresholdMs: 15000 }), { lullThresholdMs: 15000 });
});

test("resolveSettings falls back to default for zero or negative values", () => {
  assert.deepEqual(resolveSettings({ lullThresholdMs: 0 }), DEFAULT_SETTINGS);
  assert.deepEqual(resolveSettings({ lullThresholdMs: -500 }), DEFAULT_SETTINGS);
});

test("resolveSettings ignores unrelated stored keys", () => {
  assert.deepEqual(resolveSettings({ somethingElse: true }), DEFAULT_SETTINGS);
});
