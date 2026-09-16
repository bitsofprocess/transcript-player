const { test } = require('node:test');
const assert = require('node:assert');
const { runPool, withRetry } = require('../services/pool');

// --- runPool ---

test('runPool: returns results in input order', async () => {
  const items = [3, 1, 2];
  const results = await runPool(items, 2, async (n, i) => {
    await sleep(n * 10); // larger delay → completes later
    return i * 10 + n;
  });
  // Expected: [0*10+3=3, 1*10+1=11, 2*10+2=22] in input order
  assert.deepStrictEqual(results, [
    { ok: true, value: 3 },
    { ok: true, value: 11 },
    { ok: true, value: 22 },
  ]);
});

test('runPool: respects concurrency cap', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;

  const items = [1, 2, 3, 4, 5];
  await runPool(items, 2, async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(30);
    concurrent--;
    return null;
  });

  assert.strictEqual(maxConcurrent, 2, 'max concurrency should be 2');
});

test('runPool: one failure does not cancel others', async () => {
  const items = [1, 2, 3];
  const results = await runPool(items, 2, async (n) => {
    await sleep(5);
    if (n === 2) throw new Error('boom');
    return n * 10;
  });

  assert.strictEqual(results.length, 3);
  assert.deepStrictEqual(results[0], { ok: true, value: 10 });
  assert.deepStrictEqual(results[1], { ok: false, error: 'boom' });
  assert.deepStrictEqual(results[2], { ok: true, value: 30 });
});

test('runPool: empty input returns empty array', async () => {
  const results = await runPool([], 3, async () => {});
  assert.deepStrictEqual(results, []);
});

test('runPool: works with limit larger than items', async () => {
  const items = [1, 2];
  const results = await runPool(items, 10, async (n) => n * 2);
  assert.deepStrictEqual(results, [
    { ok: true, value: 2 },
    { ok: true, value: 4 },
  ]);
});

// --- withRetry ---

test('withRetry: succeeds on first attempt', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return 'ok';
  });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 1);
});

test('withRetry: retries on network errors then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) {
      const err = new Error('ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      throw err;
    }
    return 'ok';
  });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 3);
});

test('withRetry: retries on HTTP 429 and 5xx', async () => {
  for (const status of [429, 500, 502, 503]) {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 2) {
        const err = new Error('HTTP error');
        err.response = { status, headers: {} };
        throw err;
      }
      return 'ok-' + status;
    });
    assert.strictEqual(result, 'ok-' + status);
    assert.strictEqual(attempts, 2, `status ${status} should retry once`);
  }
});

test('withRetry: does NOT retry on 400, 401, 413', async () => {
  for (const status of [400, 401, 413]) {
    let attempts = 0;
    try {
      await withRetry(async () => {
        attempts++;
        const err = new Error('Bad request');
        err.response = { status, headers: {} };
        throw err;
      });
      assert.fail(`should have thrown for ${status}`);
    } catch (err) {
      assert.strictEqual(attempts, 1, `status ${status} should NOT retry`);
      assert.strictEqual(err.response.status, status);
    }
  }
});

test('withRetry: throws after maxAttempts', async () => {
  let calls = 0;
  try {
    await withRetry(
      async () => {
        calls++;
        const err = new Error('ETIMEDOUT');
        err.code = 'ETIMEDOUT';
        throw err;
      },
      { maxAttempts: 3 }
    );
    assert.fail('should have thrown');
  } catch (err) {
    assert.strictEqual(calls, 3);
    assert.match(err.message, /ETIMEDOUT/);
  }
});

test('withRetry: non-network error thrown immediately', async () => {
  let calls = 0;
  try {
    await withRetry(async () => {
      calls++;
      throw new Error('syntax error in config');
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert.strictEqual(calls, 1);
    assert.match(err.message, /syntax error/);
  }
});

// --- helpers ---

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}