const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTikTokQueue } = require('../app/services/tiktok-queue');
const { localSchedule } = require('../app/services/tiktok-studio');
const now = Date.parse('2026-10-19T09:00:00Z');
const template = { firstAt: '2026-10-20T12:00:00Z', intervalMinutes: 60, title: '{n}. {name} #test',
  privacy: 'PUBLIC_TO_EVERYONE', account: 'creator', comment: false, reuse: false, aigc: true };
const clip = (name) => path.resolve('test-output', `${name}.mp4`);
function harness(options = {}) {
  let saved = options.saved || null;
  let failSave = false;
  const sent = [];
  const storage = { read: async () => structuredClone(saved), write: async (value) => {
    if (failSave) throw new Error('disk_full'); saved = structuredClone(value);
  } };
  const queue = createTikTokQueue({ storage, now: () => now, upload: async (item, signal) => {
    sent.push(structuredClone(item));
    if (options.upload) return options.upload(item, signal);
    return { confirmed: true, scheduledAt: item.scheduledAt };
  } });
  return { queue, sent, saved: () => structuredClone(saved), storage, failSave: () => { failSave = true; } };
}
test('generated files receive separate slots and metadata; duplicate notifications are harmless', async () => {
  const h = harness(); await h.queue.template(template);
  await h.queue.addGenerated([clip('one'), clip('two')]);
  const result = await h.queue.addGenerated([clip('one'), clip('three')]);
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].settings.title, '1. one #test');
  assert.equal(result.items[1].scheduledAt, '2026-10-20T13:00:00.000Z');
  assert.equal(result.items[2].scheduledAt, '2026-10-20T14:00:00.000Z');
  assert.equal(h.sent.length, 0);
});
test('each clip keeps its own time and settings across a restart', async () => {
  const h = harness(); await h.queue.template(template);
  const state = await h.queue.addGenerated([clip('one'), clip('two')]);
  await h.queue.update({ id: state.items[0].id, account: 'creator', scheduledAt: '2026-10-21T15:30:00+03:00',
    settings: { title: 'Individual caption', privacy: 'SELF_ONLY', comment: true, reuse: false, aigc: false } });
  const restarted = createTikTokQueue({ storage: h.storage, now: () => now });
  const actual = await restarted.get();
  assert.equal(actual.items[0].scheduledAt, '2026-10-21T12:30:00.000Z');
  assert.equal(actual.items[0].settings.comment, true);
  assert.equal(actual.items[1].settings.comment, false);
  assert.equal(actual.items[1].scheduledAt, '2026-10-20T13:00:00.000Z');
});

test('scheduled clips can be removed locally without affecting other plans or causing another upload', async () => {
  const h = harness(); await h.queue.template(template);
  const state = await h.queue.addGenerated([clip('one'), clip('two')]);
  await h.queue.send({ ids: [state.items[0].id], consent: true }); await h.queue.idle();
  const remaining = (await h.queue.get()).items[1];
  const result = await h.queue.remove(state.items[0].id);
  assert.deepEqual(result.items, [remaining]);
  assert.equal(h.sent.length, 1);
  const restarted = createTikTokQueue({ storage: h.storage });
  assert.deepEqual((await restarted.get()).items, [remaining]);
});

test('removal cannot race with an active upload, but waiting clips can be removed', async () => {
  let started, release;
  const begun = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ upload: async () => { started(); await gate; return { confirmed: true }; } });
  await h.queue.template(template);
  const state = await h.queue.addGenerated([clip('one'), clip('two')]);
  await h.queue.send({ ids: state.items.map(item => item.id), consent: true });
  await begun;
  await assert.rejects(h.queue.remove(state.items[0].id), /queue_item_not_editable/);
  await h.queue.remove(state.items[1].id);
  release(); await h.queue.idle();
  assert.equal(h.sent.length, 1);
  assert.deepEqual((await h.queue.get()).items.map(item => item.status), ['scheduled']);
});

test('new clips enter the plan even when it contains a scheduled clip', async () => {
  const h = harness(); await h.queue.template(template);
  const state = await h.queue.addGenerated([clip('one')]);
  await h.queue.send({ ids: [state.items[0].id], consent: true }); await h.queue.idle();
  const actual = await h.queue.addGenerated([clip('two'), clip('three')]);
  assert.deepEqual(actual.items.map(item => item.status), ['scheduled', 'draft', 'draft']);
});

test('confirmed receipts preserve TikTok restriction notices across restart', async () => {
  const warnings = ['studio_reuse_disabled_by_tiktok'];
  const h = harness({ upload: async () => ({ confirmed: true, warnings }) });
  await h.queue.template({ ...template, reuse: true });
  const state = await h.queue.addGenerated([clip('restricted')]);
  await h.queue.send({ ids: [state.items[0].id], consent: true }); await h.queue.idle();
  const restarted = createTikTokQueue({ storage: h.storage });
  const item = (await restarted.get()).items[0];
  assert.equal(item.status, 'scheduled');
  assert.equal(item.settings.reuse, true);
  assert.deepEqual(item.receipt.warnings, warnings);
});

test('account mismatch diagnostics survive restart and clear on return to draft', async () => {
  const accountCheck = { expected: 'creator', actual: 'another_creator', phase: 'before_submit' };
  const h = harness({ upload: async () => { throw Object.assign(new Error('studio_account_mismatch'), { accountCheck }); } });
  await h.queue.template(template);
  const state = await h.queue.addGenerated([clip('mismatch')]);
  await h.queue.send({ ids: [state.items[0].id], consent: true }); await h.queue.idle();
  const restarted = createTikTokQueue({ storage: h.storage });
  assert.deepEqual((await restarted.get()).items[0].accountCheck, accountCheck);
  const reconciled = await restarted.reconcile({ id: state.items[0].id, status: 'draft' });
  assert.equal(reconciled.items[0].accountCheck, undefined);
});
test('consent is required and scheduled jobs are uploaded now, not at publication time', async () => {
  const h = harness(); await h.queue.template(template);
  const state = await h.queue.addGenerated([clip('one'), clip('two')]);
  const ids = state.items.map((i) => i.id);
  await assert.rejects(h.queue.send({ ids, consent: false }), /consent_required/);
  await h.queue.send({ ids, consent: true }); await h.queue.idle();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].scheduledAt, '2026-10-20T13:00:00.000Z');
  assert.equal((await h.queue.get()).items.every((i) => i.status === 'scheduled'), true);
});
test('opted-in defaults automatically enqueue newly generated videos', async () => {
  const h = harness(); await h.queue.template({ ...template, autoUpload: true });
  await h.queue.addGenerated([clip('one')]); await h.queue.idle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].settings.comment, false);
});
test('an ambiguous upload pauses the queue and blocks automatic duplicates', async () => {
  const h = harness({ upload: async () => { throw new Error('studio_submission_needs_review'); } });
  await h.queue.template(template);
  const state = await h.queue.addGenerated([clip('one'), clip('two')]);
  await h.queue.send({ ids: state.items.map((i) => i.id), consent: true }); await h.queue.idle();
  const actual = await h.queue.get();
  assert.equal(actual.items[0].status, 'needs_attention');
  assert.equal(actual.items[1].status, 'ready');
  assert.equal(actual.paused, true);
  await h.queue.resume(); await h.queue.idle();
  assert.equal(h.sent.length, 1);
  await h.queue.reconcile({ id: actual.items[0].id, status: 'scheduled' });
  assert.equal((await h.queue.get()).items[0].status, 'scheduled');
});
test('restart pauses unfinished jobs and never silently replays them', async () => {
  const h = harness({ saved: { version: 1, template, items: [{ id: 'old', status: 'uploading' }] } });
  const state = await h.queue.get();
  assert.equal(state.items[0].status, 'needs_attention');
  assert.equal(state.paused, true);
  assert.equal(h.sent.length, 0);
});

test('invalid stored queues stay blocked on every read and mutation', async () => {
  const h = harness({ saved: { version: 2, template, items: [] } });
  await assert.rejects(h.queue.get(), /queue_unreadable/);
  await assert.rejects(h.queue.get(), /queue_unreadable/);
  await assert.rejects(h.queue.template(template), /queue_unreadable/);
  assert.equal(h.saved().version, 2);
});

test('restart recovery retries persistence after a storage failure', async () => {
  const original = { version: 1, template, items: [{ id: 'old', status: 'uploading' }] };
  let saved = structuredClone(original);
  let writes = 0;
  const queue = createTikTokQueue({ storage: {
    read: async () => structuredClone(saved),
    write: async value => {
      if (++writes === 1) throw new Error('disk_full');
      saved = structuredClone(value);
    }
  } });
  await assert.rejects(queue.get(), /disk_full/);
  await queue.get();
  assert.equal(saved.items[0].status, 'needs_attention');
  assert.equal(saved.paused, true);
});

test('pause aborts an upload whose claim was still being saved', async () => {
  let releaseClaim, claimed, releaseUpload;
  const claimStarted = new Promise(resolve => { claimed = resolve; });
  const claimGate = new Promise(resolve => { releaseClaim = resolve; });
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  let uploadSignal;
  const h = harness({ upload: async (_item, signal) => {
    uploadSignal = signal;
    await uploadGate;
    if (signal.aborted) throw new Error('operation_cancelled');
    return { confirmed: true };
  } });
  const write = h.storage.write;
  h.storage.write = async value => {
    if (value.items.some(item => item.status === 'uploading')) {
      claimed(); await claimGate;
    }
    return write(value);
  };
  await h.queue.template(template);
  const state = await h.queue.addGenerated([clip('one')]);
  await h.queue.send({ ids: [state.items[0].id], consent: true });
  await claimStarted;
  const paused = h.queue.pause();
  releaseClaim();
  await paused;
  releaseUpload();
  await h.queue.idle();
  assert.equal(uploadSignal?.aborted, true);
  assert.equal((await h.queue.get()).items[0].status, 'needs_attention');
});

test('shutdown prevents uploads after a pending claim is saved', async () => {
  let releaseClaim, claimed;
  const claimStarted = new Promise(resolve => { claimed = resolve; });
  const claimGate = new Promise(resolve => { releaseClaim = resolve; });
  const h = harness();
  const write = h.storage.write;
  h.storage.write = async value => {
    if (value.items.some(item => item.status === 'uploading')) {
      claimed(); await claimGate;
    }
    return write(value);
  };
  await h.queue.template(template);
  const state = await h.queue.addGenerated([clip('one')]);
  await h.queue.send({ ids: [state.items[0].id], consent: true });
  await claimStarted;
  h.queue.shutdown();
  releaseClaim();
  await h.queue.idle();
  await h.queue.resume();
  await h.queue.idle();
  assert.equal(h.sent.length, 0);
  assert.equal((await h.queue.get()).items[0].status, 'needs_attention');
});
test('invalid batch validation leaves all clips as drafts', async () => {
  const h = harness(); await h.queue.template(template);
  const state = await h.queue.addGenerated([clip('one'), clip('two')]);
  await h.queue.update({ id: state.items[1].id, settings: state.items[1].settings, account: '', scheduledAt: state.items[1].scheduledAt });
  await assert.rejects(h.queue.send({ ids: state.items.map((i) => i.id), consent: true }), /studio_account_required/);
  assert.equal((await h.queue.get()).items.every((i) => i.status === 'draft'), true);
});
test('failed storage writes do not overwrite the in-memory plan', async () => {
  const h = harness(); await h.queue.template(template); h.failSave();
  await assert.rejects(h.queue.template({ ...template, title: 'Changed' }), /disk_full/);
  assert.equal((await h.queue.get()).template.title, template.title);
});
test('invalid or past times cannot be enabled for automatic upload', async () => {
  const h = harness();
  await assert.rejects(h.queue.template({ ...template, firstAt: '2026-10-19T08:00:00Z', autoUpload: true }), /studio_schedule_too_soon/);
  await assert.rejects(h.queue.template({ ...template, firstAt: '2026-10-20T12:03:00Z', autoUpload: true }), /schedule_requires_five_minutes/);
  assert.throws(() => localSchedule('2026-10-20T12:03:00Z'), /schedule_requires_five_minutes/);
});


test('saved caption and hashtag presets compose new clips once and survive restart', async () => {
  const h = harness();
  let state = await h.queue.saveHashtagPreset({ name: 'Кино', tags: '#кино #сериал #история #movie', minCount: 2, maxCount: 3 });
  const hashtagPresetId = state.hashtagPresets[0].id;
  state = await h.queue.saveCaptionPreset({ name: 'Истории', title: 'Смотри {name} {hashtags}', hashtagPresetId });
  const preset = state.captionPresets[0];
  await h.queue.template({ ...template, title: preset.title, hashtagPresetId });
  state = await h.queue.addGenerated([clip('one'), clip('two')]);
  const titles = state.items.map(item => item.settings.title);
  for (let index = 0; index < titles.length; index++) {
    assert.ok(titles[index].startsWith(`Смотри ${index ? 'two' : 'one'} `));
    const tags = titles[index].match(/#[^ ]+/g);
    assert.ok(tags.length >= 2 && tags.length <= 3);
    assert.equal(new Set(tags).size, tags.length);
  }
  const restarted = createTikTokQueue({ storage: h.storage, now: () => now, upload: async item => {
    assert.equal(item.settings.title, titles[state.items.findIndex(entry => entry.id === item.id)]);
    return { confirmed: true };
  } });
  assert.deepEqual((await restarted.get()).items.map(item => item.settings.title), titles);
  await restarted.send({ ids: state.items.map(item => item.id), consent: true }); await restarted.idle();
  assert.deepEqual((await restarted.get()).items.map(item => item.settings.title), titles);
});

test('preview does not change saved captions, and deleting presets preserves existing clips', async () => {
  const h = harness();
  let state = await h.queue.saveHashtagPreset({ name: 'Теги', tags: '#one #two', minCount: 1, maxCount: 2 });
  const id = state.hashtagPresets[0].id;
  state = await h.queue.saveCaptionPreset({ name: 'Шаблон', title: '{name} {hashtags}', hashtagPresetId: id });
  await h.queue.template({ ...template, hashtagPresetId: id });
  state = await h.queue.addGenerated([clip('one')]);
  const before = structuredClone(state.items);
  await h.queue.previewCaption({ title: '{filename} {hashtags}', fileName: 'preview.mp4', number: 1, hashtagPresetId: id });
  assert.deepEqual((await h.queue.get()).items, before);
  state = await h.queue.removeHashtagPreset(id);
  assert.equal(state.template.hashtagPresetId, '');
  assert.equal(state.captionPresets[0].hashtagPresetId, '');
  assert.deepEqual(state.items, before);
});

test('preset validation and failed writes leave the saved library unchanged', async () => {
  const h = harness();
  let state = await h.queue.saveHashtagPreset({ name: 'Test', tags: '#one #two', minCount: 1, maxCount: 2 });
  await assert.rejects(h.queue.saveHashtagPreset({ name: 'test', tags: '#three', minCount: 1, maxCount: 2 }), /preset_name_exists/);
  await assert.rejects(h.queue.template({ ...template, hashtagPresetId: 'missing' }), /hashtag_preset_not_found/);
  h.failSave();
  await assert.rejects(h.queue.saveHashtagPreset({ id: state.hashtagPresets[0].id, name: 'Changed', tags: '#three', minCount: 1, maxCount: 1 }), /disk_full/);
  assert.deepEqual((await h.queue.get()).hashtagPresets, state.hashtagPresets);
});
