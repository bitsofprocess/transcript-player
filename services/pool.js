/**
 * Simple concurrency pool — runs `worker(item, index)` with at most `limit`
 * in flight. Returns results in input order. Individual failures do not
 * cancel the pool; each result is { ok, value } or { ok: false, error }.
 */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  const initial = Math.min(limit, items.length);
  let nextIndex = initial;

  async function run(idx) {
    try {
      const value = await worker(items[idx], idx);
      results[idx] = { ok: true, value };
    } catch (err) {
      results[idx] = { ok: false, error: err.message || String(err) };
    }
    const i = nextIndex++;
    if (i < items.length) {
      await run(i);
    }
  }

  const tasks = [];
  for (let i = 0; i < initial; i++) {
    tasks.push(run(i));
  }
  await Promise.all(tasks);

  return results;
}

/**
 * Retry wrapper for OpenRouter API calls.
 *
 * Retries on: network errors, timeouts, HTTP 429 (rate-limit), and 5xx.
 * Does NOT retry on other 4xx (400, 401, 413, etc.) — fails immediately.
 * Exponential backoff: ~1s, 2s, 4s, 8s, with jitter.
 * Honors a Retry-After header if present.
 */
async function withRetry(fn, { maxAttempts = 4 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // Distinguish axios errors (has .response) from non-network errors
      const status = err.response?.status;

      // Non-network errors (e.g. invalid config) — throw immediately
      if (status === undefined && !err.request && !err.code) {
        throw err;
      }

      // Don't retry client errors (except 429)
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }

      if (attempt === maxAttempts) {
        throw lastErr;
      }

      // Exponential backoff with jitter
      const base = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s, 8s
      const retryAfter = err.response?.headers?.['retry-after'];
      const delay = retryAfter
        ? Number(retryAfter) * 1000
        : base + Math.random() * base;

      console.warn(
        `[withRetry] attempt ${attempt}/${maxAttempts}, ` +
        `waiting ${(delay / 1000).toFixed(1)}s: ${err.message}`
      );

      await new Promise((r) => setTimeout(r, delay));
    }
  }
  /* istanbul ignore next */
  throw lastErr;
}

module.exports = { runPool, withRetry };