const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { normalizeHashtagPreset, composeCaption, captionText } = require('./tiktok-captions');

const PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];
const defaults = () => ({ firstAt: '', intervalMinutes: 60, title: '{name}', privacy: '', comment: false,
  reuse: false, aigc: false, account: '', autoUpload: false, hashtagPresetId: '' });

function normalizeSettings(input) {
  if (typeof input?.title !== 'string' || input.title.length > 2200) throw new Error('invalid_caption');
  if (input.privacy && !PRIVACY.includes(input.privacy)) throw new Error('privacy_level_option_mismatch');
  return { title: input.title, privacy: input.privacy || '', comment: input.comment === true,
    reuse: input.reuse === true, aigc: input.aigc === true };
}

function dateValue(value, optional = false) {
  if (optional && !value) return '';
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('invalid_schedule_time');
  return new Date(value).toISOString();
}

function createQueueStorage(file) {
  return {
    async read() {
      try { return JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw new Error('queue_unreadable'); }
    },
    async write(value) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    }
  };
}

// The queue stores plans, not publication receipts. A remote schedule is never
// marked confirmed until a Studio adapter returns a verified receipt.
function createTikTokQueue({ storage, upload, notify = () => {}, now = Date.now }) {
  let state;
  let serial = Promise.resolve();
  let worker;
  let controller;
  let kickRequested = false;
  let stopped = false;
  function validateSchedule(scheduledAt) {
    const time = Date.parse(scheduledAt);
    if (!Number.isFinite(time) || time < now() + 15 * 60000) throw new Error('studio_schedule_too_soon');
    if (time % (5 * 60000)) throw new Error('schedule_requires_five_minutes');
  }
  function validateItem(item) {
    if (!/^[a-zA-Z0-9_.]{2,64}$/.test(item.account || '')) throw new Error('studio_account_required');
    if (!item.settings.privacy) throw new Error('privacy_level_option_mismatch');
    validateSchedule(item.scheduledAt);
  }
  const transact = (fn, save = true) => {
    const operation = serial.then(async () => {
      if (!state) {
        const saved = await storage.read();
        const loaded = saved || { version: 1, template: defaults(), items: [], paused: false };
        if (loaded.version !== 1 || !Array.isArray(loaded.items)) throw new Error('queue_unreadable');
        loaded.template = { ...defaults(), ...loaded.template };
        loaded.captionPresets ||= []; loaded.hashtagPresets ||= [];
        loaded.autoRemoveUploaded = loaded.autoRemoveUploaded === true;
        loaded.completedUploads ||= [];
        if (!Array.isArray(loaded.completedUploads)) throw new Error('queue_unreadable');
        if (!Array.isArray(loaded.captionPresets) || !Array.isArray(loaded.hashtagPresets)) throw new Error('queue_unreadable');
        let interrupted = false;
        for (const item of loaded.items) {
          if (['uploading', 'ready'].includes(item.status)) { item.status = 'needs_attention'; item.error = 'studio_interrupted_check_status'; interrupted = true; }
        }
        if (interrupted) { loaded.paused = true; await storage.write(loaded); }
        state = loaded;
      }
      // Work on a copy: failed validation/storage must not partially mutate plans.
      const next = structuredClone(state);
      const result = await fn(next);
      if (save) { await storage.write(next); state = next; try { notify(); } catch {} }
      return result === undefined ? structuredClone(state) : result;
    });
    serial = operation.catch(() => {});
    return operation;
  };
  function start() {
    if (stopped) return;
    if (worker) { kickRequested = true; return; }
    worker = (async () => {
      while (!stopped) {
        const item = await transact((next) => {
          if (next.paused || next.items.some((i) => i.status === 'needs_attention')) return null;
          const candidate = next.items.find((i) => i.status === 'ready');
          if (!candidate) return null;
          candidate.status = 'uploading';
          delete candidate.accountCheck;
          return structuredClone(candidate);
        });
        if (!item) return;
        controller = new AbortController();
        try {
          if (stopped) throw new Error('operation_cancelled');
          validateItem(item);
          const receipt = await upload(item, controller.signal);
          if (receipt?.confirmed !== true) throw new Error('studio_submission_needs_review');
          await transact((next) => {
            const current = next.items.find((i) => i.id === item.id);
            current.status = 'scheduled'; current.receipt = receipt;
            if (next.autoRemoveUploaded) {
              // Retain only deduplication/slot metadata after removing the card.
              // A repeated renderer notification must not upload this file again.
              next.completedUploads.push({ filePath: current.filePath, scheduledAt: current.scheduledAt });
              next.items = next.items.filter(entry => entry.id !== current.id);
            }
          });
        } catch (error) {
          await transact((next) => {
            const current = next.items.find((i) => i.id === item.id);
            current.status = 'needs_attention';
            current.error = /^[a-z_]{1,100}$/.test(error.message) ? error.message : 'studio_needs_attention';
            const check = error.accountCheck;
            if (current.error === 'studio_account_mismatch' && check &&
              /^[a-zA-Z0-9_.]{2,64}$/.test(check.expected) && /^(?:[a-zA-Z0-9_.]{2,64})?$/.test(check.actual) &&
              ['before_upload', 'before_submit'].includes(check.phase)) {
              current.accountCheck = { expected: check.expected, actual: check.actual, phase: check.phase };
            }
            next.paused = true;
          });
          return;
        } finally { controller = null; }
      }
    })().catch(() => {}).finally(() => {
      worker = null;
      if (kickRequested) { kickRequested = false; start(); }
    });
  }
  function hashtagPreset(next, id) {
    if (!id) return undefined;
    const preset = next.hashtagPresets.find(entry => entry.id === id);
    if (!preset) throw new Error('hashtag_preset_not_found');
    return preset;
  }
  function presetName(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('invalid_preset_name');
    return value.trim();
  }
  function savePreset(list, input, fields) {
    const existing = input.id ? list.findIndex(entry => entry.id === input.id) : -1;
    if (input.id && existing < 0) throw new Error('preset_not_found');
    const name = presetName(input.name);
    if (list.some((entry, index) => index !== existing && entry.name.toLowerCase() === name.toLowerCase())) throw new Error('preset_name_exists');
    const preset = { id: input.id || randomUUID(), name, ...fields };
    if (existing < 0) list.push(preset); else list[existing] = preset;
  }
  return {
    get() { return transact(() => undefined, false); },
    preferences(input) { return transact(next => {
      if (typeof input?.autoRemoveUploaded !== 'boolean') throw new Error('invalid_queue_preferences');
      next.autoRemoveUploaded = input.autoRemoveUploaded;
    }); },
    previewCaption(input) { return transact(next => composeCaption({
      title: input?.title, fileName: input?.fileName, number: input?.number,
      hashtagPreset: hashtagPreset(next, input?.hashtagPresetId)
    }), false); },
    saveCaptionPreset(input) { return transact(next => {
      hashtagPreset(next, input?.hashtagPresetId);
      savePreset(next.captionPresets, input, { title: captionText(input.title), hashtagPresetId: input.hashtagPresetId || '' });
    }); },
    saveHashtagPreset(input) { return transact(next => {
      savePreset(next.hashtagPresets, input, normalizeHashtagPreset(input));
    }); },
    removeCaptionPreset(id) { return transact(next => { next.captionPresets = next.captionPresets.filter(entry => entry.id !== id); }); },
    removeHashtagPreset(id) { return transact(next => {
      next.hashtagPresets = next.hashtagPresets.filter(entry => entry.id !== id);
      if (next.template.hashtagPresetId === id) next.template.hashtagPresetId = '';
      for (const preset of next.captionPresets) if (preset.hashtagPresetId === id) preset.hashtagPresetId = '';
    }); },
    template(input) { return transact((next) => {
      const interval = Number(input?.intervalMinutes);
      if (!Number.isInteger(interval) || interval < 5 || interval > 10080 || interval % 5) throw new Error('invalid_schedule_interval');
      const account = String(input.account || '').trim().replace(/^@/, '');
      if (account && !/^[a-zA-Z0-9_.]{2,64}$/.test(account)) throw new Error('studio_account_required');
      hashtagPreset(next, input.hashtagPresetId);
      const template = { ...normalizeSettings(input), hashtagPresetId: input.hashtagPresetId || '', account, autoUpload: input.autoUpload === true,
        firstAt: dateValue(input.firstAt, true), intervalMinutes: interval };
      if (template.autoUpload) validateItem({ account, settings: template, scheduledAt: template.firstAt });
      if (input.applySchedule === true) {
        validateSchedule(template.firstAt);
        const drafts = next.items.filter(item => item.status === 'draft');
        if (!drafts.length) throw new Error('queue_no_drafts');
        const occupied = new Set([...next.items.filter(item => item.status !== 'draft'), ...next.completedUploads]
          .map(item => Date.parse(item.scheduledAt)).filter(Number.isFinite));
        let time = Date.parse(template.firstAt);
        for (const item of drafts) {
          while (occupied.has(time)) time += interval * 60000;
          item.scheduledAt = new Date(time).toISOString();
          if (['studio_schedule_too_soon', 'schedule_requires_five_minutes', 'invalid_schedule_time', 'schedule_time_in_past'].includes(item.error)) delete item.error;
          time += interval * 60000;
        }
      }
      next.template = template;
    }); },
    addGenerated(files) { return transact((next) => {
      if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || !path.isAbsolute(file))) throw new Error('invalid_video_file');
      const knownItems = [...next.items, ...next.completedUploads];
      const existing = new Set(knownItems.map((item) => path.resolve(item.filePath).toLowerCase()));
      let nextTime = next.template.firstAt ? Date.parse(next.template.firstAt) : null;
      if (nextTime !== null) {
        for (const item of knownItems) {
          if (item.scheduledAt) nextTime = Math.max(nextTime, Date.parse(item.scheduledAt) + next.template.intervalMinutes * 60000);
        }
      }
      for (const filePath of files) {
        const key = path.resolve(filePath).toLowerCase();
        if (existing.has(key)) continue;
        existing.add(key);
        const name = path.basename(filePath, path.extname(filePath));
        const title = composeCaption({ title: next.template.title, fileName: filePath, number: next.items.length + next.completedUploads.length + 1,
          hashtagPreset: hashtagPreset(next, next.template.hashtagPresetId) });
        const item = { id: randomUUID(), filePath, name, settings: normalizeSettings({ ...next.template, title }), account: next.template.account || '',
          scheduledAt: nextTime === null ? '' : new Date(nextTime).toISOString(), status: 'draft', createdAt: new Date(now()).toISOString() };
        if (next.template.autoUpload) {
          try { validateItem(item); item.status = 'ready'; }
          catch (error) { item.error = error.message; }
        }
        next.items.push(item);
        if (nextTime !== null) nextTime += next.template.intervalMinutes * 60000;
      }
    }).then((result) => { if (result.template.autoUpload) start(); return result; }); },
    update(input) { return transact((next) => {
      const item = next.items.find((entry) => entry.id === input?.id);
      if (!item || item.status !== 'draft') throw new Error('queue_item_not_editable');
      const settings = normalizeSettings(input.settings);
      const scheduledAt = dateValue(input.scheduledAt, true);
      if (scheduledAt && Date.parse(scheduledAt) <= now()) throw new Error('schedule_time_in_past');
      item.settings = settings; item.scheduledAt = scheduledAt;
      item.account = String(input.account || '').trim().replace(/^@/, '');
      if (item.account && !/^[a-zA-Z0-9_.]{2,64}$/.test(item.account)) throw new Error('studio_account_required');
      delete item.error;
      delete item.accountCheck;
    }); },
    remove(id) { return transact((next) => {
      const item = next.items.find((entry) => entry.id === id);
      if (!item || !['draft', 'ready', 'scheduled', 'needs_attention'].includes(item.status)) throw new Error('queue_item_not_editable');
      next.items = next.items.filter((entry) => entry.id !== id);
    }); },
    send(input) { return transact((next) => {
      if (input?.consent !== true || !Array.isArray(input.ids) || !input.ids.length) throw new Error('consent_required');
      const items = input.ids.map((id) => next.items.find((item) => item.id === id));
      if (items.some((item) => !item || item.status !== 'draft')) throw new Error('queue_item_not_editable');
      items.forEach(validateItem);
      items.forEach((item) => { item.status = 'ready'; delete item.error; delete item.accountCheck; });
      next.paused = false;
    }).then((result) => { start(); return result; }); },
    pause() {
      controller?.abort();
      return transact((next) => { next.paused = true; controller?.abort(); });
    },
    resume() { return transact((next) => { next.paused = false; }).then((result) => { start(); return result; }); },
    reconcile(input) { return transact((next) => {
      const item = next.items.find((i) => i.id === input?.id);
      if (item?.status !== 'needs_attention' || !['scheduled', 'draft'].includes(input.status)) throw new Error('queue_item_not_editable');
      item.status = input.status; item.reconciledAt = new Date(now()).toISOString(); delete item.error; delete item.accountCheck;
    }); },
    async idle() { await worker; },
    shutdown() { stopped = true; controller?.abort(); }
  };
}

module.exports = { createTikTokQueue, createQueueStorage, normalizeSettings };
