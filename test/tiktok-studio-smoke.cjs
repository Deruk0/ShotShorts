// Controlled replica of the observed Studio controls. No requests reach TikTok.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createTikTokQueue } = require('../app/services/tiktok-queue');
const { createStudioDriver, prepareStudioPage, confirmScheduled, localSchedule, readStudioAccount, waitForStudioReady, waitForScheduleButton, waitForSubmission } = require('../app/services/tiktok-studio');

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
    await page.locator('body').evaluate(body => {
      const label = document.createElement('div'); label.className = 'username-container';
      label.innerHTML = '<span class="username">Visible_Display_Name</span>'; body.append(label);
    });
    assert.equal(await readStudioAccount(page), 'fixture_account');
    await page.locator('#__Creator_Center_Context__').evaluate(element => {
      element.textContent = JSON.stringify({ commonAppContext: { user: { uniqueId: 'different_account' } } });
    });
    assert.equal(await readStudioAccount(page), 'different_account');
    await page.locator('#__Creator_Center_Context__').evaluate((element, json) => { element.textContent = json; }, identity);
    await page.locator('.username-container').evaluate(element => element.remove());
    await assert.rejects(waitForStudioReady(page, new AbortController().signal, { timeoutMs: 100 }), /studio_upload_not_ready/);
    const stopWaiting = new AbortController();
    const cancelledWait = assert.rejects(waitForStudioReady(page, stopWaiting.signal), error => error.name === 'AbortError');
    stopWaiting.abort();
    await cancelledWait;
    assert.equal(await page.locator('.username-container .username').count(), 0);
    assert.equal(await readStudioAccount(page), 'fixture_account');
    await page.locator('#__Creator_Center_Context__').evaluate((node, json) => { node.textContent = json; }, identity);
    assert.equal(await readStudioAccount(page), 'fixture_account');
    const settings = { title: 'Описание #test', privacy: 'SELF_ONLY', comment: false, reuse: false, aigc: true };
    await page.goto('https://www.tiktok.com/tiktokstudio/upload');
    await page.evaluate(() => {
      const progress = document.createElement('progress'); progress.max = 100; progress.value = 10;
      progress.id = 'pending-upload'; document.body.append(progress);
      setTimeout(() => progress.remove(), 500);
    });
    await waitForScheduleButton(page, new AbortController().signal, { timeoutMs: 3000, stableMs: 0 });
    assert.equal(await page.locator('#pending-upload').count(), 0);
    // Reproduce a nested Studio scroller that enables submission only once
    // its footer has entered view. Waiting for enabled before scrolling stalls.
    await page.evaluate(() => {
      const scroller = document.createElement('div');
      scroller.id = 'submit-scroller';
      scroller.style.cssText = 'height:180px;overflow:auto;margin-top:1200px';
      scroller.innerHTML = '<div style="height:1200px"></div>';
      const button = document.getElementById('publish'); button.disabled = true;
      scroller.append(button); document.body.append(scroller);
      scroller.onscroll = () => { if (scroller.scrollTop > 1000) button.disabled = false; };
    });
    await waitForScheduleButton(page, new AbortController().signal, { timeoutMs: 3000, stableMs: 0 });
    assert.ok(await page.locator('#submit-scroller').evaluate(element => element.scrollTop) > 1000);
    await page.goto('https://www.tiktok.com/tiktokstudio/upload');
    await page.locator('#publish').evaluate(button => { button.disabled = true; });
    await assert.rejects(waitForScheduleButton(page, new AbortController().signal, { timeoutMs: 50 }), /studio_schedule_button_disabled/);
    const stopSubmitting = new AbortController();
    const cancelledSubmit = assert.rejects(waitForScheduleButton(page, stopSubmitting.signal), error => error.name === 'AbortError');
    stopSubmitting.abort(); await cancelledSubmit;
    await page.evaluate(() => {
      const modal = document.createElement('div'); modal.setAttribute('role', 'dialog');
      modal.innerHTML = '<h2>Принять соглашение?</h2><button onclick="window.unrelatedAccepted=true">Подтвердить</button>';
      document.body.append(modal);
    });
    await assert.rejects(waitForSubmission(page, new AbortController().signal, { timeoutMs: 1000 }), /studio_submission_needs_review/);
    assert.equal(await page.evaluate(() => window.unrelatedAccepted), undefined);
    await page.locator('[role="dialog"]').evaluate(element => element.remove());
    await assert.rejects(waitForSubmission(page, new AbortController().signal, { timeoutMs: 100 }), /studio_submission_needs_review/);
    const stopConfirming = new AbortController(); stopConfirming.abort();
    await assert.rejects(waitForSubmission(page, stopConfirming.signal), error => error.name === 'AbortError');
    const restrictedReuse = await prepareStudioPage(page, { filePath: file, scheduledAt: targetDate.toISOString(), account: 'fixture_account', settings: { ...settings, reuse: true } }, new AbortController().signal);
    assert.equal(restrictedReuse.reuse, false);
    assert.deepEqual(restrictedReuse.warnings, ['studio_reuse_disabled_by_tiktok']);
    const genericPrivacy = html.replace('<ul role="list" hidden>', '<div class="privacy-menu" hidden>')
      .replace('</ul>', '</div>').replaceAll("document.querySelector('ul')", "document.querySelector('.privacy-menu')");
    fixtureHtml = genericPrivacy;
    const publicReadback = await prepareStudioPage(page, { filePath: file, scheduledAt: targetDate.toISOString(), account: 'fixture_account', settings: { ...settings, privacy: 'PUBLIC_TO_EVERYONE' } }, new AbortController().signal);
    assert.equal(publicReadback.privacy, 'Все');
    assert.equal(await page.locator('.privacy-menu').isVisible(), false);
    assert.equal(await page.evaluate(() => window.published), 0);
    fixtureHtml = genericPrivacy.replace("document.querySelector('.privacy-menu').hidden=false", "setTimeout(()=>{document.querySelector('.privacy-menu').hidden=false}, 300)");
    const privateReadback = await prepareStudioPage(page, { filePath: file, scheduledAt: targetDate.toISOString(), account: 'fixture_account', settings }, new AbortController().signal);
    assert.equal(privateReadback.privacy, 'Только я');
    assert.equal(await page.locator('.privacy-menu').isVisible(), false);
    assert.equal(await page.evaluate(() => window.published), 0);
    fixtureHtml = html.replace('<span>Когда опубликовать</span>', '<span style="pointer-events:none">Когда опубликовать</span>');
    await prepareStudioPage(page, { filePath: file, scheduledAt: targetDate.toISOString(), account: 'fixture_account', settings }, new AbortController().signal);
    assert.equal(await page.locator('.switch input').isChecked(), true);
    fixtureHtml = html.replace('<button id="publish">', '<button id="publish" disabled>');
    await page.goto('https://www.tiktok.com/tiktokstudio/upload');
    await waitForStudioReady(page, new AbortController().signal, { timeoutMs: 300, stableMs: 0 });
    assert.equal(await page.locator('#publish').isEnabled(), false);
    fixtureHtml = html;
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
    const configurationGated = html.replace('<button id="publish">', '<button id="publish" disabled>')
      .replace('e.checked=!e.checked};', "e.checked=!e.checked;document.getElementById('publish').disabled=!e.checked};");
    const nestedDisclosure = html.replace('<button id="more">Показать больше</button>', '<button id="more"><span style="pointer-events:none">Показать больше</span></button>');
    const coveredDisclosure = html.replace('<button id="more">Показать больше</button>', '<button id="more" style="position:fixed;bottom:0;left:0;height:40px">Показать больше</button><footer style="position:fixed;bottom:0;left:0;width:100%;height:60px;background:white;z-index:100">Панель публикации</footer>');
    const delayedUpload = html.replace('window.published=0;', `
      window.uploadComplete=false;
      document.querySelector('input[type="file"]').onchange=()=>{
        document.getElementById('publish').disabled=true;
        const progress=document.createElement('progress');progress.max=100;progress.value=10;document.body.append(progress);
        setTimeout(()=>{
          document.querySelector('[contenteditable]').textContent='Automatic filename after upload';
          document.getElementById('publish').disabled=false;progress.remove();window.uploadComplete=true;
        }, 1200);
      };
      window.published=0;`);
    const variants = [['original', html], ['hidden controls', hiddenControls], ['fields without IDs', idlessFields], ['hidden copies of date and time', hiddenCopies], ['already expanded settings', expanded], ['AI row without container class', changedClasses], ['delayed upload', delayedUpload], ['button enabled after configuration', configurationGated], ['nested disclosure text ignores mouse clicks', nestedDisclosure], ['publication footer covers disclosure', coveredDisclosure]];
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
        if (name === 'delayed upload') assert.equal(await page.evaluate(() => window.uploadComplete), true);
      } catch (error) { failures.push(`${name}: ${error.message.split('\n')[0]}`); }
    }
    assert.deepEqual(failures, []);
    assert.equal(readback.date, target.date); assert.equal(readback.time, '17:30');
    assert.equal(readback.title, settings.title); assert.equal(readback.comment, false); assert.equal(readback.aigc, true);
    assert.equal(readback.privacy, 'Только я');
    assert.equal(await page.evaluate(() => window.published), 0);
    fixtureHtml = html;
    const restrictedAgain = await prepareStudioPage(page, { filePath: file, scheduledAt: targetDate.toISOString(), account: 'fixture_account', settings: { ...settings, reuse: true } }, new AbortController().signal);
    assert.equal(restrictedAgain.reuse, false);
    assert.equal(await page.locator('.switch input').isChecked(), true);
    assert.equal(await page.evaluate(() => window.published), 0);
    fixtureHtml = html.replace('<button id="more">Показать больше</button>', '<button id="more" disabled>Показать больше</button>');
    page.setDefaultTimeout(750);
    await assert.rejects(prepareStudioPage(page, { filePath: file, scheduledAt: targetDate.toISOString(), account: 'fixture_account', settings }, new AbortController().signal), /studio_options_timeout/);
    assert.equal(await page.evaluate(() => window.published), 0);
    page.setDefaultTimeout(5000);
    fixtureHtml = html;
    await assert.rejects(prepareStudioPage(page, { filePath: file, scheduledAt: targetDate.toISOString(), account: 'wrong_account', settings }, new AbortController().signal), error => {
      assert.equal(error.message, 'studio_account_mismatch');
      assert.deepEqual(error.accountCheck, { expected: 'wrong_account', actual: 'fixture_account', phase: 'before_upload' });
      return true;
    });
    assert.equal(await page.locator('input[type="file"]').evaluate(node => node.files.length), 0);
    await page.route('https://www.tiktok.com/tiktokstudio/content', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<html><body><section><div><p>${settings.title}</p><p>Запланировано ${target.date} 17:30</p></div></section></body></html>` }));
    await page.goto('https://www.tiktok.com/tiktokstudio/content');
    await waitForSubmission(page, new AbortController().signal, { timeoutMs: 1000 });
    const receipt = await confirmScheduled(page, { scheduledAt: targetDate.toISOString(), settings }, { ...readback, account: 'fixture_account' });
    assert.equal(receipt.confirmed, true);
    await page.locator('p').last().evaluate((e) => { e.textContent = 'Запланировано 2000-01-01 17:30'; });
    await assert.rejects(confirmScheduled(page, { scheduledAt: targetDate.toISOString(), settings }, readback, { timeoutMs: 100 }), /studio_submission_needs_review/);
    await page.locator('section').evaluate((e, desired) => {
      const unrelated = document.createElement('div'); unrelated.textContent = `Another video: Запланировано ${desired} 17:30`; e.append(unrelated);
    }, target.date);
    await assert.rejects(confirmScheduled(page, { scheduledAt: targetDate.toISOString(), settings }, readback, { timeoutMs: 100 }), /studio_submission_needs_review/);
    await page.locator('section').evaluate((section, target) => {
      section.innerHTML = '<div role="row"><div><p></p><span>01:20</span></div><p id="schedule-metadata">Обработка</p></div>';
      section.querySelector('p').textContent = target.title;
      setTimeout(() => { section.querySelector('#schedule-metadata').textContent = `Запланировано ${target.date} 17:30`; }, 500);
    }, { title: settings.title, date: target.date });
    const delayedReceipt = await confirmScheduled(page, { scheduledAt: targetDate.toISOString(), settings }, readback, { timeoutMs: 2000 });
    assert.equal(delayedReceipt.confirmed, true);
    const compactDate = targetDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace(/\.$/, '');
    await page.locator('#schedule-metadata').evaluate((element, date) => { element.textContent = `${date}, 17:30`; }, compactDate);
    assert.equal((await confirmScheduled(page, { scheduledAt: targetDate.toISOString(), settings }, readback, { timeoutMs: 1000 })).confirmed, true);
    await page.locator('[role="row"] span').evaluate(element => { element.textContent = '17:30'; });
    await page.locator('#schedule-metadata').evaluate((element, date) => { element.textContent = `${date}, 17:35`; }, compactDate);
    await assert.rejects(confirmScheduled(page, { scheduledAt: targetDate.toISOString(), settings }, readback, { timeoutMs: 100 }), /studio_submission_needs_review/);
    await page.locator('#schedule-metadata').evaluate(element => { element.textContent = '1 янв, 17:30'; });
    await assert.rejects(confirmScheduled(page, { scheduledAt: targetDate.toISOString(), settings }, readback, { timeoutMs: 100 }), /studio_submission_needs_review/);
    // Exercise the real driver's final click and receipt check in an isolated
    // context. Navigation is allowed only after all requested settings match.
    let submissions = 0;
    let nextUploadClicks = 0;
    let activeItem;
    const driver = createStudioDriver({ profileOpen: async () => false, profilePath: path.join(dir, 'profile'), launch: async () => {
      const isolated = await browser.newContext();
      const uploadForm = changedClasses.replace("window.published=0; document.getElementById('publish').onclick=()=>{window.published++};", `
        window.published=0; document.getElementById('publish').onclick=()=>{
          if (!document.querySelector('.switch input').checked || document.getElementById('reuse').checked ||
            document.getElementById('date').value !== '${target.date}' || document.getElementById('time').value !== 'EXPECTED_TIME' ||
            document.getElementById('privacy').textContent !== 'Только я') throw new Error('Incorrect submission settings');
          if (++window.published !== 1) throw new Error('Duplicate submit');
          setTimeout(()=>{
            const modal=document.createElement('div');modal.setAttribute('role','dialog');
            modal.innerHTML='<h2>Продолжить публикацию?</h2><p>Проверка авторских прав не выполнена. Если вы опубликуете видео сейчас, проверка будет прекращена.</p><p>Ваше видео еще проверяется на наличие потенциальных проблем. Продолжить публикацию до завершения проверки?</p><button>Отмена</button><button id="confirm-submit">Опубликовать</button>';
            document.body.append(modal);
            document.getElementById('confirm-submit').onclick=()=>{location.href='/tiktokstudio/content'};
          }, 300);
        };`).replace("document.querySelector('.switch').onclick=()=>{const e=document.querySelector('.switch input');e.checked=!e.checked};", `
          document.querySelector('.switch').onclick=()=>{
            const e=document.querySelector('.switch input');e.checked=!e.checked;
            const button=document.getElementById('publish');button.disabled=true;
            setTimeout(()=>{button.disabled=false}, 1000);
          };`)
        .replace('<span class="tiktok-timepicker-right">30</span>', '<span class="tiktok-timepicker-right">30</span><span class="tiktok-timepicker-right">35</span><span class="tiktok-timepicker-right">40</span>')
        .replace("document.querySelector('.tiktok-timepicker-right').onclick=()=>{const e=document.getElementById('time');e.value=e.value.slice(0,3)+'30'};", "document.querySelectorAll('.tiktok-timepicker-right').forEach(minute=>{minute.onclick=()=>{const e=document.getElementById('time');e.value=e.value.slice(0,3)+minute.textContent}});");
      await isolated.route('**/*', route => {
        const url = route.request().url();
        if (url === 'https://www.tiktok.com/tiktokstudio/upload' || url === 'https://www.tiktok.com/tiktokstudio/upload?from=content_list') {
          if (url.endsWith('?from=content_list')) nextUploadClicks++;
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: uploadForm.replace('EXPECTED_TIME', localSchedule(activeItem.scheduledAt).time) });
        }
        if (url === 'https://www.tiktok.com/tiktokstudio/content') {
          submissions++;
          const scheduledTime = localSchedule(activeItem.scheduledAt).time;
          const uploadControl = submissions === 1 ? '<a href="/tiktokstudio/upload?from=content_list">' : '<div onclick="location.href=\'/tiktokstudio/upload?from=content_list\'">';
          const controlEnd = submissions === 1 ? '</a>' : '</div>';
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><body><aside>${uploadControl}<svg aria-hidden="true" width="20" height="20"><path d="M10 2v16M2 10h16" stroke="white"/></svg>${controlEnd}</aside><div role="row"><div><p>${activeItem.settings.title}</p><span>01:20</span></div><p id="metadata">Обработка</p></div><script>setTimeout(()=>{document.getElementById('metadata').textContent='${compactDate}, ${scheduledTime}'},500)</script></body></html>` });
        }
        return route.abort();
      });
      return isolated;
    } });
    try {
      let saved;
      const queue = createTikTokQueue({ storage: { read: async () => null, write: async state => { saved = structuredClone(state); } },
        upload: async (item, signal) => { activeItem = item; return driver.upload(item, signal); } });
      await queue.template({ ...settings, reuse: true, account: 'fixture_account', firstAt: targetDate.toISOString(), intervalMinutes: 5 });
      const secondFile = path.join(dir, 'second.mp4'); await fs.copyFile(file, secondFile);
      const thirdFile = path.join(dir, 'third.mp4'); await fs.copyFile(file, thirdFile);
      const plan = await queue.addGenerated([file, secondFile, thirdFile]);
      await queue.send({ ids: plan.items.map(item => item.id), consent: true });
      await queue.idle();
      assert.deepEqual(saved.items.map(item => item.status), ['scheduled', 'scheduled', 'scheduled']);
      assert.equal(saved.paused, false);
      assert.equal(saved.items[1].receipt.scheduledAt, new Date(targetDate.getTime() + 5 * 60000).toISOString());
      assert.deepEqual(saved.items[0].receipt.warnings, ['studio_reuse_disabled_by_tiktok']);
      assert.equal(submissions, 3);
      assert.equal(nextUploadClicks, 1, 'The second clip must start by clicking Upload on the content list');
    } finally { await driver.close(); }
    console.log('Studio controlled-form smoke passed: delayed upload, nested footer scrolling, delayed Schedule button, readiness timeout/cancellation, hidden controls, date/time, AI label, final confirmation dialog, unknown-dialog rejection and schedule receipt. No posts submitted.');
  } finally { await browser?.close(); await fs.rm(dir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
