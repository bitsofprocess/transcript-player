/**
 * Phase 4: Batched parallel translation via OpenRouter DeepSeek.
 *
 * Features:
 *   - Splits segments into batches of TRANSLATION_BATCH_SIZE
 *   - Runs batches through runPool with API_CONCURRENCY
 *   - Each batch wrapped in withRetry
 *   - Context segments from previous batch shown (unnumbered)
 *   - Strict parser parseNumberedTranslations with recursive batch-splitting
 *   - Usage logging (tokens, cost) after every call + episode totals
 */

const axios = require('axios');
const { runPool, withRetry } = require('./pool');
const config = require('../config');

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// Accumulate usage across calls for totals at episode end
let episodeUsage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost: 0, calls: 0 };

function resetUsage() {
  episodeUsage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost: 0, calls: 0 };
}

function getUsageTotals() {
  return { ...episodeUsage };
}

function logUsage(stage, episodeId, batchIdx, usage) {
  const promptTokens = usage?.prompt_tokens || 0;
  const completionTokens = usage?.completion_tokens || 0;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens || 0;
  const cost = usage?.cost || 0;

  episodeUsage.prompt_tokens += promptTokens;
  episodeUsage.completion_tokens += completionTokens;
  episodeUsage.reasoning_tokens += reasoningTokens;
  episodeUsage.cost += cost;
  episodeUsage.calls += 1;

  console.log(
    `[usage] ${stage} episode=${episodeId} batch=${batchIdx} ` +
    `prompt=${promptTokens} completion=${completionTokens} ` +
    `reasoning=${reasoningTokens} cost=$${cost.toFixed(6)}`
  );
}

function logTotals(episodeId) {
  const u = episodeUsage;
  console.log(
    `[usage] TOTALS episode=${episodeId} calls=${u.calls} ` +
    `prompt=${u.prompt_tokens} completion=${u.completion_tokens} ` +
    `reasoning=${u.reasoning_tokens} cost=$${u.cost.toFixed(6)}`
  );
}

/**
 * Translate a single batch of German segment texts using DeepSeek.
 *
 * @param {string[]} germanTexts — texts for this batch (length ≤ TRANSLATION_BATCH_SIZE)
 * @param {string[] | null} contextTexts — previous TRANSLATION_CONTEXT_SEGMENTS German texts
 * @param {number} batchIdx — 0-based batch index (for logging)
 * @param {string} episodeId — for logging
 * @returns {string} — raw LLM response text
 */
async function translateBatch(germanTexts, contextTexts, batchIdx, episodeId) {
  const numbered = germanTexts
    .map((text, i) => `${i + 1}. ${text}`)
    .join('\n');

  let contextBlock = '';
  if (contextTexts && contextTexts.length > 0) {
    contextBlock =
      '=== CONTEXT (do NOT translate, for reference only) ===\n' +
      contextTexts.join('\n') +
      '\n\n';
  }

  const prompt =
    `${contextBlock}` +
    `Translate each numbered German line into natural, idiomatic English.
Return ONLY a numbered list matching the input numbering exactly, one
translation per line, no commentary, no extra formatting.

${numbered}`;

  const response = await withRetry(() =>
    axios.post(
      `${OPENROUTER_BASE}/chat/completions`,
      {
        model: 'deepseek/deepseek-v4-pro',
        messages: [
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.TRANSCRIPT_OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 180_000,
      }
    )
  );

  const usage = response.data.usage;
  logUsage('translation', episodeId, batchIdx, usage);

  return response.data.choices[0].message.content;
}

/**
 * Strict parser: extract exactly expectedCount translations numbered 1..N.
 *
 * Throws if any number is missing, duplicated, or an out-of-range line appears.
 *
 * @param {string} text — raw LLM response
 * @param {number} expectedCount
 * @returns {string[]} — translations in order (index 0 = translation for #1)
 */
function parseNumberedTranslations(text, expectedCount) {
  const lines = text.split('\n');
  const map = new Map();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^(\d+)[\.\)]\s?(.*)$/);
    if (!match) continue;

    const num = parseInt(match[1], 10);
    const translation = match[2].trim();

    if (num < 1 || num > expectedCount) {
      throw new Error(
        `Numbered line out of range: ${num} (expected 1..${expectedCount})`
      );
    }

    if (map.has(num)) {
      throw new Error(`Duplicate number in translation: ${num}`);
    }

    map.set(num, translation);
  }

  // Check we have exactly 1..expectedCount
  const missing = [];
  for (let i = 1; i <= expectedCount; i++) {
    if (!map.has(i)) {
      missing.push(i);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing translation numbers: ${missing.join(', ')} ` +
      `(got ${map.size}/${expectedCount})`
    );
  }

  // Return in order
  const result = [];
  for (let i = 1; i <= expectedCount; i++) {
    result.push(map.get(i));
  }

  return result;
}

/**
 * Translate a batch with validation and recursive splitting.
 *
 * Tries up to 3 times with the full batch. If validation still fails,
 * splits the batch in half and recursively translates each half.
 *
 * @param {string[]} germanTexts
 * @param {string[] | null} contextTexts
 * @param {number} batchIdx
 * @param {string} episodeId
 * @returns {string[]}
 */
async function translateBatchValidated(germanTexts, contextTexts, batchIdx, episodeId) {
  // Try up to 3 times with full batch
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = await translateBatch(germanTexts, contextTexts, batchIdx, episodeId);
      const parsed = parseNumberedTranslations(raw, germanTexts.length);
      return parsed;
    } catch (err) {
      console.warn(
        `[translation] batch=${batchIdx} attempt=${attempt}/3 failed: ${err.message}`
      );
      if (attempt === 3) {
        break; // Fall through to split
      }
    }
  }

  // Split in half and translate recursively
  const mid = Math.ceil(germanTexts.length / 2);
  if (mid >= germanTexts.length) {
    // Cannot split further — single segment, give up
    throw new Error(
      `Translation failed for single segment after 3 attempts: "${germanTexts[0].substring(0, 60)}…"`
    );
  }

  const leftTexts = germanTexts.slice(0, mid);
  const rightTexts = germanTexts.slice(mid);

  console.warn(
    `[translation] batch=${batchIdx} splitting ${germanTexts.length}→${leftTexts.length}+${rightTexts.length}`
  );

  const left = await translateBatchValidated(leftTexts, contextTexts, batchIdx, episodeId);

  // Right half gets the last TRANSLATION_CONTEXT_SEGMENTS of left as context
  const rightContext = contextTexts
    ? [...contextTexts, ...leftTexts].slice(-config.TRANSLATION_CONTEXT_SEGMENTS)
    : leftTexts.slice(-config.TRANSLATION_CONTEXT_SEGMENTS);

  const right = await translateBatchValidated(rightTexts, rightContext, batchIdx, episodeId);

  return [...left, ...right];
}

/**
 * Translate all segments using batched parallel translation.
 *
 * Replaces the old single-call translate().
 *
 * @param {string[]} germanTexts — all segment texts in order
 * @param {string} episodeId — for logging
 * @returns {string[]} — English translations in order
 */
async function translateAll(germanTexts, episodeId, onProgress) {
  resetUsage();
  const batchSize = config.TRANSLATION_BATCH_SIZE;

  // Split into batches
  const batches = [];
  for (let i = 0; i < germanTexts.length; i += batchSize) {
    const batchTexts = germanTexts.slice(i, i + batchSize);
    const contextStart = Math.max(0, i - config.TRANSLATION_CONTEXT_SEGMENTS);
    const contextTexts = i > 0
      ? germanTexts.slice(contextStart, i)
      : null;
    batches.push({ texts: batchTexts, contextTexts, idx: batches.length });
  }

  console.log(
    `[translation] episode=${episodeId} ${batches.length} batches ` +
    `(concurrency=${config.API_CONCURRENCY})`
  );

  const t0 = Date.now();
  let batchDoneCount = 0;

  const results = await runPool(batches, config.API_CONCURRENCY, async (batch) => {
    const tBatch = Date.now();
    const translations = await translateBatchValidated(
      batch.texts, batch.contextTexts, batch.idx, episodeId
    );
    const elapsed = ((Date.now() - tBatch) / 1000).toFixed(1);
    console.log(`[translation] batch=${batch.idx} done: ${elapsed}s`);
    batchDoneCount++;
    if (onProgress) {
      onProgress(batchDoneCount, batches.length);
    }
    return translations;
  });

  // Check for failures and flatten
  const allTranslations = [];
  for (let i = 0; i < results.length; i++) {
    if (!results[i].ok) {
      throw new Error(`Translation batch ${i} failed: ${results[i].error}`);
    }
    allTranslations.push(...results[i].value);
  }

  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[translation] episode=${episodeId} all ${batches.length} batches done in ${wall}s`
  );
  logTotals(episodeId);

  return allTranslations;
}

/**
 * Backward-compatible wrapper used by route handlers.
 */
async function translate(germanTexts, episodeId, onProgress) {
  if (!episodeId) {
    episodeId = 'unknown';
  }
  return translateAll(germanTexts, episodeId, onProgress);
}

module.exports = {
  translate,
  translateAll,
  parseNumberedTranslations,
  resetUsage,
  getUsageTotals,
};