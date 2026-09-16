// Phase 1 verification script (run manually):
//   node scripts/phase1-check.js <source-audio-file>
//
// 1. Splits a real file and reports chunk boundaries/lengths.
// 2. Verifies the sum of chunk lengths equals the normalized duration.
// 3. Generates short files in MP3/WAV/FLAC/M4A/OGG and compares
//    original vs normalized ffprobe durations.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const {
  normalize,
  getDuration,
  detectSilences,
  pickCutPoints,
  cutChunks,
} = require('../services/audio');
const config = require('../config');

const TMP = '/tmp/tp-phase1-check';

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });
}

async function realFileSplit(src) {
  console.log('=== 1. Real-file split ===');
  const id = 'phase1-check';
  const norm = await normalize(src, id);
  const dur = await getDuration(norm);
  const silences = await detectSilences(norm, dur);
  const cuts = pickCutPoints(silences, dur, config);
  const chunks = await cutChunks(norm, cuts, dur, id);

  console.log(`normalized duration: ${dur.toFixed(3)}s`);
  console.log(`silences detected:   ${silences.length}`);
  console.log(`cut points:           [${cuts.map(c => c.toFixed(2)).join(', ')}]`);
  console.log(`chunks:               ${chunks.length}`);

  let nominalSum = 0;
  let actualSum = 0;
  for (const c of chunks) {
    const actual = await getDuration(c.path);
    nominalSum += c.end - c.start;
    actualSum += actual;
    console.log(
      `  chunk ${String(c.idx).padStart(3, '0')}: ` +
      `${c.start.toFixed(2)}s → ${c.end.toFixed(2)}s ` +
      `(nominal ${(c.end - c.start).toFixed(2)}s, actual ${actual.toFixed(3)}s)`
    );
  }
  console.log(`nominal sum: ${nominalSum.toFixed(3)}s`);
  console.log(`actual sum:  ${actualSum.toFixed(3)}s`);
  console.log(`normalized:  ${dur.toFixed(3)}s`);
  console.log(`diff (actual vs normalized): ${Math.abs(actualSum - dur).toFixed(4)}s`);
  console.log('');
}

async function formatCoverage(src) {
  console.log('=== 2. Format coverage (original vs normalized duration) ===');
  fs.mkdirSync(TMP, { recursive: true });

  const formats = [
    { ext: 'mp3', args: ['-c:a', 'libmp3lame'] },
    { ext: 'wav', args: ['-c:a', 'pcm_s16le'] },
    { ext: 'flac', args: ['-c:a', 'flac'] },
    { ext: 'm4a', args: ['-c:a', 'aac'] },
    { ext: 'ogg', args: ['-c:a', 'libvorbis'] },
  ];

  console.log('format  original(s)  normalized(s)  diff(s)');
  console.log('------  -----------  -------------  -------');

  for (const { ext, args } of formats) {
    const clip = path.join(TMP, `clip.${ext}`);
    // 30-second re-encoded clip in the target format
    ffmpeg(['-ss', '10', '-t', '30', '-i', src, ...args, clip]);

    const origDur = await getDuration(clip);
    const id = `fmt-${ext}`;
    const norm = await normalize(clip, id);
    const normDur = await getDuration(norm);

    const diff = Math.abs(origDur - normDur);
    console.log(
      `${ext.padEnd(6)}  ${origDur.toFixed(3).padStart(11)}  ` +
      `${normDur.toFixed(3).padStart(13)}  ${diff.toFixed(3).padStart(6)}` +
      (diff > 0.1 ? '  <-- MISMATCH' : '')
    );
  }
  console.log('');
}

async function main() {
  const src = process.argv[2];
  if (!src || !fs.existsSync(src)) {
    console.error('Usage: node scripts/phase1-check.js <source-audio-file>');
    process.exit(1);
  }

  await realFileSplit(src);
  await formatCoverage(src);

  console.log('Done. Cleanup: rm -rf /tmp/tp-phase1-check data/audio/normalized/phase1-check.wav data/audio/chunks/phase1-check data/audio/normalized/fmt-*');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
