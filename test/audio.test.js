const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseSilencedetect,
  pickCutPoints,
} = require('../services/audio');

const CFG = {
  CHUNK_TARGET_SEC: 300,
  CHUNK_SEARCH_WINDOW_SEC: 60,
  CHUNK_MIN_SEC: 60,
};

// --- parseSilencedetect ---

test('parseSilencedetect: normal output', () => {
  const stderr = [
    '[silencedetect @ 0x7f8a1b00d000] silence_start: 4.8367',
    '[silencedetect @ 0x7f8a1b00d000] silence_end: 5.5367 | silence_duration: 0.7',
    '[silencedetect @ 0x7f8a1b00d000] silence_start: 120.0',
    '[silencedetect @ 0x7f8a1b00d000] silence_end: 121.2 | silence_duration: 1.2',
  ].join('\n');

  assert.deepStrictEqual(parseSilencedetect(stderr, 200), [
    { start: 4.8367, end: 5.5367 },
    { start: 120.0, end: 121.2 },
  ]);
});

test('parseSilencedetect: trailing unterminated silence uses totalDuration', () => {
  const stderr = [
    '[silencedetect @ 0x0] silence_start: 300.5',
    '[silencedetect @ 0x0] silence_end: 301.5 | silence_duration: 1.0',
    '[silencedetect @ 0x0] silence_start: 350.0',
  ].join('\n');

  assert.deepStrictEqual(parseSilencedetect(stderr, 400), [
    { start: 300.5, end: 301.5 },
    { start: 350.0, end: 400 },
  ]);
});

test('parseSilencedetect: no silences', () => {
  assert.deepStrictEqual(parseSilencedetect('', 100), []);
  assert.deepStrictEqual(
    parseSilencedetect('[silencedetect @ 0x0] no silence detected', 100),
    []
  );
});

// --- pickCutPoints ---

test('pickCutPoints: file shorter than target produces no cuts', () => {
  const silences = [];
  assert.deepStrictEqual(pickCutPoints(silences, 200, CFG), []);
});

test('pickCutPoints: silences exactly at targets', () => {
  const silences = [
    { start: 299.5, end: 300.5 },
    { start: 599.5, end: 600.5 },
    { start: 899.5, end: 900.5 },
  ];
  const cuts = pickCutPoints(silences, 1000, CFG);
  assert.deepStrictEqual(cuts, [300, 600, 900]);
});

test('pickCutPoints: no silence in window widens to ±2× and picks longest', () => {
  // Only silence is at midpoint 200 (outside ±60 of target 300, inside ±120).
  const silences = [
    { start: 195, end: 205 }, // mid 200, len 10
  ];
  const cuts = pickCutPoints(silences, 500, CFG);
  assert.deepStrictEqual(cuts, [200]);
});

test('pickCutPoints: hard cut at target when no silence anywhere near', () => {
  const cuts = pickCutPoints([], 500, CFG);
  assert.deepStrictEqual(cuts, [300]);
});

test('pickCutPoints: remainder shorter than CHUNK_MIN_SEC is absorbed', () => {
  // Target 300; a silence at 350 gives a 40s final chunk (< 60s min), so
  // the cut is dropped entirely and the file becomes a single chunk.
  const silences = [{ start: 349, end: 351 }]; // mid 350
  const cuts = pickCutPoints(silences, 390, CFG);
  assert.deepStrictEqual(cuts, []);
});

test('pickCutPoints: cut points strictly increasing', () => {
  // Spread silences across a long file and check monotonicity.
  const silences = [
    { start: 298, end: 302 },
    { start: 598, end: 602 },
    { start: 898, end: 902 },
    { start: 1198, end: 1202 },
  ];
  const cuts = pickCutPoints(silences, 1500, CFG);
  assert.ok(cuts.length > 0);
  for (let i = 1; i < cuts.length; i++) {
    assert.ok(cuts[i] > cuts[i - 1], `cut ${i} (${cuts[i]}) not > cut ${i - 1} (${cuts[i - 1]})`);
  }
  // Each cut is at least CHUNK_MIN_SEC after the previous (chunks >= min).
  let prev = 0;
  for (const c of cuts) {
    assert.ok(c - prev > CFG.CHUNK_MIN_SEC, `chunk ${c - prev}s too short`);
    prev = c;
  }
});
