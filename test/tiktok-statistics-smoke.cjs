// Isolated Studio content page; no network requests reach TikTok.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createStudioDriver } = require('../app/services/tiktok-studio');
const { readStudioStatistics } = require('../app/services/tiktok-statistics');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shotshorts-statistics-smoke-'));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    // Header labels can be right aligned while metric text is left aligned
    // inside the same column. Text bounding boxes are not column boundaries.
    const shifted = await browser.newPage();
    await shifted.setContent(`<style>.row{display:grid;grid-template-columns:350px repeat(3,140px);padding:20px}.headers{text-align:right}</style>
      <div class="row headers"><div>Контент</div><div><span>Просмотры</span></div><div><span>Лайки</span></div><div><span>Комментарии</span></div></div>
      <div class="row" role="row"><div>Тестовый ролик</div><div><span>120</span></div><div><span>3</span></div><div><span>1</span></div></div>`);
    const shiftedResult = await readStudioStatistics(shifted, 'creator', { timeoutMs: 1000 });
    assert.equal(shiftedResult.videos[0].views, 120);
    await shifted.close();
    for (const semantic of [true, false]) {
      await fs.writeFile(path.join(dir, 'tiktok-studio-accounts.json'), JSON.stringify([{ id: 'default', username: 'creator' }]));
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const identity = '<script id="__Creator_Center_Context__">{"commonAppContext":{"user":{"uniqueId":"creator"}}}</script>';
      const content = `<html><head><meta charset="utf-8"><style>.columns{display:grid;grid-template-columns:400px 120px 130px 130px 140px;gap:10px;padding:20px}a{display:block}</style></head><body>${identity}
        <button>Просмотры</button><button>Лайки</button><button>Комментарии</button>
        <div class="columns"><span>Контент</span><span>Видимость</span>${['Просмотры', 'Лайки', 'Комментарии'].map(name => semantic ? `<button>${name}</button>` : `<span>${name}</span>`).join('')}</div>
        <div class="columns" ${semantic ? 'role="row"' : ''}><div><a href="/@creator/video/123456">Первый ролик #история</a><span>01:35</span></div><span>Все</span><span>1.2K</span><span>30</span><span>2</span></div>
        <div class="columns" ${semantic ? 'role="row"' : ''}><div><a href="/@creator/video/234567">Второй ролик</a><span>02:05</span></div><span>Все</span><span>0</span><span>0</span><span>0</span></div>
      </body></html>`;
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url === 'https://www.tiktok.com/tiktokstudio/content') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: content });
        if (url === 'https://www.tiktok.com/tiktokstudio/upload') return route.fulfill({ contentType: 'text/html', body: identity });
        return route.abort();
      });
      const driver = createStudioDriver({ profileOpen: async () => false, profilePath: path.join(dir, 'profile'), launch: async () => context });
      try {
        const result = await driver.statistics('default');
        assert.equal(result.account, 'creator'); assert.equal(result.scope, 'content_page');
        assert.equal(result.videos.length, 2);
        assert.deepEqual(result.videos.map(video => [video.views, video.likes, video.comments]), [[1200, 30, 2], [0, 0, 0]]);
        assert.equal(result.videos[0].url, 'https://www.tiktok.com/@creator/video/123456');
        assert.equal(context.pages().length, 0, 'The browser opened only for statistics is closed without an upload page');
      } finally { await driver.close(); }
    }
    console.log('Studio statistics smoke passed: semantic/div rows, localized counts, account verification and tab cleanup. No real TikTok requests.');
  } finally { await browser?.close(); await fs.rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
