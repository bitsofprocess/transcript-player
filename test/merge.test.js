const { test } = require('node:test');
const assert = require('node:assert');
const { mergeChunks, collapseRepetitionLoop } = require('../services/merge');

// Helper: build a chunk row from a plain object
function chunk(idx, start, end, segments) {
  return {
    idx,
    start_sec: start,
    end_sec: end,
    result_json: JSON.stringify({ duration: end - start, segments }),
  };
}

function seg(start, end, text, words) {
  return { start, end, text, words: words || [] };
}

function w(word, start, end) {
  return { word, start, end };
}

function textOf(segments) {
  return segments.map((s) => s.text);
}

// --- Offsets ---

test('merge: offsets applied correctly', () => {
  const chunks = [
    chunk(0, 0, 10, [seg(1, 3, 'hello', [w('he', 1, 1.5), w('llo', 1.5, 3)])]),
    chunk(1, 10, 20, [seg(8, 9, 'world', [w('wo', 8, 8.5), w('rld', 8.5, 9)])]),
  ];

  const result = mergeChunks(chunks);
  assert.strictEqual(result.segments.length, 2);

  // Chunk 0: offsets by 0
  assert.strictEqual(result.segments[0].start, 1);
  assert.strictEqual(result.segments[0].end, 3);
  assert.strictEqual(result.segments[0].words[0].start, 1);
  assert.strictEqual(result.segments[0].words[1].end, 3);

  // Chunk 1: offsets by 10
  assert.strictEqual(result.segments[1].start, 18);  // 8 + 10
  assert.strictEqual(result.segments[1].end, 19);    // 9 + 10
  assert.strictEqual(result.segments[1].words[0].start, 18);  // 8 + 10
  assert.strictEqual(result.segments[1].words[1].end, 19);    // 9 + 10
});

// --- Clamping ---

test('merge: clamping into chunk bounds', () => {
  // Segment extends beyond chunk boundaries
  const chunks = [
    chunk(0, 0, 10, [seg(-1, 11, 'overflow', [w('a', -1, 11)])]),
  ];

  const result = mergeChunks(chunks);
  assert.strictEqual(result.segments[0].start, 0);  // clamped up
  assert.strictEqual(result.segments[0].end, 10);   // clamped down
  assert.strictEqual(result.segments[0].words[0].start, 0);
  assert.strictEqual(result.segments[0].words[0].end, 10);
});

// --- Empty removal ---

test('merge: drops empty and whitespace-only segments', () => {
  const chunks = [
    chunk(0, 0, 10, [
      seg(0, 1, 'ok'),
      seg(1, 2, ''),
      seg(2, 3, '   '),
      seg(3, 4, 'another'),
    ]),
  ];

  const result = mergeChunks(chunks);
  assert.deepStrictEqual(textOf(result.segments), ['ok', 'another']);
});

test('merge: drops words with empty text', () => {
  const chunks = [
    chunk(0, 0, 5, [
      seg(1, 3, 'mixed', [w('good', 1, 2), w('', 2, 2.5), w('', 2.5, 3)]),
    ]),
  ];

  const result = mergeChunks(chunks);
  assert.strictEqual(result.segments[0].words.length, 1);
  assert.strictEqual(result.segments[0].words[0].word, 'good');
});

// --- Hallucination ---

test('merge: drops Untertitel hallucinations', () => {
  const chunks = [
    chunk(0, 0, 10, [
      seg(0, 1, 'Untertitel im Auftrag des ZDF'),
      seg(1, 2, 'real German text'),
      seg(2, 3, 'Untertitelung von Stephan'),  // regex match
      seg(3, 4, 'Untertitel der Amara.org-Community, 2024'),  // starts with
      seg(4, 5, 'Vielen Dank fürs Zuhören'),   // NOT dropped
    ]),
  ];

  const result = mergeChunks(chunks);
  assert.deepStrictEqual(
    textOf(result.segments),
    ['real German text', 'Vielen Dank fürs Zuhören']
  );
});

// --- Repetition loop ---

test('merge: drops 3+ repeated segments, keeps 1-2 repetitions', () => {
  const chunks = [
    chunk(0, 0, 10, [
      seg(0, 1, 'A'),
      seg(1, 2, 'A'),   // run of 2: keep both
      seg(2, 3, 'B'),
      seg(3, 4, 'C'),
      seg(4, 5, 'C'),
      seg(5, 6, 'C'),
      seg(6, 7, 'C'),   // run of 4: keep only first C
      seg(7, 8, 'D'),
      seg(8, 9, 'E'),
      seg(9, 10, 'E'),  // run of 2: keep both
    ]),
  ];

  const result = mergeChunks(chunks);
  assert.deepStrictEqual(
    textOf(result.segments),
    ['A', 'A', 'B', 'C', 'D', 'E', 'E']
  );
});

// --- Monotonicity ---

test('merge: enforces monotonic timestamps — words monotonic globally', () => {
  const chunks = [
    chunk(0, 0, 20, [
      seg(5, 8, 'first', [w('a', 5, 6), w('b', 6, 8)]),
      seg(4, 9, 'backwards-start', [w('c', 3, 7), w('d', 6, 9)]),
    ]),
  ];

  const result = mergeChunks(chunks);

  // Second segment nudged to first segment's start
  assert.strictEqual(result.segments[1].start, result.segments[0].start);
  assert.ok(result.segments[1].end >= result.segments[1].start);

  // First word of second segment is before last word of first segment (global monotonicity)
  const lastWordS0 = result.segments[0].words[result.segments[0].words.length - 1];
  const firstWordS1 = result.segments[1].words[0];
  assert.ok(firstWordS1.start >= lastWordS0.start,
    `word ${firstWordS1.start} should be >= ${lastWordS0.start}`);
});

test('merge: fixes end < start within a word', () => {
  const chunks = [
    chunk(0, 0, 5, [
      seg(1, 3, 'test', [w('oops', 2, 1)]),  // end < start
    ]),
  ];

  const result = mergeChunks(chunks);
  assert.strictEqual(result.segments[0].words[0].end, result.segments[0].words[0].start);
});

// --- Sorting ---

test('merge: segments returned in chunk idx order', () => {
  const chunks = [
    chunk(2, 20, 30, [seg(25, 26, 'third')]),
    chunk(0, 0, 10, [seg(1, 2, 'first')]),
    chunk(1, 10, 20, [seg(15, 16, 'second')]),
  ];

  const result = mergeChunks(chunks);
  assert.deepStrictEqual(textOf(result.segments), ['first', 'second', 'third']);
});

// --- Empty input ---

test('merge: empty chunks returns empty', () => {
  const result = mergeChunks([]);
  assert.strictEqual(result.duration, 0);
  assert.strictEqual(result.segments.length, 0);
}) ;

test('merge: invalid result_json skipped gracefully', () => {
  const chunks = [
    { idx: 0, start_sec: 0, end_sec: 10, result_json: 'garbage' },
    chunk(1, 10, 20, [seg(15, 16, 'valid')]),
  ];

  const result = mergeChunks(chunks);
  assert.strictEqual(result.segments.length, 1);
  assert.strictEqual(result.segments[0].text, 'valid');
});

// --- Within-segment repetition loops ---

test('collapseRepetitionLoop: detects 3x 2-gram loop and collapses', () => {
  // "Ein gesetzliches Verhältnis zu einem gesetzlichen Verhältnis ist ein gesetzliches Verhältnis."
  const text = 'Ein gesetzliches Verhältnis zu einem gesetzlichen Verhältnis ist ein gesetzliches Verhältnis.';
  const result = collapseRepetitionLoop(text);
  assert.ok(result, 'should detect repetition loop');
  const resultWords = result.split(/\s+/).length;
  const originalWords = text.split(/\s+/).length;
  assert.ok(resultWords < originalWords, 'collapsed should have fewer words');
  assert.ok(
    result.toLowerCase().includes('gesetzliches verhältnis'),
    'should preserve the key phrase'
  );
});

test('collapseRepetitionLoop: returns null for normal text', () => {
  const text = 'Dies ist ein ganz normaler Satz ohne Wiederholung.';
  const result = collapseRepetitionLoop(text);
  assert.strictEqual(result, null);
});

test('collapseRepetitionLoop: returns null for text with only 2 repetitions', () => {
  const text = 'Das ist gut das ist gut und das wars.';
  const result = collapseRepetitionLoop(text);
  assert.strictEqual(result, null);
});

test('collapseRepetitionLoop: returns null for fewer than 6 words', () => {
  const text = 'kurzer text';
  const result = collapseRepetitionLoop(text);
  assert.strictEqual(result, null);
});

test('collapseRepetitionLoop: detects 3x 3-gram loop', () => {
  const text = 'Ich bin müde ich bin müde ich bin müde ja.';
  const result = collapseRepetitionLoop(text);
  assert.ok(result, 'should detect 3-gram loop');
  const resultLower = result.toLowerCase();
  const count = (resultLower.match(/ich bin müde/g) || []).length;
  assert.strictEqual(count, 1, 'collapsed should have phrase only once');
});

test('merge: within-segment repetition loop is collapsed', () => {
  const chunks = [
    chunk(0, 0, 10, [
      seg(0, 5, 'Gut tag', [w('Gut', 0, 1), w('tag', 2, 3)]),
      seg(5, 10, 'ja ja ja ja ja', [w('ja', 5, 6), w('ja', 6, 7), w('ja', 7, 8), w('ja', 8, 9), w('ja', 9, 10)]),
    ]),
  ];

  const result = mergeChunks(chunks);
  assert.strictEqual(result.segments.length, 2);
  const collapsed = result.segments[1];
  assert.ok(collapsed.words.length < 5, 'words should be trimmed');
});