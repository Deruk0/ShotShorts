const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const { abortableSleep } = require('./cancellation');

const UPLOAD = 'https://www.tiktok.com/tiktokstudio/upload';
const privacyNames = {
  PUBLIC_TO_EVERYONE: /^(Все|Everyone)$/,
  MUTUAL_FOLLOW_FRIENDS: /^(Друзья|Friends)$/,
  FOLLOWER_OF_CREATOR: /^(Подписчики|Followers)$/,
  SELF_ONLY: /^(Только я|Only you|Only me)$/
};
const months = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const enMonths = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');
function localSchedule(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.getMinutes() % 5 || date.getSeconds() || date.getMilliseconds()) throw new Error('schedule_requires_five_minutes');
  return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`, month: date.getMonth(), year: date.getFullYear(), day: date.getDate() };
}
async function one(locator) {
  if (await locator.count() !== 1) throw new Error('studio_layout_changed');
  return locator;
}
async function confirmScheduled(page, item, prepared) {
  await page.waitForURL((url) => url.pathname.startsWith('/tiktokstudio/content'), { timeout: 45000 });
  const caption = page.getByText(item.settings.title, { exact: true });
  await caption.first().waitFor({ state: 'visible', timeout: 30000 });
  const date = new Date(item.scheduledAt);
  const dates = [prepared.date, date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }),
    date.toLocaleDateString('en-US', { day: 'numeric', month: 'short' })];
  const matches = await caption.evaluateAll((elements, target) => {
    const found = new Set();
    const normalize = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();
    for (const element of elements) {
      let parent = element;
      for (let level = 0; parent && level < 6; level++, parent = parent.parentElement) {
        if (parent.tagName === 'BODY' || parent.tagName === 'HTML') break;
        const text = normalize(parent.innerText || '');
        if (text.length > 1500) break;
        // Stop at the first timestamp associated with this caption. Climbing
        // into the entire list could match a different video's schedule.
        if (/\b\d{1,2}:\d{2}\b/.test(text)) {
          if (/запланирован|scheduled/i.test(text) && text.includes(target.time) && target.dates.some((d) => text.includes(normalize(d)))) found.add(parent);
          break;
        }
      }
    }
    return found.size;
  }, { time: prepared.time, dates });
  if (matches !== 1) throw new Error('studio_submission_needs_review');
  return { confirmed: true, account: prepared.account, scheduledAt: item.scheduledAt, url: page.url() };
}
async function checked(input, desired) {
  await one(input);
  if (await input.isChecked() === desired) return;
  if (await input.isDisabled()) throw new Error('studio_setting_unavailable');
  // Studio's switches hide the actual input. Its visible wrapper handles clicks.
  const wrappingLabel = input.locator('xpath=ancestor::label[1]');
  const id = await input.getAttribute('id');
  const linkedLabel = id ? input.page().locator(`label[for=${JSON.stringify(id)}]`) : null;
  if (await wrappingLabel.count() === 1) await wrappingLabel.click();
  else if (linkedLabel && await linkedLabel.count() === 1) await linkedLabel.click();
  else if (await input.getAttribute('role') === 'switch' || await input.evaluate(element =>
    !element.getClientRects().length || getComputedStyle(element).pointerEvents === 'none')) await input.locator('..').click();
  else await input.setChecked(desired);
  if (await input.isChecked() !== desired) throw new Error('studio_setting_not_applied');
}

async function waitForInputValue(input, value, signal, prefix = false) {
  const deadline = Date.now() + 10000;
  do {
    signal?.throwIfAborted();
    const actual = await input.inputValue();
    if (prefix ? actual.startsWith(value) : actual === value) return;
    await abortableSleep(100, signal);
  } while (Date.now() < deadline);
  throw new Error('studio_setting_not_applied');
}

// Selectors are based on the live Studio form, checked with a real upload on
// 2026-10-19. Every requested value is read back before the final Schedule click.
async function prepareStudioPage(page, item, signal) {
  const progress = { stage: 'upload' };
  try { return await fillStudioPage(page, item, signal, progress); }
  catch (error) {
    if (error.name === 'TimeoutError') throw new Error(`studio_${progress.stage}_timeout`);
    throw error;
  }
}

async function fillStudioPage(page, item, signal, progress) {
  const target = localSchedule(item.scheduledAt);
  signal?.throwIfAborted();
  await fs.access(item.filePath);
  await page.goto(UPLOAD, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="file"]').waitFor({ state: 'attached', timeout: 30000 });
  if (!new URL(page.url()).hostname.endsWith('.tiktok.com')) throw new Error('studio_login_required');
  const initialAccount = await readStudioAccount(page).catch(() => { throw new Error('studio_account_unavailable'); });
  if (initialAccount !== item.account) throw new Error('studio_account_mismatch');
  await one(page.locator('input[type="file"]'));
  await page.locator('input[type="file"]').setInputFiles(item.filePath);
  progress.stage = 'caption';
  const caption = page.locator('[contenteditable="true"][role="combobox"]');
  await caption.waitFor({ state: 'visible', timeout: 180000 });
  const prompt = page.getByRole('button', { name: /^(Отмена|Cancel)$/ });
  if (await page.getByText(/^(Включить автоматическую проверку контента\?|Turn on automatic content checks\?)$/).isVisible().catch(() => false)) {
    await one(prompt); await prompt.click();
  }
  signal?.throwIfAborted();
  await one(caption); await caption.fill(item.settings.title);
  progress.stage = 'schedule';
  await checked(page.locator('input[name="postSchedule"][value="schedule"]'), true);
  const inputs = page.locator('input[readonly]:visible');
  await inputs.first().waitFor({ state: 'visible' });
  const fields = await inputs.evaluateAll((elements) => elements.map((e, index) => ({ index, value: e.value })));
  const dateFields = fields.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.value));
  const timeFields = fields.filter((f) => /^\d{2}:\d{2}$/.test(f.value));
  if (dateFields.length !== 1 || timeFields.length !== 1) throw new Error('studio_layout_changed');
  const dateInput = inputs.nth(dateFields[0].index);
  const timeInput = inputs.nth(timeFields[0].index);
  progress.stage = 'date';
  if (await dateInput.inputValue() !== target.date) {
    await dateInput.locator('..').getByTestId('ArrowDown').click();
    const calendar = page.locator('.calendar-wrapper:visible');
    await calendar.waitFor({ state: 'visible' });
    let found = false;
    for (let attempt = 0; attempt < 24; attempt++) {
      signal?.throwIfAborted();
      const monthName = (await calendar.locator('.month-title').innerText()).toLowerCase();
      const year = Number(await calendar.locator('.year-title').innerText());
      const month = months.indexOf(monthName) >= 0 ? months.indexOf(monthName) : enMonths.indexOf(monthName);
      if (month < 0 || !year) throw new Error('studio_calendar_language_unsupported');
      if (month === target.month && year === target.year) { found = true; break; }
      const forward = target.year * 12 + target.month > year * 12 + month;
      await calendar.locator('.month-header-wrapper .arrow').nth(forward ? 1 : 0).click();
    }
    if (!found) throw new Error('studio_schedule_unavailable');
    const day = calendar.locator('span.day.valid').filter({ hasText: new RegExp(`^${target.day}$`) });
    if (await day.count() !== 1) throw new Error('studio_schedule_unavailable');
    await day.click();
  }
  progress.stage = 'time';
  await timeInput.locator('..').getByTestId('ArrowDown').click();
  await page.locator('.tiktok-timepicker-left:visible').filter({ hasText: new RegExp(`^${target.time.slice(0, 2)}$`) }).click();
  await waitForInputValue(timeInput, target.time.slice(0, 2), signal, true);
  await page.locator('.tiktok-timepicker-right:visible').filter({ hasText: new RegExp(`^${target.time.slice(3)}$`) }).click();
  await waitForInputValue(timeInput, target.time, signal);
  await page.getByText(/^(Когда опубликовать|When to post)$/).click();
  progress.stage = 'privacy';
  const privacy = page.getByRole('combobox').filter({ hasText: /^(Все|Друзья|Подписчики|Только я|Everyone|Friends|Followers|Only you|Only me)$/ });
  await one(privacy); await privacy.click();
  const choice = page.getByText(privacyNames[item.settings.privacy], { exact: true });
  const visibleChoices = choice.filter({ visible: true });
  // The current value is also present in the trigger. Select inside the open list.
  const listChoice = page.getByRole('list').getByText(privacyNames[item.settings.privacy], { exact: true });
  if (await listChoice.count() === 1) await listChoice.click();
  else if (await visibleChoices.count() === 1) await visibleChoices.click();
  else throw new Error('studio_privacy_unavailable');
  progress.stage = 'options';
  const more = page.getByText(/^(Показать больше|Show more)$/).filter({ visible: true });
  const less = page.getByText(/^(Показать меньше|Show less)$/).filter({ visible: true });
  if (await more.count() === 1) await more.click();
  // Studio may preserve the expanded state; never click the collapse control.
  await less.waitFor({ state: 'visible' });
  progress.stage = 'ai_label';
  const aiLabel = page.getByText(/^(Контент, сгенерированный ИИ|AI-generated content)$/).filter({ visible: true });
  await aiLabel.waitFor({ state: 'visible' });
  await one(aiLabel);
  // Locate the nearest setting row by its label, not a shared CSS class:
  // outer .container elements may contain several unrelated switches.
  const aiRow = aiLabel.locator('xpath=ancestor::*[.//input[@role="switch"]][1]');
  const aiSwitch = aiRow.locator('input[role="switch"]');
  await checked(aiSwitch, item.settings.aigc);
  progress.stage = 'options';
  const comment = page.getByLabel(/^(Комментарий|Comments?)$/);
  const reuse = page.getByLabel(/^(Повторное использование контента|Reuse of content|Allow reuse of content)$/);
  await checked(comment, item.settings.comment);
  if (item.settings.reuse && await reuse.isDisabled() && !await reuse.isChecked()) throw new Error('studio_reuse_unavailable');
  await checked(reuse, item.settings.reuse);
  await checked(page.locator('[data-e2e="disclose_content_container"] input[role="switch"]'), false);
  const account = await readStudioAccount(page);
  if (!account || (item.account && account !== item.account)) throw new Error('studio_account_mismatch');
  signal?.throwIfAborted();
  const readback = { title: await caption.innerText(), date: await dateInput.inputValue(), time: await timeInput.inputValue(),
    comment: await comment.isChecked(), reuse: await reuse.isChecked(), aigc: await aiSwitch.isChecked(),
    privacy: await privacy.innerText(), account };
  if (readback.title !== item.settings.title || readback.date !== target.date || readback.time !== target.time ||
    !privacyNames[item.settings.privacy]?.test(readback.privacy.trim()) || readback.comment !== item.settings.comment ||
    readback.reuse !== item.settings.reuse || readback.aigc !== item.settings.aigc) throw new Error('studio_settings_not_applied');
  return readback;
}

// Studio exposes the signed-in user in its server context before a video is
// selected. The visible username only exists later in the upload composer.
function studioIdentity() {
  if (location.origin !== 'https://www.tiktok.com' || !location.pathname.startsWith('/tiktokstudio')) return '';
  const normalize = value => {
    if (typeof value !== 'string') return '';
    const username = value.trim().replace(/^@/, '');
    return /^[a-zA-Z0-9_.]{2,64}$/.test(username) ? username : '';
  };
  const visible = [...document.querySelectorAll('.username-container .username')]
    .filter(node => node.getClientRects().length).map(node => normalize(node.textContent)).filter(Boolean);
  if (new Set(visible).size === 1) return visible[0];
  if (visible.length) return '';
  const source = document.getElementById('__Creator_Center_Context__')?.textContent;
  if (!source) return '';
  let data;
  try { data = JSON.parse(source); }
  catch {
    const decoder = document.createElement('textarea'); decoder.innerHTML = source;
    try { data = JSON.parse(decoder.value); } catch { return ''; }
  }
  return normalize(data?.commonAppContext?.user?.uniqueId);
}

async function readStudioAccount(page) {
  const result = await page.waitForFunction(studioIdentity, null, { timeout: 8000 });
  try { return await result.jsonValue(); }
  finally { await result.dispose(); }
}

function createProfileDriver({ profilePath, launch = (profile, options) => chromium.launchPersistentContext(profile, options) }) {
  let context;
  let page;
  let opening;
  async function open() {
    if (opening) return opening;
    opening = (async () => {
      if (!context) {
        try { context = await launch(profilePath, { channel: 'msedge', headless: false, viewport: null,
          chromiumSandbox: true, timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone }); }
        catch { throw new Error('studio_edge_unavailable'); }
        context.on('close', () => { context = null; page = null; });
      }
      if (!page || page.isClosed()) {
        page = await context.newPage(); page.setDefaultTimeout(20000);
        await page.goto(UPLOAD, { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      await page.bringToFront();
      return { open: true };
    })().finally(() => { opening = null; });
    return opening;
  }
  return {
    open,
    async account() {
      // A login may finish in a different tab. Read a fresh Studio page in the
      // same context so all sign-in tabs share cookies, without changing them.
      let probe;
      try {
        if (!context) await open();
        probe = await context.newPage();
        await probe.goto(UPLOAD, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return await readStudioAccount(probe);
      } catch { return null; }
      finally { await probe?.close().catch(() => {}); }
    },
    async upload(item, signal) {
      await open();
      const activePage = page;
      const abort = () => { activePage.close().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const prepared = await prepareStudioPage(activePage, item, signal);
        signal.throwIfAborted();
        if (Date.parse(item.scheduledAt) < Date.now() + 15 * 60000) throw new Error('studio_schedule_too_soon');
        const button = activePage.getByRole('button', { name: /^(Запланировать|Schedule)$/ });
        await one(button);
        if (!await button.isEnabled()) throw new Error('studio_schedule_button_disabled');
        await button.click();
        // An ambiguous response is never retried automatically. The user can
        // inspect the browser and reconcile it from the queue.
        try {
          return await confirmScheduled(activePage, item, prepared);
        } catch { throw new Error('studio_submission_needs_review'); }
      } catch (error) {
        if (signal.aborted) throw new Error('studio_interrupted_check_status');
        throw new Error(/^[a-z_]{1,100}$/.test(error.message) ? error.message : 'studio_needs_attention');
      } finally { signal.removeEventListener('abort', abort); }
    },
    async close() { await context?.close(); }
  };
}

// Existing users keep their original browser profile. Additional accounts get
// separate persistent profiles; only public usernames and profile IDs are stored here.
function createStudioDriver({ profilePath, launch }) {
  const registryPath = path.join(path.dirname(profilePath), 'tiktok-studio-accounts.json');
  const drivers = new Map();
  let entries;
  let serial = Promise.resolve();
  let uploading = false;
  const transact = (fn) => {
    const operation = serial.then(async () => {
      if (!entries) {
        try {
          const saved = JSON.parse(await fs.readFile(registryPath, 'utf8'));
          if (!Array.isArray(saved) || saved.some(e => !e ||
            !/^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(e.id) ||
            (e.username !== '' && !/^[a-zA-Z0-9_.]{2,64}$/.test(e.username)))) throw new Error();
          entries = saved;
        } catch (error) {
          if (error.code !== 'ENOENT') throw new Error('studio_accounts_unreadable');
          entries = [];
        }
        if (!entries.some(e => e.id === 'default')) entries.unshift({ id: 'default', username: '' });
      }
      return fn();
    });
    serial = operation.catch(() => {});
    return operation;
  };
  const driver = (entry) => {
    if (!drivers.has(entry.id)) drivers.set(entry.id, createProfileDriver({
      profilePath: entry.id === 'default' ? profilePath : path.join(path.dirname(profilePath), 'tiktok-studio-accounts', entry.id), launch
    }));
    return drivers.get(entry.id);
  };
  async function save() {
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(`${registryPath}.tmp`, JSON.stringify(entries, null, 2), { mode: 0o600 });
    await fs.rename(`${registryPath}.tmp`, registryPath);
  }
  const accountList = () => {
    const seen = new Set();
    return structuredClone(entries.filter(entry => {
      const key = entry.username.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }));
  };
  async function detectAccounts() {
    let detected = false;
    for (const entry of entries) {
      const username = await driver(entry).account();
      if (username) { entry.username = username; detected = true; }
    }
    await save();
    return detected;
  }
  return {
    accounts: () => transact(async () => accountList()),
    open: (id = 'default') => transact(async () => {
      if (uploading) throw new Error('operation_in_progress');
      const entry = entries.find(e => e.id === id);
      if (!entry) throw new Error('studio_account_unavailable');
      return driver(entry).open();
    }),
    addAccount: () => transact(async () => {
      if (uploading) throw new Error('operation_in_progress');
      // Reuse an unfinished sign-in instead of creating unused profiles on each click.
      let entry = entries.find(e => !e.username);
      if (!entry) { entry = { id: randomUUID(), username: '' }; entries.push(entry); await save(); }
      await driver(entry).open();
      return accountList();
    }),
    refreshAccounts: () => transact(async () => {
      if (uploading) throw new Error('operation_in_progress');
      const detected = await detectAccounts();
      if (!detected) throw new Error('studio_account_unavailable');
      return accountList();
    }),
    upload: async (item, signal) => {
      const target = await transact(async () => {
        if (uploading) throw new Error('operation_in_progress');
        const entry = entries.find(e => e.username === item.account) || entries.find(e => e.id === 'default' && !e.username);
        if (!entry) throw new Error('studio_account_unavailable');
        uploading = true;
        return driver(entry);
      });
      try { return await target.upload(item, signal); }
      finally { uploading = false; }
    },
    async close() { await serial; await Promise.all([...drivers.values()].map(d => d.close())); }
  };
}

module.exports = { createStudioDriver, readStudioAccount, prepareStudioPage, confirmScheduled, localSchedule };
