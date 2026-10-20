// Run manually with: node test/tiktok-ui-smoke.cjs
// Uses an isolated Electron profile and replaces TikTok IPC with deterministic fixtures.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shotshorts-tiktok-ui-'));
  const bootstrap = path.join(temp, 'main.cjs');
  const appMain = path.resolve(__dirname, '../app/main.js');
  await fs.writeFile(path.join(temp, 'tiktok-queue.json'), JSON.stringify({ version: 1, paused: false,
    template: { firstAt: '', title: '{name}', intervalMinutes: 60, privacy: '', account: '', autoUpload: false },
    items: ['one', 'two', 'scheduled'].map((name, index) => ({ id: name, filePath: `C:\\fixture\\${name}.mp4`, name, status: name === 'scheduled' ? 'scheduled' : 'draft', account: 'fixture_account',
      scheduledAt: `2099-10-20T${12+index}:00:00Z`, settings: { title: name, privacy: 'PUBLIC_TO_EVERYONE', comment: false, reuse: false, aigc: false },
      ...(name === 'scheduled' ? { receipt: { confirmed: true, warnings: ['studio_reuse_disabled_by_tiktok'] } } : {}) })) }));
  await fs.writeFile(bootstrap, `const {app} = require('electron'); app.setPath('userData', ${JSON.stringify(temp)}); require(${JSON.stringify(appMain)});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let electron;
  try {
    electron = await _electron.launch({ args: [bootstrap], env });
    const page = await electron.firstWindow();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForFunction(() => !!window.TikTokPanel);
    const actualState = await page.evaluate(() => window.api.tiktok.state());
    assert.equal(actualState.success, true);
    const actualConfig = await page.evaluate(() => window.api.tiktok.configure({ clientKey: 'test-key', clientSecret: 'test-secret-do-not-publish' }));
    assert.equal(actualConfig.success, true);
    assert.equal(actualConfig.data.clientSecret, undefined);
    const encrypted = await fs.readFile(path.join(temp, 'tiktok-credentials.enc'));
    assert.equal(encrypted.includes('test-secret-do-not-publish'), false);
    await electron.evaluate(({ ipcMain }) => {
      const creator = { creator_nickname: 'Test Creator', creator_username: 'test_creator',
        privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], max_video_post_duration_sec: 60,
        comment_disabled: false, duet_disabled: true, stitch_disabled: false };
      let state = { clientKey: '', hasSecret: false, connected: false, lastPost: null };
      global.__tikTokPublished = [];
      const handle = (name, fn) => {
        ipcMain.removeHandler(`tiktok:${name}`);
        ipcMain.handle(`tiktok:${name}`, async (_event, input) => ({ success: true, data: fn(input) }));
      };
      handle('state', () => state);
      handle('configure', (input) => { state = { ...state, clientKey: input.clientKey, hasSecret: true }; return state; });
      handle('connect', () => { state.connected = true; return { ...state, creator }; });
      handle('creator', () => creator);
      handle('disconnect', () => { state.connected = false; state.lastPost = null; return state; });
      handle('publish', (input) => {
        global.__tikTokPublished.push(input);
        state.lastPost = { publishId: 'ui-test', privacy: input.privacy, status: 'PROCESSING_UPLOAD' };
        return state.lastPost;
      });
      handle('status', () => { state.lastPost.status = 'PUBLISH_COMPLETE'; return state.lastPost; });
      let accounts = [{ id: 'default', username: '' }];
      const studio = (name, fn) => {
        ipcMain.removeHandler(`tiktok:studio:${name}`);
        ipcMain.handle(`tiktok:studio:${name}`, async (_event, input) => ({ success: true, data: fn(input) }));
      };
      studio('accounts', () => accounts);
      studio('refreshAccounts', () => { accounts = accounts.map(entry => entry.id === 'default' ? { ...entry, username: 'fixture_account' } : entry); return accounts; });
      studio('addAccount', () => { accounts.push({ id: 'second', username: 'second_account' }); return accounts; });
      studio('open', () => ({ open: true }));
      ipcMain.removeHandler('media:probe');
      ipcMain.handle('media:probe', () => ({ success: true, isImage: false,
        thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }));
    });
    await page.click('[data-tab="settings"]');
    await page.selectOption('#app-language', 'ru', { force: true });
    await page.click('[data-tab="tiktok"]');
    await page.getByRole('button', { name: 'Обновить аккаунты', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#tq-defaults-account')?.value === 'fixture_account');
    assert.equal(await page.locator('#tt-direct').getAttribute('open'), null);
    await page.locator('#tt-direct > summary').click();
    await page.waitForFunction(() => document.getElementById('tt-setup').open);
    assert.equal(await page.locator('#tab-settings').isVisible(), false);
    assert.equal(await page.locator('#tt-publish').isDisabled(), true);
    await page.fill('#tt-key', 'fixture-key');
    await page.fill('#tt-secret', 'fixture-secret');
    await page.click('#tt-save');
    await page.waitForFunction(() => !document.getElementById('tt-connect').disabled);
    assert.equal(await page.inputValue('#tt-secret'), '');
    await page.click('#tt-connect');
    await page.waitForFunction(() => document.getElementById('tt-account').textContent.includes('Test Creator'));
    assert.equal(await page.locator('#tt-duet').isDisabled(), true);
    assert.equal(await page.inputValue('#tt-privacy'), '');
    assert.equal(await page.locator('#tt-comment').isChecked(), false);
    await page.evaluate(() => window.TikTokPanel.setGeneratedFiles(['C:\\fixture\\clip.mp4']));
    await page.evaluate(() => { window.TikTokPanel.setLanguage('en'); window.TikTokPanel.setLanguage('ru'); });
    assert.equal(await page.locator('#tt-generated-label').textContent(), 'Готовые клипы');
    await page.selectOption('#tt-generated', 'C:\\fixture\\clip.mp4', { force: true });
    await page.waitForFunction(() => !document.getElementById('tt-preview').hidden);
    await page.fill('#tt-caption', 'Проверка описания #ролик');
    await page.selectOption('#tt-privacy', 'PUBLIC_TO_EVERYONE', { force: true });
    assert.equal(await page.locator('#tt-publish').isDisabled(), true);
    await page.check('#tt-consent');
    assert.equal(await page.locator('#tt-publish').isEnabled(), true);
    await page.fill('#tt-caption', 'Изменённое описание #ролик');
    assert.equal(await page.locator('#tt-consent').isChecked(), false);
    await page.check('#tt-commercial');
    await page.check('#tt-consent');
    assert.equal(await page.locator('#tt-publish').isDisabled(), true);
    await page.check('#tt-own-brand');
    await page.check('#tt-consent');
    assert.equal(await page.locator('#tt-publish').isEnabled(), true);
    const screenshot = path.join(os.tmpdir(), 'shotshorts-tiktok-ui.png');
    await page.evaluate(() => { document.getElementById('tab-tiktok').scrollTop = 0; });
    await page.screenshot({ path: screenshot, fullPage: true });
    await page.click('#tt-publish');
    await page.waitForFunction(() => document.getElementById('tt-status').textContent.includes('ui-test'));
    assert.equal(await page.locator('#tt-publish').isDisabled(), true);
    await page.click('#tt-status-check');
    await page.waitForFunction(() => document.getElementById('tt-status').textContent.includes('Опубликовано'));
    const published = await electron.evaluate(() => global.__tikTokPublished);
    assert.equal(published.length, 1);
    assert.equal(published[0].comment, false);
    assert.equal(published[0].title, 'Изменённое описание #ролик');
    assert.equal(published[0].privacy, 'PUBLIC_TO_EVERYONE');
    assert.equal(published[0].ownBrand, true);
    await page.click('#tt-disconnect');
    await page.waitForFunction(() => document.getElementById('tt-composer').disabled);
    await page.locator('.queue-item[data-id="one"]').getByRole('button', { name: 'Настроить', exact: true }).click();
    await page.fill('#tq-tq-editor-scheduledAt', '2099-10-21T17:30');
    await page.fill('#tq-tq-editor-title', 'Individual queue caption');
    await page.check('#tq-tq-editor-checks-comment');
    await page.getByRole('button', { name: 'Сохранить ролик', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('tq-editor'));
    const plan = await page.evaluate(() => window.api.tiktok.queue.get());
    assert.equal(plan.data.items[0].settings.title, 'Individual queue caption');
    assert.equal(plan.data.items[0].settings.comment, true);
    assert.equal(plan.data.items[1].settings.comment, false);
    assert.equal(new Date(plan.data.items[0].scheduledAt).getUTCHours(), 14);
    await page.evaluate(() => { document.getElementById('tab-tiktok').scrollTop = 0; });
    await page.screenshot({ path: path.join(os.tmpdir(), 'shotshorts-tiktok-queue.png'), fullPage: true });
    await page.locator('#tt-direct > summary').click();
    await page.locator('.queue-template > summary').click();
    await page.selectOption('#tq-defaults-account', 'fixture_account', { force: true });
    await page.fill('#tq-defaults-firstAt', '2099-10-22T18:00');
    await page.fill('#tq-defaults-title', 'Шаблон {name}');
    await page.selectOption('#tq-defaults-privacy', 'SELF_ONLY', { force: true });
    await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('tq-status').textContent.includes('сохранён'));
    const defaultsPlan = await page.evaluate(() => window.api.tiktok.queue.get());
    assert.equal(defaultsPlan.data.template.title, 'Шаблон {name}');
    assert.equal(defaultsPlan.data.template.account, 'fixture_account');
    assert.equal(defaultsPlan.data.items[0].settings.title, 'Individual queue caption');
    assert.equal(await page.locator('.queue-template').evaluate(node => node.open), true);
    await page.getByRole('button', { name: 'Добавить аккаунт', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelector('#tq-defaults-account').options].some(o => o.value === 'second_account'));
    await page.locator('.queue-item[data-id="two"]').getByRole('button', { name: 'Настроить', exact: true }).click();
    await page.selectOption('#tq-tq-editor-account', 'second_account', { force: true });
    await page.getByRole('button', { name: 'Сохранить ролик', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('tq-editor'));
    const multiPlan = await page.evaluate(() => window.api.tiktok.queue.get());
    assert.equal(multiPlan.data.items[0].account, 'fixture_account');
    assert.equal(multiPlan.data.items[1].account, 'second_account');
    assert.equal(multiPlan.data.template.account, 'fixture_account');
    for (const width of [800, 900, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => { document.getElementById('tab-tiktok').scrollTop = 0; });
      assert.equal(await page.locator('#tab-tiktok').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      const defaultsBox = await page.locator('.queue-template').boundingBox();
      const queueBox = await page.locator('.queue-plan').boundingBox();
      if (width === 1280) assert.ok(queueBox.x > defaultsBox.x + defaultsBox.width);
      else assert.ok(queueBox.y > defaultsBox.y + defaultsBox.height);
      await page.screenshot({ path: path.join(os.tmpdir(), `shotshorts-tiktok-layout-${width}.png`) });
    }
    await page.getByRole('button', { name: 'Пресеты описаний и хештегов', exact: true }).first().click();
    await page.fill('#tq-hashtag-library-presetName', 'Кино');
    await page.fill('#tq-hashtag-library-tags', '#кино #сериал #история #movie');
    await page.fill('#tq-hashtag-library-minCount', '2');
    await page.fill('#tq-hashtag-library-maxCount', '3');
    await page.locator('#hashtag-library').getByRole('button', { name: 'Сохранить пресет', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#tq-presets-dialog [role="status"]').textContent.includes('сохранён'));
    const withHashtags = await page.evaluate(() => window.api.tiktok.queue.get());
    const hashtagId = withHashtags.data.hashtagPresets[0].id;
    await page.fill('#tq-caption-library-presetName', 'Истории');
    await page.fill('#tq-caption-library-captionTemplate', 'Смотри {name} {hashtags}');
    // Use the actual popup inside the dialog, not only the hidden native select.
    await page.click('#tq-caption-library-hashtagPresetId-sharp-trigger');
    await page.locator('#tq-caption-library-hashtagPresetId-sharp-listbox').getByRole('option', { name: 'Кино', exact: true }).click();
    await page.locator('#caption-library').getByRole('button', { name: 'Сохранить пресет', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#tq-presets-dialog [role="status"]').textContent.includes('сохранён'));
    const withCaptions = await page.evaluate(() => window.api.tiktok.queue.get());
    const captionId = withCaptions.data.captionPresets[0].id;
    await page.screenshot({ path: path.join(os.tmpdir(), 'shotshorts-caption-presets.png') });
    await page.locator('#tq-presets-dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.check('#tq-tiktok-queue-panel-consent');
    assert.equal(await page.locator('#tq-send').isEnabled(), true);
    await page.selectOption('#tq-defaults-captions-captionPreset', captionId, { force: true });
    assert.equal(await page.inputValue('#tq-defaults-title'), 'Смотри {name} {hashtags}');
    assert.equal(await page.locator('#tq-send').isDisabled(), true);
    assert.equal(await page.locator('#tq-tiktok-queue-panel-consent').isChecked(), false);
    assert.equal(await page.inputValue('#tq-defaults-captions-hashtagPresetId'), hashtagId);
    // Opening another editor must preserve unsaved defaults.
    await page.locator('.queue-item[data-id="one"]').getByRole('button', { name: 'Настроить', exact: true }).click();
    assert.equal(await page.locator('#tq-editor').count(), 0);
    assert.equal(await page.inputValue('#tq-defaults-title'), 'Смотри {name} {hashtags}');
    await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#tq-status').textContent.includes('сохранён'));
    await page.locator('.queue-item[data-id="two"]').getByRole('button', { name: 'Настроить', exact: true }).click();
    await page.locator('#tq-editor-captions > summary').click();
    await page.selectOption('#tq-tq-editor-captions-captionPreset', captionId, { force: true });
    await page.locator('#tq-editor').getByRole('button', { name: 'Вставить в описание', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#tq-tq-editor-title').value.startsWith('Смотри two #'));
    const composed = await page.inputValue('#tq-tq-editor-title');
    const pickedTags = composed.match(/#[^ ]+/g);
    assert.ok(pickedTags.length >= 2 && pickedTags.length <= 3);
    assert.equal(new Set(pickedTags).size, pickedTags.length);
    // A different clip cannot silently replace this editor while it has changes.
    await page.locator('.queue-item[data-id="one"]').getByRole('button', { name: 'Настроить', exact: true }).click();
    assert.equal(await page.inputValue('#tq-tq-editor-title'), composed);
    await page.getByRole('button', { name: 'Сохранить ролик', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('tq-editor'));
    const captionPlan = await page.evaluate(() => window.api.tiktok.queue.get());
    assert.equal(captionPlan.data.items[1].settings.title, composed);
    assert.equal(captionPlan.data.items[0].settings.title, 'Individual queue caption');
    const scheduledCard = page.locator('.queue-item[data-id="scheduled"]');
    assert.equal(await scheduledCard.getByText('TikTok отключил повторное использование для этого видео. Ролик запланирован с выключенным повторным использованием.', { exact: true }).count(), 1);
    assert.equal(await scheduledCard.getByRole('button', { name: 'Настроить', exact: true }).count(), 0);
    await scheduledCard.getByRole('button', { name: 'Убрать из плана', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.queue-item[data-id="scheduled"]'));
    const removedPlan = await page.evaluate(() => window.api.tiktok.queue.get());
    assert.deepEqual(removedPlan.data.items.map(item => item.id), ['one', 'two']);
    assert.deepEqual(await electron.evaluate(() => global.__tikTokPublished), published);
    const diagnosticPlan = structuredClone(removedPlan.data);
    Object.assign(diagnosticPlan.items[0], { status: 'needs_attention', error: 'studio_account_mismatch',
      accountCheck: { expected: 'fixture_account', actual: 'other_account', phase: 'before_submit' } });
    await electron.evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('tiktok:queue:get');
      ipcMain.handle('tiktok:queue:get', () => ({ success: true, data: fixture }));
    }, diagnosticPlan);
    await page.evaluate(() => window.TikTokQueuePanel.refresh());
    assert.equal(await page.locator('.queue-item[data-id="one"]').getByText('Аккаунт в плане: @fixture_account · Аккаунт на странице TikTok: @other_account', { exact: true }).count(), 1);
    await electron.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('tiktok:studio:refreshAccounts');
      ipcMain.handle('tiktok:studio:refreshAccounts', () => ({ success: false, error: 'studio_account_unavailable' }));
    });
    await page.getByRole('button', { name: 'Обновить аккаунты', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('tq-error').textContent.includes('Не удалось определить аккаунт'));
    assert.equal(await page.locator('.queue-connection #tq-error').isVisible(), true);
    await page.click('[data-tab="generator"]');
    assert.equal(await page.locator('#tab-tiktok').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log(`Electron TikTok UI smoke passed. Screenshot: ${screenshot}`);
  } finally {
    if (electron) await electron.close();
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
