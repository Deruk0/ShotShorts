const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeGroqApiKeys,
  pickAvailableGroqKey,
  setGroqKeyCooldown
} = require('../app/services/groq-key-utils');

test('normalizeGroqApiKeys trims, drops empty values and deduplicates', () => {
  assert.deepEqual(
    normalizeGroqApiKeys([' key-a ', '', null, 'key-b', 'key-a'], ' key-c '),
    ['key-a', 'key-b', 'key-c']
  );
});

test('pickAvailableGroqKey rotates through available keys', () => {
  const cursor = { current: 0 };
  const cooldowns = new Map();

  assert.deepEqual(pickAvailableGroqKey(['a', 'b'], cooldowns, cursor), {
    apiKey: 'a',
    index: 0,
    waitMs: 0,
    total: 2
  });
  assert.equal(cursor.current, 1);

  assert.deepEqual(pickAvailableGroqKey(['a', 'b'], cooldowns, cursor), {
    apiKey: 'b',
    index: 1,
    waitMs: 0,
    total: 2
  });
  assert.equal(cursor.current, 0);
});

test('pickAvailableGroqKey skips cooled down keys and reports all-key wait', () => {
  const cooldowns = new Map();
  const cursor = { current: 0 };

  setGroqKeyCooldown(cooldowns, 'a', 60_000);
  assert.equal(pickAvailableGroqKey(['a', 'b'], cooldowns, cursor).apiKey, 'b');

  setGroqKeyCooldown(cooldowns, 'b', 30_000);
  const selected = pickAvailableGroqKey(['a', 'b'], cooldowns, cursor);
  assert.equal(selected.apiKey, null);
  assert.equal(selected.index, -1);
  assert.equal(selected.total, 2);
  assert.ok(selected.waitMs > 0);
});
