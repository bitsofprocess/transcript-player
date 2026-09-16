/**
 * Phase 3: full merge + sanitize for chunked Whisper results.
 *
 * Takes an array of chunk rows from the DB (each with idx, start_sec,
 * end_sec, result_json) and produces the final segments-with-words structure
 * that the existing code writes to the database.
 */

/**
 * Known Whisper German hallucination phrases (case-insensitive).
 * General phrases that can be real speech are NOT included.
 */
const HALLUCINATION_EXACT_LOWERCASE = [
  'Untertitel im Auftrag des ZDF',
  'Untertitelung im Auftrag des ZDF',
  'Untertitel der Amara.org-Community',
  'Untertitel von Stephanie Geiges',
];

const HALLUCINATION_PATTERNS = [
  /^Untertitel(?:ung)? (im Auftrag|von|der)/i,
];

function isHallucination(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Strip trailing punctuation for comparison
  const cleaned = trimmed.replace(/[.!?,;:]+$/, '').trim().toLowerCase();
  for (const h of HALLUCINATION_EXACT_LOWERCASE) {
    if (cleaned === h.toLowerCase() || cleaned.startsWith(h.toLowerCase())) {
      return true;
    }
  }

  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

/**
 * Detect Whisper repetition loops within a single segment.
 *
 * Whisper sometimes produces a "loop" where the same 2-4 word phrase is
 * repeated 3+ times inside one segment, e.g.:
 *   "Ein gesetzliches Verhältnis zu einem gesetzlichen Verhältnis
 *    ist ein gesetzliches Verhältnis."
 *
 * Uses stemmed (first 4 chars lowercase) word matching to handle
 * German declension variants (gesetzliches / gesetzlichen).
 *
 * Returns the collapsed text (first occurrence only), or null if no loop.
 */
function collapseRepetitionLoop(text) {
  const words = text.trim().split(/\s+/);
  if (words.length < 4) return null; // minimum for a 2-gram repeating 3x

  // Stem each word: lowercase, first 4 chars (handles German inflection)
  const stems = words.map((w) => {
    const lower = w.toLowerCase();
    return lower.length <= 4 ? lower : lower.substring(0, 4);
  });

  // Check largest n-gram first so a 3-gram loop wins over a 2-gram sub-loop
  const maxN = Math.max(2, Math.min(4, Math.floor(words.length / 3)));
  for (let n = maxN; n >= 2; n--) {
    // Need at least n+2 words for 3 overlapping occurrences of an n-gram
    if (words.length < n + 2) continue;
    // Count occurrences of each n-gram (using stemmed words)
    const positions = new Map();
    for (let i = 0; i <= stems.length - n; i++) {
      const key = stems.slice(i, i + n).join(' ');
      if (!positions.has(key)) {
        positions.set(key, []);
      }
      positions.get(key).push(i);
    }

    // Check if any n-gram appears at least 3 times
    for (const [key, pos] of positions) {
      if (pos.length >= 3) {
        // Collapse at the first occurrence; keep everything up to
        // the end of the first n-gram in the loop.
        const endIndex = pos[0] + n;
        const collapsed = words.slice(0, endIndex).join(' ');
        console.log(
          `[merge] collapsed repetition loop: "${text.substring(0, 80)}…" ` +
          `(stemmed n-gram "${key}" repeated ${pos.length}x)`
        );
        return collapsed;
      }
    }
  }

  return null;
}

function isEmptyText(text) {
  return !text || text.trim().length === 0;
}

function clamp(val, lo, hi) {
  if (val < lo) return lo;
  if (val > hi) return hi;
  return val;
}

/**
 * Merge chunk results into a single sanitized transcript.
 *
 * @param {Array} chunks — [{ idx, start_sec, end_sec, result_json }]
 * @returns {{ duration: number, segments: Array }}
 */
function mergeChunks(chunks) {
  // 1. Sort by idx
  const sorted = [...chunks].sort((a, b) => a.idx - b.idx);
  if (sorted.length === 0) {
    return { duration: 0, segments: [] };
  }

  let allSegments = [];

  for (const chunk of sorted) {
    const offset = chunk.start_sec;
    const result = parseResultJson(chunk.result_json);

    if (!result || !result.segments) continue;

    for (const seg of result.segments) {
      // 4. Drop segments with empty/whitespace text
      if (isEmptyText(seg.text)) continue;

      // 2. Add offset to timestamps
      let segStart = seg.start + offset;
      let segEnd = seg.end + offset;

      // 3. Clamp into chunk bounds
      segStart = clamp(segStart, chunk.start_sec, chunk.end_sec);
      segEnd = clamp(segEnd, chunk.start_sec, chunk.end_sec);

      // Process words
      const words = [];
      if (seg.words && Array.isArray(seg.words)) {
        for (const w of seg.words) {
          if (!w.word || w.word.trim().length === 0) continue;

          let wStart = w.start + offset;
          let wEnd = w.end + offset;
          wStart = clamp(wStart, chunk.start_sec, chunk.end_sec);
          wEnd = clamp(wEnd, chunk.start_sec, chunk.end_sec);

          words.push({ word: w.word, start: wStart, end: wEnd });
        }
      }

      if (words.length === 0 && isEmptyText(seg.text)) continue;

      allSegments.push({
        start: segStart,
        end: segEnd,
        text: seg.text.trim(),
        words,
      });
    }
  }

  // 5. Hallucination filter
  const filteredHallucinations = [];
  for (const seg of allSegments) {
    if (isHallucination(seg.text)) {
      console.log(`[merge] dropped hallucination: "${seg.text}"`);
      continue;
    }
    filteredHallucinations.push(seg);
  }
  allSegments = filteredHallucinations;

  // 6a. Within-segment repetition loops: collapse single-segment loops
  for (const seg of allSegments) {
    const collapsed = collapseRepetitionLoop(seg.text);
    if (collapsed) {
      // Update text and trim words to match (keep only words up to the
      // collapsed text length, matching word count)
      const collapsedWords = collapsed.split(/\s+/).length;
      seg.text = collapsed;
      if (seg.words && seg.words.length > collapsedWords) {
        seg.words = seg.words.slice(0, collapsedWords);
      }
      if (seg.words && seg.words.length > 0) {
        seg.end = seg.words[seg.words.length - 1].end;
      }
    }
  }

  // 6b. Repetition loop: drop repeats when 3+ in a row (keep the first)
  const filteredRepetitions = [];
  for (let i = 0; i < allSegments.length; ) {
    const seg = allSegments[i];

    // Measure run length
    let runLen = 1;
    while (
      i + runLen < allSegments.length &&
      allSegments[i + runLen].text === seg.text
    ) {
      runLen++;
    }

    if (runLen >= 3) {
      // Keep first, drop the rest
      filteredRepetitions.push(seg);
    } else {
      // Keep all (run of 1 or 2)
      for (let j = 0; j < runLen; j++) {
        filteredRepetitions.push(allSegments[i + j]);
      }
    }

    i += runLen;
  }
  allSegments = filteredRepetitions;

  // 7. Enforce monotonic order (words are monotonic globally)
  let prevSegStart = -Infinity;
  let wordPrevStart = -Infinity;

  for (const seg of allSegments) {
    if (seg.start < prevSegStart) {
      seg.start = prevSegStart;
    }
    if (seg.end < seg.start) {
      seg.end = seg.start;
    }

    for (const w of seg.words) {
      if (w.start < wordPrevStart) {
        w.start = wordPrevStart;
      }
      if (w.end < w.start) {
        w.end = w.start;
      }
      wordPrevStart = w.start;
    }

    prevSegStart = seg.start;
  }

  // 8. Renumber segments sequentially
  for (let i = 0; i < allSegments.length; i++) {
    const seg = allSegments[i];
    for (let j = 0; j < seg.words.length; j++) {
      seg.words[j].seq = j;
    }
  }

  return {
    duration: sorted[sorted.length - 1].end_sec,
    segments: allSegments,
  };
}

function parseResultJson(json) {
  if (typeof json === 'string') {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  return json;
}

module.exports = { mergeChunks, collapseRepetitionLoop };