const test = require('node:test');
const assert = require('node:assert/strict');
const {
  abortableSleep,
  createAbortError,
  isAbortError,
  throwIfAborted
} = require('../app/services/cancellation');

test('throwIfAborted throws a normalized abort error', () => {
  const controller = new AbortController();
  controller.abort();

  assert.throws(
    () => throwIfAborted(controller.signal),
    (err) => isAbortError(err)
  );
});

test('abortableSleep rejects promptly when signal aborts', async () => {
  const controller = new AbortController();
  const sleepPromise = abortableSleep(60_000, controller.signal);

  controller.abort();

  await assert.rejects(sleepPromise, (err) => isAbortError(err));
});

test('isAbortError recognizes local and axios-style cancellation', () => {
  assert.equal(isAbortError(createAbortError()), true);
  assert.equal(isAbortError({ code: 'ERR_CANCELED', message: 'canceled' }), true);
  assert.equal(isAbortError(new Error('ordinary failure')), false);
});
