// Controlled replica of the observed Studio controls. No requests reach TikTok.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createStudioDriver, prepareStudioPage, confirmScheduled, localSchedule, readStudioAccount } = require('../app/services/tiktok-studio');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shotshorts-studio-test-'));
  const file = path.join(dir, 'clip.mp4'); await fs.writeFile(file, Buffer.alloc(32));
  const targetDate = new Date(); targetDate.setDate(targetDate.getDate() + 2); targetDate.setHours(17, 30, 0, 0);
  const target = localSchedule(targetDate.toISOString());
  const month = targetDate.toLocaleString('ru-RU', { month: 'long' });
  const dateBefore = new Date(targetDate); dateBefore.setDate(dateBefore.getDate() - 1);
  const dayBefore = localSchedule(dateBefore.toISOString()).date;
  const html = `<!doctype html><html><head><meta charset="UTF-8"><style>.switch{width:40px;height:20px;background:gray}</style></head><body>
    <input type="file"><div contenteditable="true" role="combobox">clip</div>
    <input type="radio" name="postSchedule" value="schedule">
    <span>Когда опубликовать</span>
    <div><input id="date" readonly value="${dayBefore}"><span data-testid="ArrowDown" id="openDate">v</span></div>
    <div class="calendar-wrapper" style="display:none"><span class="month-title">${month}</span><span class="year-title">${target.year}</span><span class="day valid">${target.day}</span></div>
    <div><input id="time" readonly value="01:15"><span data-testid="ArrowDown" id="openTime">v</span></div>
    <div id="picker" style="display:none"><span class="tiktok-timepicker-left">17</span><span class="tiktok-timepicker-right">30</span></div>
    <div role="combobox" id="privacy">Все</div><ul role="list" hidden><li><span>Все</span></li><li><span>Только я</span></li></ul>
    <button id="more">Показать больше</button><section id="advanced" hidden>
    <label>Комментарий<input type="checkbox" id="comment" checked></label>
    <label>Повторное использование контента<input type="checkbox" id="reuse" disabled></label>
    <div class="container"><span>Контент, сгенерированный ИИ</span><div class="switch"><input role="switch" type="checkbox" style="position:absolute;opacity:0;pointer-events:none"></div></div>
    <div data-e2e="disclose_content_container"><div><input role="switch" type="checkbox"></div></div>
    </section>
    <div class="username-container"><div class="username">fixture_account</div></div>
    <button id="publish">Запланировать</button>
    <script>
      window.published=0; document.getElementById('publish').onclick=()=>{window.published++};
      document.getElementById('openDate').onclick=()=>{document.querySelector('.calendar-wrapper').style.display='block'};
      document.querySelector('.day').onclick=()=>{document.getElementById('date').value='${target.date}';document.querySelector('.calendar-wrapper').style.display='none'};
      document.getElementById('openTime').onclick=()=>{document.getElementById('picker').style.display='block'};
      document.querySelector('.tiktok-timepicker-left').onclick=()=>{const e=document.getElementById('time');e.value='17:'+e.value.slice(3)};
      document.querySelector('.tiktok-timepicker-right').onclick=()=>{const e=document.getElementById('time');e.value=e.value.slice(0,3)+'30'};
      document.getElementById('privacy').onclick=()=>{document.querySelector('ul').hidden=false};
      document.querySelectorAll('li span').forEach(e=>{e.onclick=()=>{document.getElementById('privacy').textContent=e.textContent;document.querySelector('ul').hidden=true}});
      document.querySelector('.switch').onclick=()=>{const e=document.querySelector('.switch input');e.checked=!e.checked};
      document.getElementById('more').onclick=()=>{const e=document.getElementById('advanced');e.hidden=!e.hidden;document.getElementById('more').textContent=e.hidden?'Показать больше':'Показать меньше'};
    </script></body></html>`;
  let browser;
  let fixtureHtml = html;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true, chromiumSandbox: true });
    const context = await browser.newContext();
    await context.route('**/*', (route) => route.request().url() === 'https://www.tiktok.com/tiktokstudio/upload'
      ? route.fulfill({ contentType: 'text/html', body: fixtureHtml }) : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    // Reproduce the real upload landing page: identity is in HTML-escaped
    // server context and the composer username does not exist before upload.
    const identity = JSON.stringify({ commonAppContext: { user: { uniqueId: 'fixture_account' } } });
    const landing = `<html><body><a href="/@unrelated_creator">Other profile</a><input type="file"><script id="__Creator_Center_Context__">${identity.replaceAll('"', '&quot;')}</script></body></html>`;
    await page.route('**/tiktokstudio/landing-test', route => route.fulfill({ contentType: 'text/html', body: landing }));
    await page.goto('https://www.tiktok.com/tiktokstudio/landing-test');
    assert.equal(await page.locator('.username-container .username').count(), 0);
    assert.equal(await readStudioAccount(page), 'fixture_account');
    await page.locator('#__Creator_Center_Context__').evaluate((node, json) => { node.textContent = json; }, identity);
    assert.equal(await readStudioAccount(page), 'fixture_account');
    const settings = { title: 'Описание #test', privacy: 'SELF_ONLY', comment: false, reuse: false, aigc: true };
    const hiddenControls = html.replace('<input type="radio" name="postSchedule" value="schedule">',
      '<label>Запланировать публикацию<input type="radio" name="postSchedule" value="schedule" style="position:absolute;opacity:0;pointer-events:none"></label>')
      .replace('id="comment" checked', 'id="comment" checked style="position:absolute;opacity:0;pointer-events:none"');
    let idlessFields = html;
    for (const field of ['date', 'time']) idlessFields = idlessFields
      .replace(`id="${field}" readonly`, `data-field="${field}" readonly`)
      .replaceAll(`document.getElementById('${field}')`, `document.querySelector('[data-field="${field}"]')`);
    const hiddenCopies = idlessFields.replace('<input type="file">',
      `<input readonly value="${dayBefore}" hidden><input readonly value="01:15" hidden><input type="file">`);
    const expanded = html.replace('<button id="more">Показать больше</button><section id="advanced" hidden>', '<button id="more">Показать меньше</button><section id="advanced">');
    const changedClasses = html.replace('<div class="container"><span>Контент, сгенерированный ИИ</span>', '<div class="ai-setting-row"><span>Контент, сгенерированный ИИ</span>');
    const variants = [['original', html], ['hidden controls', hiddenControls], ['fields without IDs', idlessFields], ['hidden copies of date and time', hiddenCopies], ['already expanded settings', expanded], ['AI row without container class', changedClasses]];
    const failures = [];
    let readback;
    for (const [name, markup] of variants) {
      fixtureHtml = markup;
      try {
        readback = await prepareStudioPage(page, { filePath: file, scheduledAt: targetDate.toISOString(), account: 'fixture_account', settings }, new AbortController().signal);
        assert.equal(readback.date, target.date); assert.equal(readback.time, '17:30');
        assert.equal(readback.title, settings.title); assert.equal(readback.comment, false); assert.equal(readback.aigc, true);
        assert.equal(await page.locator('input[name="postSchedule"]').isChecked(), true);
        assert.equal(await page.evaluate(() => window.published), 0);
      } catch (error) { failures.push(`${name}: ${error.message.split('\n')[0]}`); }
    }
    assert.deepEqual(failures, []);
    assert.equal(readback.date, target.date); assert.equal(readback.time, '17:30');
    assert.equal(readback.title, settings.title); assert.equal(readback.comment, false); assert.equal(readback.aigc, true);
    assert.equal(readback.privacy, 'Только я');
    assert.equal(await page.evaluate(() => window.published), 0);
    fixtureHtml = html;
    await assert.rejects(prepareStudioPage(page, { filePath: file, scheduledAt: targetDate.toISOString(), account: 'fixture_account', settings: { ...settings, reuse: true } }, new AbortController().signal), /studio_reuse_unavailable/);
    assert.equal(await page.locator('.switch input').isChecked(), true);
    assert.equal(await page.evaluate(() => window.published), 0);
    fixtureHtml = html.replace('<button id="more">Показать больше</button>', '<button id="more" disabled>Показать больше</button>');
    page.setDefaultTimeout(750);
    await assert.rejects(prepareStudioPage(page, { filePath: file, scheduledAt: targetDate.toISOString(), account: 'fixture_account', settings }, new AbortController().signal), /studio_options_timeout/);
    assert.equal(await page.evaluate(() => window.published), 0);
    page.setDefaultTimeout(5000);
    fixtureHtml = html;
    await assert.rejects(prepareStudioPage(page, { filePath: file, scheduledAt: targetDate.toISOString(), account: 'wrong_account', settings }, new AbortController().signal), /studio_account_mismatch/);
    assert.equal(await page.locator('input[type="file"]').evaluate(node => node.files.length), 0);
    await page.route('https://www.tiktok.com/tiktokstudio/content', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<html><body><section><div><p>${settings.title}</p><p>Запланировано ${target.date} 17:30</p></div></section></body></html>` }));
    await page.goto('https://www.tiktok.com/tiktokstudio/content');
    const receipt = await confirmScheduled(page, { scheduledAt: targetDate.toISOString(), settings }, { ...readback, account: 'fixture_account' });
    assert.equal(receipt.confirmed, true);
    await page.locator('p').last().evaluate((e) => { e.textContent = 'Запланировано 2000-01-01 17:30'; });
    await assert.rejects(confirmScheduled(page, { scheduledAt: targetDate.toISOString(), settings }, readback), /studio_submission_needs_review/);
    await page.locator('section').evaluate((e, desired) => {
      const unrelated = document.createElement('div'); unrelated.textContent = `Another video: Запланировано ${desired} 17:30`; e.append(unrelated);
    }, target.date);
    await assert.rejects(confirmScheduled(page, { scheduledAt: targetDate.toISOString(), settings }, readback), /studio_submission_needs_review/);
    // Exercise the real driver's final click and receipt check in an isolated
    // context. Navigation is allowed only after all requested settings match.
    let submissions = 0;
    const driver = createStudioDriver({ profilePath: path.join(dir, 'profile'), launch: async () => {
      const isolated = await browser.newContext();
      const uploadForm = changedClasses.replace("window.published=0; document.getElementById('publish').onclick=()=>{window.published++};", `
        window.published=0; document.getElementById('publish').onclick=()=>{
          if (!document.querySelector('.switch input').checked || document.getElementById('reuse').checked ||
            document.getElementById('date').value !== '${target.date}' || document.getElementById('time').value !== '17:30' ||
            document.getElementById('privacy').textContent !== 'Только я') throw new Error('Incorrect submission settings');
          location.href='/tiktokstudio/content';
        };`);
      await isolated.route('**/*', route => {
        const url = route.request().url();
        if (url === 'https://www.tiktok.com/tiktokstudio/upload') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: uploadForm });
        if (url === 'https://www.tiktok.com/tiktokstudio/content') {
          submissions++;
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><body><div><p>${settings.title}</p><p>Запланировано ${target.date} 17:30</p></div></body></html>` });
        }
        return route.abort();
      });
      return isolated;
    } });
    try {
      const scheduled = await driver.upload({ filePath: file, scheduledAt: targetDate.toISOString(), account: 'fixture_account', settings }, new AbortController().signal);
      assert.equal(scheduled.confirmed, true);
      assert.equal(submissions, 1);
    } finally { await driver.close(); }
    console.log('Studio controlled-form smoke passed: hidden controls, fields without IDs, hidden date/time copies, stage-specific errors, caption, date, time, privacy, comments, AI label, account validation. No posts submitted.');
  } finally { await browser?.close(); await fs.rm(dir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
