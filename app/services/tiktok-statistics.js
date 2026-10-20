const fs = require('node:fs/promises');
const path = require('node:path');

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

// Runs in the page. Read only the visible content list; do not call private APIs.
function inspectStatistics(options) {
  const diagnostic = options?.diagnostic === true;
  const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  const text = element => (element.innerText || '').replace(/\s+/g, ' ').trim();
  const elements = [...document.querySelectorAll('body *')].filter(visible);
  const leaves = elements.filter(element => ![...element.children].some(child => visible(child) && text(child) === text(element)));
  const names = [/^(Просмотры|Views)$/i, /^(Лайки|Likes)$/i, /^(Комментарии|Comments)$/i];
  const headers = names.map(name => leaves.filter(element => name.test(text(element))));
  const aligned = headers[0].flatMap(views => headers[1].flatMap(likes => headers[2].map(comments => [views, likes, comments])))
    .filter(group => {
      const boxes = group.map(element => element.getBoundingClientRect());
      return boxes[0].left < boxes[1].left && boxes[1].left < boxes[2].left &&
        Math.max(...boxes.map(box => box.top)) - Math.min(...boxes.map(box => box.top)) < 16;
    }).sort((a, b) => b[0].getBoundingClientRect().top - a[0].getBoundingClientRect().top);
  if (!aligned.length) return diagnostic ? { headers: headers.map(entries => entries.length), aligned: 0, rows: 0 } : false;
  const boxes = aligned[0].map(element => element.getBoundingClientRect());
  const centers = boxes.map(box => box.left + box.width / 2);
  const bounds = aligned[0].map((header, index) => {
    let cell = header.closest('th, [role="columnheader"]');
    if (!cell) {
      cell = header;
      for (let level = 0; cell.parentElement && level < 5; level++, cell = cell.parentElement) {
        const siblings = [...cell.parentElement.children].filter(visible);
        if (siblings.filter(element => names.some(name => name.test(text(element)))).length >= 2) break;
      }
      // No identifiable column container: use midpoints between the headers,
      // never the start of a potentially right-aligned text label.
      if (!cell.parentElement || ![...cell.parentElement.children].filter(visible).some(element =>
        element !== cell && names.some(name => name.test(text(element))))) cell = null;
    }
    const box = cell?.getBoundingClientRect();
    return box ? { left: box.left, right: box.right } : {
      left: index ? (centers[index - 1] + centers[index]) / 2 : centers[0] - (centers[1] - centers[0]) / 2,
      right: index < 2 ? (centers[index] + centers[index + 1]) / 2 : centers[2] + (centers[2] - centers[1]) / 2
    };
  });
  const numbers = leaves.filter(element => /^(?:[\d\s.,\u00a0\u202f]+(?:[kmb]|тыс\.?|млн\.?|млрд\.?)?|[—–-])$/i.test(text(element)));
  const column = (element, index) => {
    const box = element.getBoundingClientRect();
    const center = box.left + box.width / 2;
    return box.top > boxes[0].bottom && center >= bounds[index].left && center < bounds[index].right;
  };
  const views = numbers.filter(element => column(element, 0));
  const rows = [];
  const seen = new Set();
  for (const view of views) {
    let row = view.closest('tr, [role="row"]');
    if (!row) {
      row = view.parentElement;
      while (row && row.tagName !== 'BODY') {
        if (numbers.some(element => row.contains(element) && column(element, 1)) &&
          numbers.some(element => row.contains(element) && column(element, 2))) break;
        row = row.parentElement;
      }
    }
    if (!row || row.tagName === 'BODY' || row.tagName === 'HTML' || seen.has(row)) continue;
    const cells = [0, 1, 2].map(index => numbers.filter(element => row.contains(element) && column(element, index)));
    if (cells.some(entries => entries.length !== 1)) continue;
    const link = [...row.querySelectorAll('a[href]')].find(element => /\/video\/\d+/.test(element.getAttribute('href')));
    const content = leaves.filter(element => row.contains(element) && element.getBoundingClientRect().left < bounds[0].left)
      .map(text).filter(value => value && !/^\d{1,2}:\d{2}$/.test(value) && !/^(Все|Only me|Everyone|Только я|Друзья|Friends)$/.test(value));
    const title = (link && text(link)) || content.find(value => !/^\d/.test(value)) || content[0];
    if (!title) continue;
    let url = null;
    if (link) {
      const candidate = new URL(link.getAttribute('href'), location.href);
      if (candidate.origin === 'https://www.tiktok.com' && /\/video\/\d+/.test(candidate.pathname)) url = candidate.origin + candidate.pathname;
    }
    seen.add(row);
    rows.push({ title: title.slice(0, 2200), url, views: text(cells[0][0]), likes: text(cells[1][0]), comments: text(cells[2][0]) });
  }
  if (diagnostic) return { headers: headers.map(entries => entries.length), aligned: aligned.length,
    columns: bounds.map(box => ({ left: Math.round(box.left), right: Math.round(box.right) })), numericCandidates: numbers.length, rows: rows.length };
  if (rows.length) return { rows };
  if (/Нет публикаций|Нет видео|No posts|No videos/i.test(document.body.innerText)) return { rows: [] };
  return false;
}

async function readStudioStatistics(page, account, { timeoutMs = 30000 } = {}) {
  let result;
  try { result = await page.waitForFunction(inspectStatistics, null, { timeout: timeoutMs, polling: 500 }); }
  catch { throw new Error('studio_statistics_unavailable'); }
  let raw;
  try { raw = await result.jsonValue(); } finally { await result.dispose(); }
  const videos = raw.rows.map(row => ({ ...row, views: parseMetric(row.views), likes: parseMetric(row.likes), comments: parseMetric(row.comments) }));
  if (videos.some(row => [row.views, row.likes, row.comments].some(value => value === null))) throw new Error('studio_statistics_unavailable');
  return { account, updatedAt: new Date().toISOString(), scope: 'content_page', videos };
}

async function writeStatisticsDiagnostic(page, account, stage, error, file) {
  if (!file) return;
  try {
    const url = new URL(page?.url() || 'about:blank');
    const layout = await page?.evaluate(inspectStatistics, { diagnostic: true }).catch(() => null);
    const report = { recordedAt: new Date().toISOString(), account, stage,
      error: /^[a-z_]{1,100}$/.test(error.message) ? error.message : 'studio_statistics_unavailable',
      page: url.origin + url.pathname, layout };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  } catch { /* Diagnostic failures must not replace the original error. */ }
}

function createStatisticsStore(file, read) {
  let serial = Promise.resolve();
  const get = async () => {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error();
      if (data.accounts.some(entry => !entry || !/^[a-zA-Z0-9_.]{2,64}$/.test(entry.account) ||
        !Number.isFinite(Date.parse(entry.updatedAt)) || entry.scope !== 'content_page' || !Array.isArray(entry.videos) ||
        entry.videos.some(video => !video || typeof video.title !== 'string' ||
          ['views', 'likes', 'comments'].some(key => !Number.isSafeInteger(video[key]) || video[key] < 0)))) throw new Error();
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, accounts: [] };
      throw new Error('statistics_storage_error');
    }
  };
  return { get, refresh(id) {
    const operation = serial.then(async () => {
      const snapshot = await read(id);
      const data = await get();
      data.accounts = data.accounts.filter(entry => entry.account !== snapshot.account);
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

module.exports = { parseMetric, inspectStatistics, readStudioStatistics, createStatisticsStore, writeStatisticsDiagnostic };
