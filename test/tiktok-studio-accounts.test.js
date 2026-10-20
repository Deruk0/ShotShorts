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
  const channels = [];
  const loginLaunches = [];
  const loginChannels = [];
  const loginSessions = new Map();
  const externalProfiles = new Set();
  const profileOpen = async profile => externalProfiles.has(profile);
  const loginLaunch = async (profile, browser) => {
    loginLaunches.push(profile); loginChannels.push(browser);
    if (!sessions.has(profile)) sessions.set(profile, { username: '', closed: true });
    assert.equal(sessions.get(profile).closed, true, 'Automation must release the profile before manual login');
    const session = { running: true }; loginSessions.set(profile, session);
    return { isRunning: () => session.running };
  };
  const finishLogin = (profile) => { loginSessions.get(profile).running = false; };
  const launch = async (profile, options) => {
    launches.push(profile);
    channels.push(options.channel);
    const session = { username: sessions.get(profile)?.username || '', closed: false, pages: [] };
    sessions.set(profile, session);
    const newPage = () => {
      let closed = false;
      let url = 'about:blank';
      const page = {
        setDefaultTimeout() {}, async goto(value) { url = value; }, url: () => url,
        async bringToFront() {}, isClosed: () => closed,
        async close() { closed = true; },
        async waitForFunction() {
          const username = session.username.trim().replace(/^@/, '');
          if (!/^[a-zA-Z0-9_.]{2,64}$/.test(username)) throw new Error('identity unavailable');
          return { async jsonValue() { return username; }, async dispose() {} };
        }
      };
      session.pages.push(page);
      return page;
    };
    newPage(); // Persistent browser contexts start with a blank tab.
    let onClose;
    return { on(_event, callback) { onClose = callback; }, async newPage() { return newPage(); },
      pages: () => session.pages.filter(page => !page.isClosed()),
      async close() { session.closed = true; await Promise.all(session.pages.map(page => page.close())); onClose(); } };
  };
  const profilePath = path.join(directory, 'tiktok-studio-profile');
  const driver = createStudioDriver({ profilePath, launch, loginLaunch, profileOpen });
  t.after(async () => { await driver.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, profilePath, driver, sessions, launches, channels, launch, loginLaunch, loginLaunches, loginChannels, finishLogin, profileOpen, externalProfiles };
}

test('browser choice isolates pending sign-ins and persists Chrome across restart', async (t) => {
  const { driver, profilePath, launches, loginLaunches, loginChannels, launch, loginLaunch, profileOpen, directory } = await fixture(t);
  await driver.open();
  const added = await driver.addAccount('chrome');
  const chrome = added.find(entry => entry.browser === 'chrome');
  assert.ok(chrome);
  const chromeProfile = path.join(directory, 'tiktok-studio-accounts', chrome.id);
  assert.deepEqual(loginLaunches, [profilePath, chromeProfile]);
  assert.deepEqual(launches, []);
  assert.deepEqual(loginChannels, ['msedge', 'chrome']);
  await driver.addAccount('chrome');
  assert.equal(loginLaunches.length, 2);
  await driver.close();
  const restarted = createStudioDriver({ profilePath, launch, loginLaunch, profileOpen });
  try {
    await restarted.open(chrome.id);
    assert.equal(loginChannels.at(-1), 'chrome');
    assert.equal(loginLaunches.at(-1), chromeProfile);
    assert.equal((await restarted.accounts()).length, 2);
  } finally { await restarted.close(); }
});

test('unsupported browsers cannot launch or modify the account registry', async (t) => {
  const { driver, launches } = await fixture(t);
  await assert.rejects(driver.addAccount('firefox'), /studio_browser_invalid/);
  assert.deepEqual(await driver.accounts(), [{ id: 'default', username: '' }]);
  assert.equal(launches.length, 0);
});

test('manual login blocks automated reads and upload until the browser closes', async (t) => {
  const { driver, launches, profilePath, sessions, finishLogin, loginLaunches } = await fixture(t);
  await driver.open();
  await driver.open();
  assert.equal(loginLaunches.length, 1);
  await assert.rejects(driver.refreshAccounts(), /studio_login_window_open/);
  await assert.rejects(driver.upload({ account: '' }, new AbortController().signal), /studio_login_window_open/);
  assert.equal(launches.length, 0);
  sessions.get(profilePath).username = 'manual_account';
  finishLogin(profilePath);
  assert.equal((await driver.refreshAccounts())[0].username, 'manual_account');
  assert.deepEqual(launches, [profilePath]);
  await driver.open();
  assert.equal(loginLaunches.length, 2);
  await assert.rejects(driver.refreshAccounts(), /studio_login_window_open/);
});

test('browser handoff cannot reopen a profile after its launcher exits or the app restarts', async (t) => {
  const { driver, profilePath, sessions, finishLogin, externalProfiles, launch, loginLaunch, profileOpen, launches, loginLaunches } = await fixture(t);
  await driver.open();
  finishLogin(profilePath); // The original launcher exits, but the real browser stays open.
  externalProfiles.add(profilePath);
  sessions.get(profilePath).username = 'handoff_account';
  await driver.open();
  await assert.rejects(driver.refreshAccounts(), /studio_login_window_open/);
  assert.equal(loginLaunches.length, 1);
  assert.equal(launches.length, 0);
  await driver.close();
  const restarted = createStudioDriver({ profilePath, launch, loginLaunch, profileOpen });
  try {
    await assert.rejects(restarted.refreshAccounts(), /studio_login_window_open/);
    assert.equal(launches.length, 0);
    externalProfiles.delete(profilePath); // The user closes the actual browser window.
    assert.equal((await restarted.refreshAccounts())[0].username, 'handoff_account');
    assert.equal(launches.length, 1);
  } finally { await restarted.close(); }
});

test('missing Chrome reports a browser-specific launch error', async (t) => {
  const { profilePath } = await fixture(t);
  const driver = createStudioDriver({ profilePath, profileOpen: async () => false, loginLaunch: async () => { throw new Error('studio_chrome_unavailable'); } });
  try { await assert.rejects(driver.addAccount('chrome'), /studio_chrome_unavailable/); }
  finally { await driver.close(); }
});

test('detects the existing account and preserves its original browser profile', async (t) => {
  const { driver, sessions, profilePath, launches, finishLogin } = await fixture(t);
  assert.deepEqual(await driver.accounts(), [{ id: 'default', username: '' }]);
  await driver.open();
  sessions.get(profilePath).username = '@existing_account'; finishLogin(profilePath);
  assert.deepEqual(await driver.refreshAccounts(), [{ id: 'default', username: 'existing_account' }]);
  assert.deepEqual(launches, [profilePath]);
});

test('additional accounts use isolated profiles and route correctly after restart', async (t) => {
  const { driver, profilePath, sessions, launches, launch, loginLaunch, profileOpen, loginLaunches, finishLogin } = await fixture(t);
  await driver.open(); sessions.get(profilePath).username = 'first_account'; finishLogin(profilePath);
  await driver.refreshAccounts();
  const added = await driver.addAccount();
  const second = added.find(entry => entry.id !== 'default');
  const secondProfile = path.join(path.dirname(profilePath), 'tiktok-studio-accounts', second.id);
  assert.equal(loginLaunches[1], secondProfile);
  await driver.addAccount();
  assert.equal((await driver.accounts()).length, 2);
  sessions.get(secondProfile).username = 'second_account'; finishLogin(secondProfile);
  await driver.refreshAccounts();
  await driver.close();
  const restarted = createStudioDriver({ profilePath, launch, loginLaunch, profileOpen });
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
  assert.equal(sessions.get(profilePath).closed, true);
  assert.equal(sessions.get(profilePath).pages.length, 1);
  assert.ok(sessions.get(profilePath).pages.every(page => page.isClosed()));
  sessions.get(profilePath).username = 'not a username';
  await assert.rejects(driver.refreshAccounts(), /studio_account_unavailable/);
  assert.equal((await driver.accounts())[0].username, '');
});

test('repeated account refresh leaves no browser windows or spare upload tabs', async (t) => {
  const { driver, profilePath, sessions, launches, finishLogin } = await fixture(t);
  await driver.open(); sessions.get(profilePath).username = 'saved_account'; finishLogin(profilePath);
  for (let i = 0; i < 3; i++) {
    assert.equal((await driver.refreshAccounts())[0].username, 'saved_account');
    const session = sessions.get(profilePath);
    assert.equal(session.closed, true);
    assert.equal(session.pages.length, 1);
    assert.ok(session.pages.every(page => page.isClosed()));
  }
  assert.equal(launches.length, 3);
});

test('account refresh preserves an existing upload window and closes only its probe', async (t) => {
  const { driver, profilePath, sessions } = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(driver.upload({ account: '' }, controller.signal), /studio_interrupted_check_status/);
  const session = sessions.get(profilePath);
  session.username = 'saved_account';
  const uploadPage = session.pages[0];
  await driver.refreshAccounts();
  assert.equal(session.closed, false);
  assert.equal(uploadPage.isClosed(), false);
  assert.equal(session.pages.length, 2);
  assert.equal(session.pages[1].isClosed(), true);
});

test('an unfinished original sign-in is reused instead of creating another profile', async (t) => {
  const { driver, loginLaunches, profilePath } = await fixture(t);
  await driver.open();
  await driver.addAccount(); await driver.addAccount();
  assert.deepEqual(await driver.accounts(), [{ id: 'default', username: '' }]);
  assert.deepEqual(loginLaunches, [profilePath]);
});

test('refresh reopens saved sessions and deduplicates the same account without deleting profiles', async (t) => {
  const { driver, profilePath, sessions, directory, launch, loginLaunch, profileOpen, finishLogin, launches } = await fixture(t);
  await driver.open(); sessions.get(profilePath).username = 'one_account'; finishLogin(profilePath);
  await driver.refreshAccounts();
  const added = await driver.addAccount();
  const second = added.find(entry => entry.id !== 'default');
  sessions.get(path.join(directory, 'tiktok-studio-accounts', second.id)).username = 'one_account';
  finishLogin(path.join(directory, 'tiktok-studio-accounts', second.id));
  await driver.close();
  const restarted = createStudioDriver({ profilePath, launch, loginLaunch, profileOpen });
  try {
    const refreshed = await restarted.refreshAccounts();
    assert.deepEqual(refreshed, [{ id: 'default', username: 'one_account' }]);
    const stored = JSON.parse(await fs.readFile(path.join(directory, 'tiktok-studio-accounts.json'), 'utf8'));
    assert.equal(stored.length, 2);
    assert.equal(stored[1].username, 'one_account');
    const before = launches.length;
    await restarted.refreshAccounts();
    assert.equal(launches.length, before + 1, 'Hidden duplicate profiles are not opened again');
  } finally { await restarted.close(); }
});

test('refresh recovers after the browser is closed within the same app run', async (t) => {
  const { driver, profilePath, sessions, launches, finishLogin } = await fixture(t);
  await driver.open(); sessions.get(profilePath).username = 'saved_account'; finishLogin(profilePath);
  await driver.refreshAccounts();
  await driver.close();
  assert.equal((await driver.refreshAccounts())[0].username, 'saved_account');
  assert.equal(launches.length, 2);
});
