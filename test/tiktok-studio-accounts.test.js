const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStudioDriver } = require('../app/services/tiktok-studio');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shotshorts-accounts-'));
  const sessions = new Map();
  const launches = [];
  const launch = async (profile) => {
    launches.push(profile);
    const session = { username: sessions.get(profile)?.username || '', closed: false };
    sessions.set(profile, session);
    const newPage = () => {
      let closed = false;
      return {
        setDefaultTimeout() {}, async goto() {}, async bringToFront() {}, isClosed: () => closed,
        async close() { closed = true; },
        async waitForFunction() {
          const username = session.username.trim().replace(/^@/, '');
          if (!/^[a-zA-Z0-9_.]{2,64}$/.test(username)) throw new Error('identity unavailable');
          return { async jsonValue() { return username; }, async dispose() {} };
        }
      };
    };
    let onClose;
    return { on(_event, callback) { onClose = callback; }, async newPage() { return newPage(); },
      async close() { session.closed = true; onClose(); } };
  };
  const profilePath = path.join(directory, 'tiktok-studio-profile');
  const driver = createStudioDriver({ profilePath, launch });
  t.after(async () => { await driver.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, profilePath, driver, sessions, launches, launch };
}

test('detects the existing account and preserves its original browser profile', async (t) => {
  const { driver, sessions, profilePath, launches } = await fixture(t);
  assert.deepEqual(await driver.accounts(), [{ id: 'default', username: '' }]);
  await driver.open();
  sessions.get(profilePath).username = '@existing_account';
  assert.deepEqual(await driver.refreshAccounts(), [{ id: 'default', username: 'existing_account' }]);
  assert.deepEqual(launches, [profilePath]);
});

test('additional accounts use isolated profiles and route correctly after restart', async (t) => {
  const { driver, profilePath, sessions, launches, launch } = await fixture(t);
  await driver.open(); sessions.get(profilePath).username = 'first_account';
  await driver.refreshAccounts();
  const added = await driver.addAccount();
  const second = added.find(entry => entry.id !== 'default');
  const secondProfile = path.join(path.dirname(profilePath), 'tiktok-studio-accounts', second.id);
  assert.equal(launches[1], secondProfile);
  await driver.addAccount();
  assert.equal((await driver.accounts()).length, 2);
  sessions.get(secondProfile).username = 'second_account';
  await driver.refreshAccounts();
  await driver.close();
  const restarted = createStudioDriver({ profilePath, launch });
  try {
    assert.deepEqual((await restarted.accounts()).map(entry => entry.username), ['first_account', 'second_account']);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(restarted.upload({ account: 'second_account' }, controller.signal), /studio_interrupted_check_status/);
    assert.equal(launches.at(-1), secondProfile);
    const before = launches.length;
    await assert.rejects(restarted.upload({ account: 'unknown_account' }, controller.signal), /studio_account_unavailable/);
    assert.equal(launches.length, before);
  } finally { await restarted.close(); }
});

test('an unreadable account or incomplete sign-in never becomes a detected account', async (t) => {
  const { driver, profilePath, sessions } = await fixture(t);
  await assert.rejects(driver.refreshAccounts(), /studio_account_unavailable/);
  sessions.get(profilePath).username = 'not a username';
  await assert.rejects(driver.refreshAccounts(), /studio_account_unavailable/);
  assert.equal((await driver.accounts())[0].username, '');
});

test('an unfinished original sign-in is reused instead of creating another profile', async (t) => {
  const { driver, launches, profilePath } = await fixture(t);
  await driver.open();
  await driver.addAccount(); await driver.addAccount();
  assert.deepEqual(await driver.accounts(), [{ id: 'default', username: '' }]);
  assert.deepEqual(launches, [profilePath]);
});

test('refresh reopens saved sessions and deduplicates the same account without deleting profiles', async (t) => {
  const { driver, profilePath, sessions, directory, launch } = await fixture(t);
  await driver.open(); sessions.get(profilePath).username = 'one_account';
  await driver.refreshAccounts();
  const added = await driver.addAccount();
  const second = added.find(entry => entry.id !== 'default');
  sessions.get(path.join(directory, 'tiktok-studio-accounts', second.id)).username = 'one_account';
  await driver.close();
  const restarted = createStudioDriver({ profilePath, launch });
  try {
    const refreshed = await restarted.refreshAccounts();
    assert.deepEqual(refreshed, [{ id: 'default', username: 'one_account' }]);
    const stored = JSON.parse(await fs.readFile(path.join(directory, 'tiktok-studio-accounts.json'), 'utf8'));
    assert.equal(stored.length, 2);
    assert.equal(stored[1].username, 'one_account');
  } finally { await restarted.close(); }
});

test('refresh recovers after the browser is closed within the same app run', async (t) => {
  const { driver, profilePath, sessions, launches } = await fixture(t);
  await driver.open(); sessions.get(profilePath).username = 'saved_account';
  await driver.close();
  assert.equal((await driver.refreshAccounts())[0].username, 'saved_account');
  assert.equal(launches.length, 2);
});
