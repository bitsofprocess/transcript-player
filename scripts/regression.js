/**
 * Regression: compare single-chunk vs multi-chunk transcription.
 *
 * Usage:
 *   node scripts/regression.js <audio-file>
 *
 * Runs the full pipeline (normalize → split → transcribe → merge) twice:
 *   1. CHUNK_TARGET_SEC=99999 (single chunk)
 *   2. CHUNK_TARGET_SEC=120   (~6 chunks)
 *
 * Writes each run's merged segments to /tmp/regression-*.json and prints
 * a diff of the transcript text around each boundary.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config();
const { randomUUID: uuidv4 } = require('crypto');
const {
  normalize,
  getDuration,
  detectSilences,
  pickCutPoints,
  cutChunks,
} = require('../services/audio');
const { transcribeChunk } = require('../services/transcribe');
const { mergeChunks } = require('../services/merge');
const { runPool } = require('../services/pool');
const {
  createEpisode,
  insertChunks,
  getChunks,
  markChunkDone,
  markChunkFailed,
  updateEpisode,
  deleteEpisode,
} = require('../db/queries');

async function runPipeline(audioPath, targetSec, label) {
  const episodeId = uuidv4();
  const originalConfig = require('../config').CHUNK_TARGET_SEC;
  process.env.CHUNK_TARGET_SEC = String(targetSec);

  // Reload config to pick up env override
  delete require.cache[require.resolve('../config')];
  const config = require('../config');

  console.log(`\n=== ${label} (CHUNK_TARGET_SEC=${targetSec}) ===`);
  console.log(`Episode ID: ${episodeId}`);

  try {
    // Create episode row (minimal; we'll delete after)
    createEpisode({ id: episodeId, title: label, audioFilename: path.basename(audioPath) });

    // Phase 1: normalize & split
    const normalizedPath = await normalize(audioPath, episodeId);
    const normalizedDuration = await getDuration(normalizedPath);
    updateEpisode(episodeId, { duration_seconds: normalizedDuration });

    const silences = await detectSilences(normalizedPath, normalizedDuration);
    const cutPoints = pickCutPoints(silences, normalizedDuration, config);
    const chunks = await cutChunks(normalizedPath, cutPoints, normalizedDuration, episodeId);
    insertChunks(episodeId, chunks);

    console.log(`Cut points: [${cutPoints.map(c => c.toFixed(1)).join(', ')}]`);
    console.log(`Chunks: ${chunks.length}`);

    // Phase 2: transcribe chunks
    const pending = getChunks(episodeId);
    const t0 = Date.now();

    const results = await runPool(pending, config.API_CONCURRENCY, async (chunk) => {
      const chunkPath = path.join(
        __dirname, '..', 'data', 'audio', 'chunks', episodeId,
        `${String(chunk.idx).padStart(3, '0')}.wav`
      );
      const tChunk = Date.now();
      const result = await transcribeChunk(chunkPath);
      const elapsed = ((Date.now() - tChunk) / 1000).toFixed(1);
      const wc = result.segments.reduce((n, s) => n + s.words.length, 0);
      console.log(`  chunk ${chunk.idx}: ${wc} words, ${elapsed}s`);
      markChunkDone(episodeId, chunk.idx, JSON.stringify(result));
      return result;
    });

    // Check for failures
    for (let i = 0; i < results.length; i++) {
      if (!results[i].ok) {
        console.error(`  chunk ${pending[i].idx} FAILED: ${results[i].error}`);
        markChunkFailed(episodeId, pending[i].idx, results[i].error);
      }
    }

    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Wall time: ${wall}s`);

    // Phase 3: merge
    const doneChunks = getChunks(episodeId);
    const result = mergeChunks(doneChunks);
    const totalWords = result.segments.reduce((n, s) => n + s.words.length, 0);
    console.log(`Merged: ${result.segments.length} segments, ${totalWords} words`);

    // Save to file
    const outPath = `/tmp/regression-${label.replace(/\s+/g, '-').toLowerCase()}.json`;
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`Saved to: ${outPath}`);

    return { episodeId, result, cutPoints, chunks: doneChunks };
  } finally {
    // Restore original config
    process.env.CHUNK_TARGET_SEC = String(originalConfig);
    delete require.cache[require.resolve('../config')];
    require('../config');
  }
}

function compareResults(single, multi) {
  console.log('\n=== COMPARISON ===');
  const s = single.result;
  const m = multi.result;

  console.log(`\nSingle-chunk: ${s.segments.length} segments, ${s.segments.reduce((n, sg) => n + sg.words.length, 0)} words`);
  console.log(`Multi-chunk:  ${m.segments.length} segments, ${m.segments.reduce((n, sg) => n + sg.words.length,0)} words`);

  const singleWords = s.segments.reduce((n, sg) => n + sg.words.length, 0);
  const multiWords = m.segments.reduce((n, sg) => n + sg.words.length, 0);
  const diff = multiWords - singleWords;
  const pct = singleWords > 0 ? (diff / singleWords * 100).toFixed(1) : 'N/A';
  console.log(`Difference: ${diff >= 0 ? '+' : ''}${diff} words (${pct}%)`);

  // Check monotonicity
  let prevEnd = -Infinity;
  let nonMonotonic = 0;
  for (const seg of m.segments) {
    if (seg.start < prevEnd) nonMonotonic++;
    prevEnd = seg.end;
  }
  console.log(`Non-monotonic segments: ${nonMonotonic}`);

  // Show text around each chunk boundary
  console.log(`\n--- Boundary text ---`);
  for (let ci = 0; ci < multi.cutPoints.length; ci++) {
    const cut = multi.cutPoints[i];
    const cutMmss = `${Math.floor(cut / 60)}:${String(Math.floor(cut % 60)).padStart(2, '0')}`;
    console.log(`\nBoundary ${ci + 1} (~${cutMmss}, cut at ${cut.toFixed(1)}s):`);

    // Find segments around this cut point in the multi-chunk result
    const nearby = m.segments.filter(sg =>
      Math.abs(sg.start - cut) < 30 || Math.abs(sg.end - cut) < 30
   );

    for (const sg of nearby.slice(0, 6)) {
      const start = `${Math.floor(sg.start / 60)}:${String(Math.floor(sg.start % 60)).padStart(2, '0')}`;
      console.log(`  [${start}] ${sg.text}`);
    }
  }

  // Full text diff (side by side)
  console.log(`\n--- Full text comparison ---`);
  console.log(`Single-chunk text saved to /tmp/regression-single-chunk.txt`);
  fs.writeFileSync('/tmp/regression-single-chunk.txt', s.segments.map(sg => sg.text).join('\n'));
  console.log(`Multi-chunk text saved to /tmp/regression-multi-chunk.txt`);
  fs.writeFileSync('/tmp/regression-multi-chunk.txt', m.segments.map(sg => sg.text).join('\n'));
}

async function main() {
  const src = process.argv[2];
  if (!src || !fs.existsSync(src)) {
    console.error('Usage: node scripts/regression.js <audio-file>');
    process.exit(1);
  }

  // Run single-chunk first
  const single = await runPipeline(src, 99999, 'single chunk');

  // Run multi-chunk
  const multi = await runPipeline(src, 120, 'multi chunk');

  // Compare
  compareResults(single, multi);

  // Cleanup episodes from DB
  console.log(`\nCleaning up...`);
  deleteEpisode(single.episodeId);
  deleteEpisode(multi.episodeId);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});