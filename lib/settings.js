// Pure settings-resolution logic, kept separate from index.js so it can be
// unit tested without touching Discord/fs. index.js owns the Map + file IO;
// this just knows how to fill in defaults for whatever's stored.

const DEFAULT_SETTINGS = { lullThresholdMs: 9000 };

function resolveSettings(stored = {}) {
  return {
    lullThresholdMs: (stored.lullThresholdMs > 0) ? stored.lullThresholdMs : DEFAULT_SETTINGS.lullThresholdMs,
  };
}

module.exports = { DEFAULT_SETTINGS, resolveSettings };
