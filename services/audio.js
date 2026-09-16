const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DATA_DIR = path.join(__dirname, '..', 'data', 'audio');

// --- Low-level helpers ---

/** Run a command, capturing stdout/stderr. Resolves on exit code 0. */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const err = new Error(`${cmd} exited with code ${code}: ${stderr.slice(-2000)}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

/**
 * Verify ffmpeg and ffprobe are available on PATH.
 * Logs a clear install hint when missing. Returns boolean.
 */
function checkFfmpeg() {
  let ok = true;
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ffmpeg.error || ffmpeg.status !== 0) {
    console.error('ERROR: ffmpeg not found on PATH. Install it with: brew install ffmpeg');
    ok = false;
  }
  const ffprobe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' });
  if (ffprobe.error || ffprobe.status !== 0) {
    console.error('ERROR: ffprobe not found on PATH. Install it with: brew install ffmpeg');
    ok = false;
  }
  return ok;
}

/** Get duration in seconds via ffprobe. */
async function getDuration(inputPath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    inputPath,
  ]);
  const n = Number(stdout.trim());
  if (Number.isNaN(n)) {
    throw new Error(`ffprobe returned invalid duration for ${inputPath}: "${stdout.trim()}"`);
  }
  return n;
}

// --- Phase 1: audio preparation ---

/**
 * Convert the uploaded file to 16 kHz mono PCM WAV.
 * Original file is untouched; the player keeps playing the original.
 * Returns the normalized WAV path.
 */
async function normalize(inputPath, episodeId) {
  const dir = path.join(DATA_DIR, 'normalized');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${episodeId}.wav`);

  await run('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    outPath,
  ]);

  return outPath;
}

/**
 * Detect silences on the normalized file using ffmpeg silencedetect.
 * Returns [{ start, end }] in seconds.
 */
async function detectSilences(normalizedPath, totalDuration) {
  const { stderr } = await run('ffmpeg', [
    '-i', normalizedPath,
    '-af', `silencedetect=noise=${config.SILENCE_NOISE_DB}dB:d=${config.SILENCE_MIN_DURATION}`,
    '-f', 'null',
    '-',
  ]);
  return parseSilencedetect(stderr, totalDuration);
}

/**
 * Parse ffmpeg silencedetect stderr into silence ranges.
 *
 * Handles the normal `silence_start` / `silence_end` pairs, and a trailing
 * `silence_start` with no matching end (silence running to end of file).
 */
function parseSilencedetect(stderrText, totalDuration) {
  const silences = [];
  let pendingStart = null;

  const lines = String(stderrText).split('\n');
  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (startMatch) {
      // If there's already an unterminated silence, close it first (defensive).
      if (pendingStart !== null) {
        silences.push({ start: pendingStart, end: Number(startMatch[1]) });
      }
      pendingStart = Number(startMatch[1]);
      continue;
    }

    const endMatch = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (endMatch && pendingStart !== null) {
      silences.push({ start: pendingStart, end: Number(endMatch[1]) });
      pendingStart = null;
    }
  }

  // Trailing silence_start with no matching silence_end → runs to end of file.
  if (pendingStart !== null) {
    silences.push({ start: pendingStart, end: totalDuration });
  }

  return silences;
}

/**
 * Choose cut points (in seconds, excluding 0 and the end) from silences.
 *
 * Pure function returning an array of cut times.
 */
function pickCutPoints(silences, totalDuration, cfg = config) {
  const {
    CHUNK_TARGET_SEC: targetSec,
    CHUNK_SEARCH_WINDOW_SEC: windowSec,
    CHUNK_MIN_SEC: minSec,
  } = cfg;

  const cutPoints = [];
  let position = 0;

  while (totalDuration - position > targetSec + minSec) {
    const target = position + targetSec;

    // Primary search: midpoints within target ± window.
    const candidates = silences
      .filter((s) => {
        const mid = (s.start + s.end) / 2;
        return Math.abs(mid - target) <= windowSec && mid - position > minSec;
      })
      .sort((a, b) => {
        const aMid = (a.start + a.end) / 2;
        const bMid = (b.start + b.end) / 2;
        return Math.abs(aMid - target) - Math.abs(bMid - target);
      });

    let cut;
    if (candidates.length > 0) {
      // Cut at the midpoint of the silence closest to target.
      cut = (candidates[0].start + candidates[0].end) / 2;
    } else {
      // Widen to ±2× window and pick the longest silence.
      const wide = silences
        .filter((s) => {
          const mid = (s.start + s.end) / 2;
          return Math.abs(mid - target) <= windowSec * 2 && mid - position > minSec;
        })
        .sort((a, b) => (b.end - b.start) - (a.end - a.start));

      if (wide.length > 0) {
        cut = (wide[0].start + wide[0].end) / 2;
      } else {
        // Hard cut at target (a word may be split).
        cut = target;
        console.warn(
          `No silence found near ${target.toFixed(1)}s; hard-cutting (a word may be split)`
        );
      }
    }

    cutPoints.push(cut);
    position = cut;
  }

  // Never produce a final chunk shorter than CHUNK_MIN_SEC:
  // absorb a too-short remainder into the previous chunk by dropping the last cut.
  if (
    cutPoints.length > 0 &&
    totalDuration - cutPoints[cutPoints.length - 1] < minSec
  ) {
    cutPoints.pop();
  }

  return cutPoints;
}

/**
 * Cut the normalized WAV into chunk files (re-encoded, -ss after -i).
 * Returns [{ idx, start, end, path }].
 */
async function cutChunks(normalizedPath, cutPoints, totalDuration, episodeId) {
  const dir = path.join(DATA_DIR, 'chunks', episodeId);
  fs.mkdirSync(dir, { recursive: true });

  const boundaries = [0, ...cutPoints, totalDuration];
  const chunks = [];

  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const duration = end - start;

    if (duration <= 0) continue;

    const idx = i;
    const outPath = path.join(dir, `${String(idx).padStart(3, '0')}.wav`);

    await run('ffmpeg', [
      '-y',
      '-i', normalizedPath,
      '-ss', String(start),
      '-t', String(duration),
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      outPath,
    ]);

    chunks.push({ idx, start, end, path: outPath });
  }

  return chunks;
}

module.exports = {
  run,
  checkFfmpeg,
  getDuration,
  normalize,
  detectSilences,
  parseSilencedetect,
  pickCutPoints,
  cutChunks,
  DATA_DIR,
};
