const { test } = require('node:test');
const assert = require('node:assert');
const { parseNumberedTranslations } = require('../services/translate');

test('parseNumberedTranslations: valid output', () => {
  const input = '1. Hello\n2. World\n3. Test';
  const result = parseNumberedTranslations(input, 3);
  assert.deepStrictEqual(result, ['Hello', 'World', 'Test']);
});

test('parseNumberedTranslations: accepts N) format', () => {
  const input = '1) first\n2) second\n3) third';
  const result = parseNumberedTranslations(input, 3);
  assert.deepStrictEqual(result, ['first', 'second', 'third']);
});

test('parseNumberedTranslations: tolerates leading/trailing blank lines', () => {
  const input = '\n\n1. one\n2. two\n\n';
  const result = parseNumberedTranslations(input, 2);
  assert.deepStrictEqual(result, ['one', 'two']);
});

test('parseNumberedTranslations: ignores non-numbered commentary lines', () => {
  const input = 'Here are the translations:\n1. first\n\nSome note\n2. second';
  const result = parseNumberedTranslations(input, 2);
  assert.deepStrictEqual(result, ['first', 'second']);
});

test('parseNumberedTranslations: throws on missing number', () => {
  const input = '1. first\n3. third';
  assert.throws(
    () => parseNumberedTranslations(input, 3),
    /Missing translation numbers: 2/
  );
});

test('parseNumberedTranslations: throws on duplicate number', () => {
  const input = '1. first\n2. second\n2. also second';
  assert.throws(
    () => parseNumberedTranslations(input, 2),
    /Duplicate number/
  );
});

test('parseNumberedTranslations: throws on out-of-range number', () => {
  const input = '1. one\n5. five';
  assert.throws(
    () => parseNumberedTranslations(input, 2),
    /Numbered line out of range: 5/
  );
});

test('parseNumberedTranslations: handles no-space-after-dot format', () => {
  const input = '1.Hello\n2.World';
  const result = parseNumberedTranslations(input, 2);
  assert.deepStrictEqual(result, ['Hello', 'World']);
});

test('parseNumberedTranslations: empty input throws', () => {
  assert.throws(
    () => parseNumberedTranslations('', 3),
    /Missing translation numbers/
  );
});

test('parseNumberedTranslations: single item works', () => {
  const input = '1. Just one';
  const result = parseNumberedTranslations(input, 1);
  assert.deepStrictEqual(result, ['Just one']);
});