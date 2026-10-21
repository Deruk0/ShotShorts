// Isolated Studio pages; all requests are intercepted before reaching TikTok.
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
    const identity = '<script id="__Creator_Center_Context__">{"commonAppContext":{"user":{"uniqueId":"creator"}}}</script>';
    const content = `${identity}<div id="list" style="height:220px;overflow-y:auto"><div style="height:1400px;position:relative"><div id="badges" style="position:absolute"></div></div></div>
      <script>
      const list=document.getElementById('list');
      function render(){const part=list.scrollTop<300 ? [['23 окт, 07:00',true]] : list.scrollTop<700 ? [['21 окт, 16:00',false],['24 окт, 12:00',true]] : [['20 окт, 19:00',false]];
        document.getElementById('badges').style.top=list.scrollTop+'px';
        document.getElementById('badges').innerHTML=part.map(([date,scheduled])=>'<div data-tt="components_PublishStageLabel_FlexCenter">'+(scheduled?'<span data-icon="Alarm"></span>':'')+'<span data-tt="components_PublishStageLabel_TUXText">'+date+'</span></div>').join('');}
      list.addEventListener('scroll',render); render();
      </script>`;
    const analytics = `<button id="period">Последние 7 дн.</button><div id="choices" hidden>${[7,28,60,365].map(days => `<div onclick="choose(${days})">Последние ${days} дн.</div>`).join('')}</div><main id="metrics"></main>
      <script>
      const button=document.getElementById('period'), choices=document.getElementById('choices'), metrics=document.getElementById('metrics');
      function render(days){metrics.innerHTML=['Просмотры видео','Лайки','Комментарии'].map((name,index)=>'<button data-tt="OverviewPage_AccountMetricsCard_Clickable"><div>'+name+'</div><span class="absolute-value">'+[days===60?'4.2K':'65','3','--'][index]+'</span><div>-999 (25%)</div></button>').join('');}
      button.onclick=()=>{choices.hidden=false;};
      function choose(days){button.textContent='Последние '+days+' дн.'; choices.hidden=true; setTimeout(()=>{metrics.innerHTML='';setTimeout(()=>render(days),400);},200);}
      render(7);
      </script>`;
    for (const days of [7,60]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url === 'https://www.tiktok.com/tiktokstudio/content') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: content });
        if (url === 'https://www.tiktok.com/tiktokstudio/analytics') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: analytics });
        return route.abort();
      });
      await page.goto('https://www.tiktok.com/tiktokstudio/content');
      const result = await readStudioStatistics(page, 'creator', { days, now: new Date(2026,9,21,18), timeoutMs: 3000 });
      assert.equal(result.scope, 'account_summary'); assert.equal(result.days, days);
      assert.deepEqual(result.metrics, { views: days === 60 ? 4200 : 65, likes: 3, comments: null });
      assert.equal(result.lastPublishedAt, new Date(2026,9,21,16).toISOString());
      assert.equal(result.lastScheduledAt, new Date(2026,9,24,12).toISOString());
      assert.equal(result.videos, undefined);
      await context.close();
    }
    await fs.writeFile(path.join(dir, 'tiktok-studio-accounts.json'), JSON.stringify([{ id: 'default', username: 'creator' }]));
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: route.request().url().endsWith('/analytics') ? analytics : identity + '<p>Нет публикаций</p>' }));
    const driver = createStudioDriver({ profileOpen: async () => false, profilePath: path.join(dir, 'profile'), launch: async () => context });
    try {
      const empty = await driver.statistics('default');
      assert.equal(empty.lastPublishedAt, null); assert.equal(empty.lastScheduledAt, null);
      assert.equal(context.pages().length, 0, 'A statistics-only browser closes after reading');
    } finally { await driver.close(); }
    console.log('Account statistics smoke passed: virtual list dates, period changes, totals without deltas, unavailable comments and cleanup. No TikTok requests.');
  } finally { await browser?.close(); await fs.rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
