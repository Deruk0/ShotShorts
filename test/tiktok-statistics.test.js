const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseMetric, parseStudioDate, createStatisticsStore, writeStatisticsDiagnostic } = require('../app/services/tiktok-statistics');
const { createStudioDriver } = require('../app/services/tiktok-studio');

test('statistics counts parse localized abbreviations without inventing zeroes', () => {
  for (const [text, value] of [['0', 0], ['1,234', 1234], ['1.234', 1234], ['1 234', 1234], ['1\u202f234', 1234], ['1.2K', 1200], ['2,5 тыс.', 2500], ['3 млн', 3000000]]) assert.equal(parseMetric(text), value);
  for (const text of ['—', 'loading', '-1', 'Infinity', '9007199254740993']) assert.equal(parseMetric(text), null);
});

test('statistics persist by account and failed refresh preserves the previous snapshot', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shotshorts-statistics-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let fail = false;
  const read = async (account, days) => {
    if (fail) throw new Error('studio_statistics_unavailable');
    return { account, days, updatedAt: '2026-10-20T12:00:00Z', scope: 'account_summary', lastPublishedAt: null, lastScheduledAt: null, metrics: { views: 5, likes: 2, comments: null } };
  };
  const file = path.join(dir, 'statistics.json');
  const store = createStatisticsStore(file, read);
  assert.deepEqual((await store.get()).accounts, []);
  await store.refresh('creator'); await store.refresh('second'); await store.refresh({ id: 'creator', days: 60 });
  const before = await store.get();
  assert.equal(before.accounts.length, 3);
  assert.deepEqual(before.accounts.filter(a => a.account === 'creator').map(a => a.days), [7, 60]);
  await assert.rejects(store.refresh({ id: 'creator', days: 8 }), /invalid_statistics_period/);
  fail = true; await assert.rejects(store.refresh('creator'), /studio_statistics_unavailable/);
  assert.deepEqual(await createStatisticsStore(file, read).get(), before);
});

test('statistics failure report contains stage and layout without URL query data', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shotshorts-statistics-diagnostic-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'diagnostic.json');
  const page = { url: () => 'https://www.tiktok.com/tiktokstudio/content?private=hidden',
    evaluate: async (_fn, options) => { assert.equal(options.diagnostic, true); return { headers: [1, 1, 1], aligned: 1, rows: 0 }; } };
  await writeStatisticsDiagnostic(page, 'creator', 'counters', new Error('studio_statistics_unavailable'), file);
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(report.stage, 'counters');
  assert.equal(report.page, 'https://www.tiktok.com/tiktokstudio/content');
  assert.equal(report.layout.rows, 0);
  assert.equal(JSON.stringify(report).includes('hidden'), false);
});

test('statistics wait for the active upload and close only their own tab', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shotshorts-statistics-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'tiktok-studio-accounts.json'), JSON.stringify([{ id: 'default', username: 'creator' }]));
  let release, begun;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { begun = resolve; });
  const pages = [];
  const driver = createStudioDriver({ profileOpen: async () => false, profilePath: path.join(dir, 'profile'), launch: async () => ({
    on() {}, close: async () => {}, newPage: async () => {
      const page = { closed: false, setDefaultTimeout() {}, bringToFront: async () => {}, isClosed: () => false,
        goto: async url => { page.url = url; if (pages.length === 1) { begun(); await gate; } },
        close: async () => { page.closed = true; },
        evaluate: async () => ({ dates: [], bottom: true, position: '0:0' }), waitForTimeout: async () => {},
        getByRole: () => ({ waitFor: async () => {}, innerText: async () => 'Последние 7 дн.' }),
        waitForFunction: async fn => ({ jsonValue: async () => fn.name === 'inspectAnalytics' ? { views: '10', likes: '2', comments: '1' } : fn.name === 'inspectTimeline' ? { dates: [], bottom: true, position: '0:0' } : 'creator', dispose: async () => {} }) };
      pages.push(page); return page;
    }
  }) });
  t.after(() => driver.close());
  const upload = assert.rejects(driver.upload({ account: 'creator', filePath: path.join(dir, 'missing.mp4') }, new AbortController().signal));
  await started;
  const statistics = driver.statistics('default');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pages.length, 1);
  release(); await upload;
  assert.equal((await statistics).metrics.views, 10);
  assert.equal(pages[0].closed, false);
  assert.equal(pages[1].closed, true);
});


test('Studio dates infer the year across New Year and reject invalid dates', () => {
  const now = new Date(2026, 0, 1, 12);
  assert.equal(parseStudioDate('31 дек, 23:00', false, now), new Date(2025, 11, 31, 23).toISOString());
  assert.equal(parseStudioDate('2 янв, 07:00', true, now), new Date(2026, 0, 2, 7).toISOString());
  assert.equal(parseStudioDate('Jan 2, 2026, 7:00 PM', true, now), new Date(2026, 0, 2, 19).toISOString());
  for (const text of ['31 фев, 12:00', '2 янв, 25:00', 'loading']) assert.equal(parseStudioDate(text, false, now), null);
});

test('old per-video data is not exposed as account analytics and survives a failed refresh', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shotshorts-statistics-legacy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'statistics.json');
  const old = JSON.stringify({ version: 1, accounts: [{ account: 'creator', scope: 'content_page', videos: [] }] });
  await fs.writeFile(file, old);
  const store = createStatisticsStore(file, async () => { throw new Error('studio_statistics_unavailable'); });
  assert.deepEqual(await store.get(), { version: 2, accounts: [] });
  await assert.rejects(store.refresh('creator'));
  assert.equal(await fs.readFile(file, 'utf8'), old);
});
