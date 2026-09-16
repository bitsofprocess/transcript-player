// Central configuration with environment overrides.

function numFromEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (Number.isNaN(n)) return def;
  return n;
}

function strFromEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return raw;
}

const config = {
  // Audio splitting
  CHUNK_TARGET_SEC: numFromEnv('CHUNK_TARGET_SEC', 300),
  CHUNK_SEARCH_WINDOW_SEC: numFromEnv('CHUNK_SEARCH_WINDOW_SEC', 60),
  CHUNK_MIN_SEC: numFromEnv('CHUNK_MIN_SEC', 60),
  SILENCE_NOISE_DB: numFromEnv('SILENCE_NOISE_DB', -30),
  SILENCE_MIN_DURATION: numFromEnv('SILENCE_MIN_DURATION', 0.4),

  // Concurrency
  API_CONCURRENCY: numFromEnv('API_CONCURRENCY', 4),

  // Translation
  TRANSLATION_BATCH_SIZE: numFromEnv('TRANSLATION_BATCH_SIZE', 40),
  TRANSLATION_CONTEXT_SEGMENTS: numFromEnv('TRANSLATION_CONTEXT_SEGMENTS', 3),

  // Whisper
  WHISPER_PROMPT: strFromEnv('WHISPER_PROMPT', ''),
};

module.exports = config;
