const axios = require('axios');

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * Translate a batch of German segment texts to English using DeepSeek.
 * Returns an array of translated strings in the same order.
 */
async function translate(germanTexts) {
  const numbered = germanTexts
    .map((text, i) => `${i + 1}. ${text}`)
    .join('\n');

  const prompt = `Translate each numbered German line into natural, idiomatic English.
Return ONLY a numbered list matching the input numbering exactly, one
translation per line, no commentary, no extra formatting.

${numbered}`;

  const response = await axios.post(
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
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const raw = response.data.choices[0].message.content;

  // Parse the response: expect "1. translation\n2. translation\n..."
  // Be forgiving: accept "1.", "1)", "1 )", with or without trailing space
  const lines = raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^\d+[\.\)]\s?/.test(line))
    .map(line => line.replace(/^\d+[\.\)]\s?/, '').trim());

  if (lines.length !== germanTexts.length) {
    throw new Error(
      `Translation count mismatch: sent ${germanTexts.length} segments, got ${lines.length} back`
    );
  }

  return lines;
}

module.exports = { translate };