const test = require('node:test');
const assert = require('node:assert/strict');
const {
  abortableSleep,
  createAbortError,
  isAbortError,
  runFfmpegCommand,
  throwIfAborted
} = require('../app/services/cancellation');
const { EventEmitter } = require('node:events');

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

test('cancellation kills FFmpeg when it spawns after the abort', async () => {
  const controller = new AbortController();
  const cmd = new EventEmitter();
  let spawned = false;
  let killed = false;
  cmd.kill = () => { if (spawned) killed = true; };
  cmd.run = () => {};
  const result = runFfmpegCommand(cmd, { signal: controller.signal });
  controller.abort();
  spawned = true;
  cmd.emit('start');
  assert.equal(killed, true);
  const rejection = assert.rejects(result, isAbortError);
  cmd.emit('error', new Error('killed'));
  await rejection;
});

test('cancellation waits for FFmpeg to close its files before rejecting', async () => {
  const controller = new AbortController();
  const cmd = new EventEmitter();
  cmd.run = () => cmd.emit('start');
  cmd.kill = () => {};
  let settled = false;
  const result = runFfmpegCommand(cmd, { signal: controller.signal });
  const rejection = assert.rejects(result, isAbortError).then(() => { settled = true; });
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  cmd.emit('error', new Error('killed'));
  await rejection;
});

test('cancellation during command setup prevents FFmpeg from running', async () => {
  const controller = new AbortController();
  const cmd = new EventEmitter();
  let ran = false;
  cmd.kill = () => {};
  cmd.run = () => { ran = true; };
  await assert.rejects(runFfmpegCommand(cmd, {
    signal: controller.signal, onStart: () => controller.abort()
  }), isAbortError);
  assert.equal(ran, false);
});
