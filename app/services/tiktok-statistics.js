const fs = require('node:fs/promises');
const path = require('node:path');
const PERIODS = [7, 28, 60, 365];

function parseMetric(value) {
  const text = String(value).toLowerCase().replace(/[\s\u00a0\u202f]/g, '');
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(text)) return parseMetric(text.replace(/[.,]/g, ''));
  if (/^\d+$/.test(text)) return Number.isSafeInteger(Number(text)) ? Number(text) : null;
  const match = text.match(/^(\d+(?:[.,]\d+)?)(k|m|b|тыс\.?|млн\.?|млрд\.?)$/);
  if (!match) return null;
  const multiplier = /^(k|тыс)/.test(match[2]) ? 1000 : /^(m|млн)/.test(match[2]) ? 1000000 : 1000000000;
  const result = Math.round(Number(match[1].replace(',', '.')) * multiplier);
  return Number.isSafeInteger(result) ? result : null;
}

function parseStudioDate(text, scheduled, now = new Date()) {
  const months = ['янв|jan', 'фев|feb', 'мар|mar', 'апр|apr', 'май|мая|may', 'июн|jun', 'июл|jul', 'авг|aug', 'сен|sep', 'окт|oct', 'ноя|nov', 'дек|dec'];
  const normalized = String(text).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const match = normalized.match(/^(?:(\d{1,2})\s+([а-яa-z]+)|([a-z]+)\s+(\d{1,2}))(?:,?\s+(\d{4}))?,?\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
  if (!match) return null;
  const day = Number(match[1] || match[4]);
  const month = months.findIndex(pattern => new RegExp(`^(?:${pattern})`).test(match[2] || match[3]));
  let hour = Number(match[6]);
  if (match[8]) { if (hour < 1 || hour > 12) return null; hour = hour % 12 + (match[8] === 'pm' ? 12 : 0); }
  const minute = Number(match[7]);
  if (month < 0 || hour > 23 || minute > 59) return null;
  const year = Number(match[5] || now.getFullYear());
  const years = match[5] ? [year] : [year - 1, year, year + 1];
  const dates = years.map(y => new Date(y, month, day, hour, minute)).filter(date => date.getMonth() === month && date.getDate() === day);
  const candidates = scheduled ? dates : dates.filter(date => date.getTime() <= now.getTime() + 300000);
  candidates.sort((a, b) => scheduled ? Math.abs(a - now) - Math.abs(b - now) : b - a);
  return candidates[0]?.toISOString() || null;
}

// Runs in Studio. Only date badges are read; captions and per-video metrics are excluded.
function inspectTimeline({ advance = false, reset = false } = {}) {
  const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  const badges = [...document.querySelectorAll('[data-tt="components_PublishStageLabel_TUXText"]')].filter(visible);
  if (!badges.length && !/Нет публикаций|Нет видео|No posts|No videos/i.test(document.body.innerText)) return false;
  const dates = badges.map(element => ({ text: element.innerText.trim(), scheduled: !!element.parentElement.querySelector('[data-icon="Alarm"], [data-testid="Alarm"]') }));
  let scroller = badges[0]?.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  scroller ||= document.scrollingElement;
  const bottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  const position = `${scroller.scrollTop}:${scroller.scrollHeight}`;
  if (reset) scroller.scrollTop = 0;
  else if (advance) scroller.scrollTop += Math.max(100, scroller.clientHeight * 0.75);
  return { dates, bottom, position };
}

function inspectAnalytics(days) {
  const period = [...document.querySelectorAll('button')].some(button => new RegExp(`^(?:Последние ${days} дн\\.|Last ${days} days)$`, 'i').test(button.innerText.trim()));
  if (!period) return false;
  const cards = [...document.querySelectorAll('button[data-tt="OverviewPage_AccountMetricsCard_Clickable"]')];
  const names = { views: /^(Просмотры видео|Просмотры публикаций|Video views|Post views)$/i, likes: /^(Лайки|Likes)$/i, comments: /^(Комментарии|Comments)$/i };
  const metrics = {};
  for (const [key, name] of Object.entries(names)) {
    const matches = cards.filter(card => [...card.querySelectorAll('*')].some(element => name.test(element.textContent.trim())));
    if (matches.length !== 1) return false;
    const value = matches[0].querySelector('.absolute-value')?.textContent.trim();
    if (!value) return false;
    metrics[key] = value;
  }
  return metrics;
}

async function waitValue(page, fn, arg, timeout) {
  const handle = await page.waitForFunction(fn, arg, { timeout, polling: 250 });
  try { return await handle.jsonValue(); } finally { await handle.dispose(); }
}

async function readStudioStatistics(page, account, { days = 7, timeoutMs = 30000, timelineTimeoutMs = 120000, now = new Date() } = {}) {
  if (!PERIODS.includes(days)) throw new Error('invalid_statistics_period');
  try {
    await waitValue(page, inspectTimeline, {}, timeoutMs);
    await page.evaluate(inspectTimeline, { reset: true });
    let lastPublishedAt = null, lastScheduledAt = null, stableBottom = 0, previousPosition, complete = false;
    const deadline = Date.now() + timelineTimeoutMs;
    while (Date.now() < deadline) {
      const state = await page.evaluate(inspectTimeline, {});
      if (!state) { await page.waitForTimeout(400); continue; }
      for (const badge of state.dates) {
        const date = parseStudioDate(badge.text, badge.scheduled, now);
        if (!date) throw new Error('studio_statistics_unavailable');
        if (badge.scheduled) { if (!lastScheduledAt || date > lastScheduledAt) lastScheduledAt = date; }
        else if (!lastPublishedAt || date > lastPublishedAt) lastPublishedAt = date;
      }
      stableBottom = state.bottom && state.position === previousPosition ? stableBottom + 1 : 0;
      if (stableBottom >= 3) { complete = true; break; }
      previousPosition = state.position;
      await page.evaluate(inspectTimeline, { advance: true });
      await page.waitForTimeout(state.bottom ? 1000 : 400);
    }
    if (!complete) throw new Error('studio_statistics_unavailable');
    await page.goto('https://www.tiktok.com/tiktokstudio/analytics', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const period = page.getByRole('button', { name: /^(Последние (7|28|60|365) дн\.|Last (7|28|60|365) days)$/i });
    await period.waitFor({ timeout: timeoutMs });
    const selected = (await period.innerText()).match(/\d+/)?.[0];
    if (Number(selected) !== days) {
      // Studio removes metric cards while the new range loads. Waiting for this
      // transition prevents saving the old range under the newly selected label.
      await page.locator('.absolute-value').first().waitFor({ timeout: timeoutMs });
      const oldValue = await page.locator('.absolute-value').first().elementHandle();
      try {
        await period.click();
        await page.getByText(new RegExp(`^(Последние ${days} дн\\.|Last ${days} days)$`, 'i')).filter({ visible: true }).last().click();
        await page.waitForFunction(element => !element.isConnected, oldValue, { timeout: timeoutMs });
      } finally { await oldValue?.dispose(); }
    }
    const raw = await waitValue(page, inspectAnalytics, days, timeoutMs);
    const metrics = {};
    for (const key of ['views', 'likes', 'comments']) {
      metrics[key] = parseMetric(raw[key]);
      if (metrics[key] === null && !/^[—–-]+$/.test(raw[key])) throw new Error('studio_statistics_unavailable');
    }
    return { account, days, updatedAt: new Date().toISOString(), scope: 'account_summary', lastPublishedAt, lastScheduledAt, metrics };
  } catch (error) {
    if (error.message === 'invalid_statistics_period') throw error;
    throw new Error('studio_statistics_unavailable');
  }
}

async function writeStatisticsDiagnostic(page, account, stage, error, file) {
  if (!file) return;
  try {
    const url = new URL(page?.url() || 'about:blank');
    const layout = await page?.evaluate(() => ({ dateBadges: document.querySelectorAll('[data-tt="components_PublishStageLabel_TUXText"]').length,
      metricCards: document.querySelectorAll('button[data-tt="OverviewPage_AccountMetricsCard_Clickable"]').length }), { diagnostic: true }).catch(() => null);
    const report = { recordedAt: new Date().toISOString(), account, stage,
      error: /^[a-z_]{1,100}$/.test(error.message) ? error.message : 'studio_statistics_unavailable', page: url.origin + url.pathname, layout };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  } catch { /* Diagnostic failures must not replace the original error. */ }
}

function createStatisticsStore(file, read) {
  let serial = Promise.resolve();
  const get = async () => {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (![1, 2].includes(data.version) || !Array.isArray(data.accounts)) throw new Error();
      // Legacy per-video snapshots cannot represent period analytics. Keep the
      // file intact until a successful refresh writes a real account summary.
      if (data.version === 1) return { version: 2, accounts: [] };
      if (data.accounts.some(entry => !entry || !/^[a-zA-Z0-9_.]{2,64}$/.test(entry.account) ||
        !Number.isFinite(Date.parse(entry.updatedAt)) || entry.scope !== 'account_summary' || !PERIODS.includes(entry.days) ||
        ['lastPublishedAt', 'lastScheduledAt'].some(key => entry[key] !== null && !Number.isFinite(Date.parse(entry[key]))) ||
        !entry.metrics || ['views', 'likes', 'comments'].some(key => entry.metrics[key] !== null && (!Number.isSafeInteger(entry.metrics[key]) || entry.metrics[key] < 0)))) throw new Error();
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 2, accounts: [] };
      throw new Error('statistics_storage_error');
    }
  };
  return { get, refresh(input) {
    const operation = serial.then(async () => {
      const { id, days = 7 } = typeof input === 'string' ? { id: input } : input || {};
      if (typeof id !== 'string' || !PERIODS.includes(days)) throw new Error('invalid_statistics_period');
      const snapshot = await read(id, days);
      const data = await get();
      data.accounts = data.accounts.filter(entry => entry.account !== snapshot.account || entry.days !== snapshot.days);
      data.accounts.push(snapshot);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
      return data;
    });
    serial = operation.catch(() => {});
    return operation;
  } };
}

module.exports = { PERIODS, parseMetric, parseStudioDate, inspectTimeline, inspectAnalytics, readStudioStatistics, createStatisticsStore, writeStatisticsDiagnostic };
