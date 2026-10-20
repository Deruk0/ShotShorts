const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createLoginLauncher, createProfileProbe } = require('../app/services/tiktok-login-browser');

test('profile probe matches browser handoff processes by exact directory, including quoted paths', async () => {
  for (const line of [
    'msedge.exe --user-data-dir="C:\\Profiles\\Second account" --new-window',
    'chrome.exe "--user-data-dir=C:\\Profiles\\Second account" --new-window',
    'msedge.exe --user-data-dir=C:\\Profiles\\Default --new-window'
  ]) {
    const profile = line.includes('Second') ? 'c:\\profiles\\second account' : 'c:\\profiles\\default';
    const probe = createProfileProbe({ run: async (_exe, _args, options) => {
      assert.equal(options.windowsHide, true);
      return { stdout: JSON.stringify(line) };
    }});
    assert.equal(await probe(profile, 'msedge'), true);
    assert.equal(await probe(profile + '-another', 'msedge'), false);
  }
  assert.equal(await createProfileProbe({ run: async () => ({ stdout: '' }) })('C:\\Profiles\\Default', 'chrome'), false);
});

test('unavailable browser process state fails closed instead of reopening the profile', async () => {
  for (const run of [async () => { throw new Error('denied'); }, async () => ({ stdout: 'broken JSON' })]) {
    await assert.rejects(createProfileProbe({ run })('C:\\Profiles\\Default', 'chrome'), /studio_browser_state_unavailable/);
  }
});

test('manual login starts installed Chrome or Edge without an automation connection', async () => {
  for (const browser of ['chrome', 'msedge']) {
    let call;
    const child = new EventEmitter();
    child.unref = () => {};
    const launch = createLoginLauncher({
      env: { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' },
      access: async () => {},
      start: (...args) => { call = args; queueMicrotask(() => child.emit('spawn')); return child; }
    });
    const session = await launch('C:\\profiles\\second account', browser);
    assert.equal(path.basename(call[0]), `${browser}.exe`);
    assert.deepEqual(call[1], [
      '--user-data-dir=C:\\profiles\\second account', '--no-first-run', '--no-default-browser-check',
      '--disable-background-mode', '--new-window', 'https://www.tiktok.com/tiktokstudio/upload'
    ]);
    assert.equal(call[2].shell, false);
    assert.equal(call[2].windowsHide, false);
    assert.equal(session.isRunning(), true);
    child.emit('exit', 0);
    assert.equal(session.isRunning(), false);
  }
});

test('missing installations and process start failures report the selected browser', async () => {
  const missing = createLoginLauncher({ env: {}, start: () => assert.fail('must not start') });
  await assert.rejects(missing('profile', 'chrome'), /studio_chrome_unavailable/);
  await assert.rejects(missing('profile', 'msedge'), /studio_edge_unavailable/);
  await assert.rejects(missing('profile', 'firefox'), /studio_browser_invalid/);
  const launch = createLoginLauncher({
    env: { PROGRAMFILES: 'C:\\Programs' }, access: async () => {},
    start: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    }
  });
  await assert.rejects(launch('profile', 'chrome'), /studio_chrome_unavailable/);
});
