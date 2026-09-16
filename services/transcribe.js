const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { withRetry } = require('./pool');
const config = require('../config');

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// Shared across calls — reset per episode
let tscribeUsage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost: 0, calls: 0 };

function resetTranscribeUsage() {
  tscribeUsage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost: 0, calls: 0 };
}

function getTranscribeUsage() {
  return { ...tscribeUsage };
}

function logTranscribeUsage(episodeId, chunkIdx, usage) {
  const promptTokens = usage?.prompt_tokens || 0;
  const completionTokens = usage?.completion_tokens || 0;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens || 0;
  const cost = usage?.cost || 0;

  tscribeUsage.prompt_tokens += promptTokens;
  tscribeUsage.completion_tokens += completionTokens;
  tscribeUsage.reasoning_tokens += reasoningTokens;
  tscribeUsage.cost += cost;
  tscribeUsage.calls += 1;

  console.log(
    `[usage] transcription episode=${episodeId} chunk=${chunkIdx} ` +
    `prompt=${promptTokens} completion=${completionTokens} ` +
    `reasoning=${reasoningTokens} cost=$${cost.toFixed(6)}`
  );
}

/**
 * Transcribe a single audio chunk using OpenRouter's Whisper endpoint.
 *
 * Chunk-specific options:
 *   - language="de" (explicit; short chunks get misdetected otherwise)
 *   - prompt=WHISPER_PROMPT if non-empty (identical for every chunk)
 *   - 180s axios timeout + exponential retry via withRetry
 *
 * NOTE: OpenRouter's Whisper returns an EITHER/OR response:
 *   - timestamp_granularities=word → flat words[] array, NO segments
 *   - timestamp_granularities=segment (or omitted) → segments[], NO nested words
 * So we use the word-level response and derive segments ourselves.
 *
 * Returns: { duration, segments: [{ start, end, text, words: [{ word, start, end }] }] }
 */
async function transcribeChunk(filePath, episodeId, chunkIdx) {
  const form = new FormData();
  form.append('model', 'openai/whisper-large-v3');
  form.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
  });
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities', 'word');
  form.append('language', 'de');
  if (config.WHISPER_PROMPT) {
    form.append('prompt', config.WHISPER_PROMPT);
  }

  const response = await withRetry(() =>
    axios.post(`${OPENROUTER_BASE}/audio/transcriptions`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${process.env.TRANSCRIPT_OPENROUTER_KEY}`,
      },
      timeout: 180_000,
    })
  );

  const data = response.data;

  // Log usage
  const episodeIdStr = episodeId || 'unknown';
  const chunkIdxStr = chunkIdx !== undefined ? chunkIdx : '?';
  logTranscribeUsage(episodeIdStr, chunkIdxStr, data.usage);

  // Handle case where OpenRouter returns an error payload
  if (data.error) {
    throw new Error(`Whisper API error: ${JSON.stringify(data.error)}`);
  }

  const words = data.words;
  if (!words || !Array.isArray(words) || words.length === 0) {
    throw new Error('No words returned from transcription');
  }

  // Derive segments from flat word list by splitting at sentence boundaries
  const segments = deriveSegments(words);

  return {
    duration: data.duration || null,
    segments,
  };
}

/**
 * Backward-compatible wrapper (used by Phase 1 single-file path, scripts, etc.)
 */
async function transcribe(audioPath) {
  return transcribeChunk(audioPath);
}

/**
 * Phase 2 naive merge: take chunk results (from chunks.result_json) and stitch
 * them into a single { duration, segments } result. This is a throwaway bridge
 * replaced by the full merge in Phase 3.
 */
function naiveMergeChunks(chunkRows) {
  // Each row: { idx, start_sec, end_sec, result_json }
  const sorted = [...chunkRows].sort((a, b) => a.idx - b.idx);
  const allSegments = [];

  for (const chunk of sorted) {
    const offset = chunk.start_sec;
    const result = JSON.parse(chunk.result_json);

    for (const seg of result.segments) {
      allSegments.push({
        start: seg.start + offset,
        end: seg.end + offset,
        text: seg.text,
        words: (seg.words || []).map((w) => ({
          word: w.word,
          start: w.start + offset,
          end: w.end + offset,
        })),
      });
    }
  }

  return {
    duration: sorted.length > 0 ? sorted[sorted.length - 1].end_sec : 0,
    segments: allSegments,
  };
}

/**
 * Group a flat word list into subtitle-like segments.
 *
 * Splitting rules:
 *  1. Sentence-ending punctuation ( . ! ? ) after a word triggers a segment break
 *  2. A pause of > 2.0 seconds between consecutive words triggers a break
 *     (but not if the current segment has < 3 words — prevents isolated
 *      connector words like "aber", "und")
 *  3. A segment exceeding 30 words is force-split at a colon, semicolon,
 *     dash, or mid-point (never at commas)
 */
function deriveSegments(words) {
  const segments = [];
  let current = null;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];

    if (!current) {
      current = { start: w.start, end: w.end, textParts: [w.word], wordObjs: [w] };
      continue;
    }

    const gap = w.start - current.end;
    const prevWord = current.textParts[current.textParts.length - 1];

    // A sentence end is . ! or ? — but exclude numbers like "300.000" or "5."
    const isPeriodEnd = /\.$/.test(prevWord) && !isNumeric(prevWord);
    const isBangEnd = /[!?]$/.test(prevWord);
    const isSentenceEnd = isPeriodEnd || isBangEnd;
    const isLongPause = gap > 2.0;

    if ((isSentenceEnd || isLongPause) && current.textParts.length >= 3) {
      segments.push(buildSegment(current));
      current = { start: w.start, end: w.end, textParts: [w.word], wordObjs: [w] };
      continue;
    }

    if (current.textParts.length >= 30) {
      const splitAt = findClauseBoundary(current.textParts);
      if (splitAt > 0 && splitAt < current.textParts.length - 2) {
        const tail = splitSegment(current, splitAt);
        segments.push(buildSegment(current));
        current = tail;
        current.textParts.push(w.word);
        current.wordObjs.push(w);
        current.end = w.end;
      } else {
        segments.push(buildSegment(current));
        current = { start: w.start, end: w.end, textParts: [w.word], wordObjs: [w] };
      }
      continue;
    }

    current.textParts.push(w.word);
    current.wordObjs.push(w);
    current.end = w.end;
  }

  if (current && current.textParts.length > 0) {
    segments.push(buildSegment(current));
  }

  return mergeShortSegments(segments);
}

/** Merge any segment with < 4 words into the previous one */
function mergeShortSegments(segments) {
  if (segments.length < 2) return segments;

  const merged = [];
  for (const seg of segments) {
    if (merged.length > 0 && seg.words.length < 4) {
      const last = merged[merged.length - 1];
      last.text = last.text + ' ' + seg.text;
      last.end = seg.end;
      last.words = last.words.concat(seg.words);
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

function isNumeric(word) {
  return /^[\d.,]+$/.test(word);
}

function buildSegment({ start, end, textParts, wordObjs }) {
  return {
    start,
    end,
    text: textParts.join(' '),
    words: wordObjs.map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end,
    })),
  };
}

function findClauseBoundary(textParts) {
  for (let i = textParts.length - 2; i >= 1; i--) {
    if (/[;:–—]$/.test(textParts[i])) {
      return i + 1;
    }
  }
  return 0;
}

function splitSegment(current, splitAt) {
  const tailParts = current.textParts.splice(splitAt);
  const tailWords = current.wordObjs.splice(splitAt);
  const tail = {
    start: tailWords[0].start,
    end: current.end,
    textParts: tailParts,
    wordObjs: tailWords,
  };
  current.end = current.wordObjs[current.wordObjs.length - 1].end;
  return tail;
}

module.exports = { transcribe, transcribeChunk, naiveMergeChunks, resetTranscribeUsage, getTranscribeUsage };