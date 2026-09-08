// ===== STATE =====
let settings = { proxy: null, customProviders: [], customModels: [], transcriptionChain: [], analysisChain: [] };
let stats = { totalVideos: 0, totalRenderTimeMs: 0, lastRun: null, stageTimesMs: {} };
let sourcePath = null;
let bgFolderPath = null;
let outputFolderPath = null;
let isProcessing = false;
let cancelRequested = false;
let progressCleanup = null;
let processStartTime = null;
let etaInterval = null;
let uiLang = 'en';
let subtitlePreviewInterval = null;
let subtitlePreviewChunks = [];
let subtitlePreviewChunkIndex = 0;
let bannerAspect = null;
let bannerThumbnail = null;
let etaEstimator = null;

// ===== SMART ETA ESTIMATOR =====
// Stage-weighted progress model with per-stage timing history, live upload
// speed sampling, monotonic smoothed percent and a rate-limited ETA readout.
// Weights (share of total wall time per stage; defaults refined from stats).
const STAGE_WEIGHTS = {
  extract: 0.10,
  compress: 0.08,
  transcribe: 0.28,
  analyze: 0.10,
  scenes: 0.14,
  prepare: 0.03,
  render: 0.25,
  finalize: 0.02
};
const STAGE_ORDER = ['extract', 'compress', 'transcribe', 'analyze', 'scenes', 'prepare', 'render', 'finalize'];
const CINEMA_SKIP_STAGES = new Set(['compress']);
// Fallback expected durations when nothing is known yet (no history, no
// stagePercent flow yet). Kept conservative so early ETA is not absurdly low.
const DEFAULT_STAGE_MS = {
  extract: 20000,
  compress: 15000,
  transcribe: 60000,
  analyze: 45000,
  scenes: 60000,
  prepare: 8000,
  render: 60000,
  finalize: 2000
};

const EtaHistory = {
  record(entry, stage, elapsedMs, perMinMs, chunkCount) {
    if (!STAGE_ORDER.includes(stage)) return;
    const prev = entry[stage] || { totalMs: 0, perMinMs: 0, samples: 0, perChunkMs: 0 };
    // EMA keeps the model adapting to changing hardware/network instead of
    // being dominated by a single slow run.
    const w = prev.samples >= 4 ? 0.35 : 0.6;
    entry[stage] = {
      totalMs: prev.totalMs ? Math.round(prev.totalMs * (1 - w) + elapsedMs * w) : Math.round(elapsedMs),
      perMinMs: prev.perMinMs ? Math.round(prev.perMinMs * (1 - w) + perMinMs * w) : Math.round(perMinMs),
      samples: prev.samples + 1,
      perChunkMs: (chunkCount > 0 && prev.perChunkMs)
        ? Math.round(prev.perChunkMs * (1 - w) + (elapsedMs / chunkCount) * w)
        : (chunkCount > 0 ? Math.round(elapsedMs / chunkCount) : 0)
    };
  }
};

function createEtaEstimator(priorStageTimes, opts = {}) {
  const isCinema = !!opts.isCinema;
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
  const activeStages = STAGE_ORDER.filter((s) => !(isCinema && CINEMA_SKIP_STAGES.has(s)));
  const weightSum = activeStages.reduce((acc, s) => acc + (STAGE_WEIGHTS[s] || 0), 0) || 1;

  const stages = new Map();     // stage -> { startAt, percent, hasPercent, firstPercentAt, chunkIndex, chunkCount }
  let currentStage = null;
  let lastEventAt = nowFn();
  let sourceMinutes = 0;        // from meta.sourceDurationSec (arrives with transcribe/render events)
  let chunkCount = 0;

  let displayPercent = 0;       // monotonic smoothed bar percent
  let lastEaseAt = nowFn();
  let displayEtaMs = null;      // smoothed ETA
  let holdUntil = 0;            // ETA recompute throttle

  // Live upload speed (bytes/s): short window speed EMA-fed into long EMA.
  let uploadEmaBps = 0;
  let uploadWindowBps = 0;
  let uploadLastLoaded = -1;
  let uploadLastAt = 0;
  let lastUploadSeenAt = 0;

  const priorFor = (stage) => {
    const p = priorStageTimes[stage];
    if (!p) return 0;
    if (stage === 'render') {
      if (p.perChunkMs > 0 && chunkCount > 0) return p.perChunkMs * chunkCount;
      if (p.totalMs > 0) return p.totalMs;
      return 0;
    }
    if (p.perMinMs > 0 && sourceMinutes > 0.2) return p.perMinMs * sourceMinutes;
    if (p.totalMs > 0) return p.totalMs;
    return 0;
  };

  // Expected wall time of a stage: live projection from stagePercent flow
  // blended with the learned prior; prior only when no percent is available.
  const stageExpectedMs = (stage, st, now) => {
    const prior = priorFor(stage);
    if (st && st.hasPercent && st.percent > 3 && st.firstPercentAt) {
      const elapsed = Math.max(500, now - st.firstPercentAt);
      const projection = elapsed * (100 / Math.max(4, st.percent));
      if (prior > 0) {
        const w = Math.min(0.8, 0.5 + (st.percent / 100) * 0.35);
        return projection * w + prior * (1 - w);
      }
      return projection;
    }
    return prior > 0 ? prior : (DEFAULT_STAGE_MS[stage] || 20000);
  };

  // Fraction of the stage completed:
  //  • chunked stages (render): (chunkIndex-1 + chunkPercent/100) / chunkCount;
  //  • percent-driven stages: stagePercent/100 (capped so a live stage never
  //    claims full completion — the tail belongs to server processing);
  //  • percent-less stages (LLM waits): time-based creep against the
  //    expected duration, which keeps the bar and ETA moving.
  const stageFraction = (stage, st, now) => {
    if (!st) return 0;
    if (st.chunkCount > 0) {
      const within = st.hasPercent ? Math.min(1, st.percent / 100) : 0;
      return Math.max(0, Math.min(0.999, ((st.chunkIndex - 1) + within) / st.chunkCount));
    }
    if (st.hasPercent) return Math.max(0, Math.min(0.995, st.percent / 100));
    const expected = stageExpectedMs(stage, st, now);
    return Math.max(0, Math.min(0.9, (now - st.startAt) / Math.max(expected, 1000)));
  };

  // The furthest stage actually seen marks every earlier SEEN stage as past.
  // Stages that never appeared (banner disabled, fonts cached) simply stay at
  // fraction 0 — they must not be silently counted as finished.
  const furthestSeenIdx = () => {
    let maxIdx = -1;
    for (const s of stages.keys()) {
      maxIdx = Math.max(maxIdx, STAGE_ORDER.indexOf(s));
    }
    return maxIdx;
  };

  const computeTargetPercent = (now) => {
    const maxIdx = furthestSeenIdx();
    let sum = 0;
    for (const s of activeStages) {
      const w = STAGE_WEIGHTS[s] || 0;
      if (!w) continue;
      const idx = STAGE_ORDER.indexOf(s);
      const frac = (idx < maxIdx && stages.has(s)) ? 1 : stageFraction(s, stages.get(s), now);
      sum += w * frac;
    }
    return Math.min(100, (sum / weightSum) * 100);
  };

  const computeRemainingMs = (now) => {
    const maxIdx = furthestSeenIdx();
    let remaining = 0;
    for (const s of activeStages) {
      const w = STAGE_WEIGHTS[s] || 0;
      if (!w) continue;
      const idx = STAGE_ORDER.indexOf(s);
      if (idx < maxIdx && stages.has(s)) continue;
      const st = stages.get(s);
      const expected = stageExpectedMs(s, st, now);
      const frac = stageFraction(s, st, now);
      let rest = Math.max(0, expected * (1 - frac));
      // The current stage keeps a small tail floor: percent can hit 100
      // (upload finished) while the API is still processing the response.
      if (idx === maxIdx && st) {
        rest = Math.max(rest, Math.min(expected * 0.25, 20000));
      }
      remaining += rest;
    }
    return remaining;
  };

  // ETA smoothing: asymmetric (down fast, up slow), jump-capped, throttled to
  // one recompute per 2s so the readout never flickers back and forth.
  // A stage is "past" once a newer stage has started (the models don't go
  // backwards); currentChunkIndex resets to 0 until the next render event.
  const publishEta = (now) => {
    if (displayEtaMs !== null && now < holdUntil) return;
    const raw = computeRemainingMs(now);
    let next;
    if (displayEtaMs === null) {
      next = raw;
    } else {
      const k = raw < displayEtaMs ? 0.4 : 0.18;
      next = displayEtaMs + (raw - displayEtaMs) * k;
      const maxDelta = Math.max(25000, displayEtaMs * 0.3);
      next = Math.max(displayEtaMs - maxDelta, Math.min(displayEtaMs + maxDelta, next));
    }
    displayEtaMs = Math.max(1000, next);
    holdUntil = now + 2000;
  };

  return {
    onEvent(data) {
      const now = nowFn();
      lastEventAt = now;
      if (data.meta && Number(data.meta.sourceDurationSec) > 0) {
        sourceMinutes = Number(data.meta.sourceDurationSec) / 60;
      }
      if (data.stage === 'render' && Number(data.chunkCount) > 0) {
        chunkCount = Math.max(chunkCount, Number(data.chunkCount));
      }

      // Short internet speed samples from the upload byte progress.
      const up = data.upload;
      if (up && Number(up.total) > 0) {
        const loaded = Number(up.loaded) || 0;
        const ts = Number(up.ts) || now;
        if (uploadLastLoaded < 0 || loaded < uploadLastLoaded) {
          uploadWindowBps = 0; // new chunk / retry — restart the window
        } else if (loaded > uploadLastLoaded) {
          const dt = (ts - uploadLastAt) / 1000;
          const db = loaded - uploadLastLoaded;
          if (dt > 0.25 && db > 0) {
            const inst = db / dt;
            uploadWindowBps = uploadWindowBps ? uploadWindowBps * 0.6 + inst * 0.4 : inst;
          }
        }
        uploadLastLoaded = loaded;
        uploadLastAt = ts;
        lastUploadSeenAt = now;
        uploadEmaBps = uploadEmaBps ? uploadEmaBps * 0.8 + uploadWindowBps * 0.2 : uploadWindowBps;
      }

      const stage = data.stage;
      if (stage && STAGE_ORDER.includes(stage)) {
        if (!stages.has(stage)) {
          stages.set(stage, { firstStartAt: now, startAt: now, percent: 0, hasPercent: false, firstPercentAt: 0, chunkIndex: 0, chunkCount: 0 });
        }
        if (stage !== currentStage) currentStage = stage;
        const st = stages.get(stage);
        const ci = Number(data.chunkIndex) || 0;
        const cc = Number(data.chunkCount) || 0;
        if (cc > 0) {
          if (ci !== st.chunkIndex) {
            // New chunk within the same stage: reset only the per-chunk flow.
            st.chunkIndex = ci;
            st.startAt = now;
            st.percent = 0;
            st.hasPercent = false;
            st.firstPercentAt = 0;
          }
          st.chunkCount = cc;
        }
        const sp = Number(data.stagePercent);
        if (Number.isFinite(sp)) {
          const p = Math.max(0, Math.min(100, sp));
          if (!st.hasPercent && p > 0) { st.hasPercent = true; st.firstPercentAt = now; }
          if (p > st.percent) st.percent = p;
        }
      }
    },

    tick(now = null) {
      now = now ?? nowFn();
      const idleMs = now - lastEventAt;
      const stalled = idleMs > 45000;
      if (!stalled) {
        // Monotonic easing of the bar toward the stage-model target.
        const dtSec = Math.min(3, Math.max(0.05, (now - lastEaseAt) / 1000));
        lastEaseAt = now;
        const target = computeTargetPercent(now);
        const diff = target - displayPercent;
        if (diff > 0) {
          const step = Math.min(diff, Math.max(0.25, Math.min(10, diff * 0.35)) * dtSec);
          displayPercent += step;
        }
        publishEta(now);
      }
      return {
        percent: displayPercent,
        etaMs: stalled ? null : displayEtaMs,
        stalled,
        speedBps: (now - lastUploadSeenAt < 5000 && uploadEmaBps > 0) ? uploadEmaBps : 0
      };
    },

    complete() {
      displayPercent = 100;
    },

    getPercent() {
      return displayPercent;
    },

    collectStageDurations(now = null) {
      now = now ?? nowFn();
      const seen = [];
      for (const s of STAGE_ORDER) {
        const st = stages.get(s);
        if (st && st.firstStartAt) seen.push({ stage: s, startAt: st.firstStartAt });
      }
      const out = {};
      for (let i = 0; i < seen.length; i++) {
        const endAt = i + 1 < seen.length ? seen[i + 1].startAt : now;
        out[seen[i].stage] = { ms: Math.max(0, endAt - seen[i].startAt), complete: i + 1 < seen.length };
      }
      return out;
    },

    currentChunkCount() {
      return chunkCount;
    },

    getSourceMinutes() {
      return sourceMinutes;
    }
  };
}

function getSelectedKaraokeEffects() {
  const effects = [];
  if ($('#karaoke-mode-highlight')?.checked) effects.push('highlight');
  if ($('#karaoke-mode-box')?.checked) effects.push('box');
  if ($('#karaoke-mode-caps')?.checked) effects.push('caps');
  return effects;
}

function setSelectedKaraokeEffects(effects) {
  const set = new Set(Array.isArray(effects) ? effects : []);
  if (set.has('underline')) set.add('box');
  if ($('#karaoke-mode-highlight')) $('#karaoke-mode-highlight').checked = set.has('highlight');
  if ($('#karaoke-mode-box')) $('#karaoke-mode-box').checked = set.has('box');
  if ($('#karaoke-mode-caps')) $('#karaoke-mode-caps').checked = set.has('caps');
}

function legacyModeFromEffects(effects) {
  const set = new Set(Array.isArray(effects) ? effects : []);
  if (set.has('highlight') && set.has('box')) return 'both';
  if (set.has('box')) return 'underline';
  if (set.has('caps')) return 'caps';
  return 'highlight';
}

const DEFAULT_SETTINGS = {
  proxy: null,
  generationMode: 'stories',
  cinemaSceneCount: 10,
  cinemaFillMode: 'crop',
  cinemaTargetSec: 45,
  cinemaMaxSec: 90,
  subtitlesEnabled: false,
  subtitleStyle: 'Classic',
  subtitleLanguage: 'ru',
  subtitlePosition: 'bottom',
  subtitleWordsPerLine: 3,
  subtitleMaxLineMs: 1200,
  subtitleFontSize: 20,
  subtitleFontFamily: 'Inter',
  subtitleMarginV: 40,
  subtitleOffsetMs: 0,
  subtitleKaraoke: false,
  subtitleKaraokeMode: 'highlight',
  subtitleKaraokeEffects: ['highlight'],
  subtitleCase: 'sentence',
  subtitleCustomPos: false,
  subtitleX: 540,
  subtitleY: 1850,
  bannerEnabled: false,
  bannerPath: '',
  bannerX: 740,
  bannerY: 60,
  bannerWidth: 300,
  bannerHeight: 150,
  bannerOpacity: 100,
  bannerMode: 'overlay',
  bannerIntervalSec: 60,
  customProviders: [],
  customModels: [],
  transcriptionChain: [],
  analysisChain: [],
  appLanguage: 'en',
  appTheme: 'dark',
  activePresetId: null,
  presets: []
};

const PRESET_SETTING_KEYS = [
  'proxy',
  'generationMode',
  'cinemaSceneCount',
  'cinemaFillMode',
  'cinemaTargetSec',
  'cinemaMaxSec',
  'subtitlesEnabled',
  'subtitleStyle',
  'subtitleLanguage',
  'subtitlePosition',
  'subtitleWordsPerLine',
  'subtitleMaxLineMs',
  'subtitleFontSize',
  'subtitleFontFamily',
  'subtitleMarginV',
  'subtitleOffsetMs',
  'subtitleKaraoke',
  'subtitleKaraokeMode',
  'subtitleKaraokeEffects',
  'subtitleCase',
  'subtitleCustomPos',
  'subtitleX',
  'subtitleY',
  'bannerEnabled',
  'bannerPath',
  'bannerX',
  'bannerY',
  'bannerWidth',
  'bannerHeight',
  'bannerOpacity',
  'bannerMode',
  'bannerIntervalSec',
  'customProviders',
  'customModels',
  'transcriptionChain',
  'analysisChain',
  'appLanguage',
  'appTheme'
];

const APP_THEMES = [
  'dark', 'light', 'copper', 'clay', 'forest', 'wine', 'violet',
  'coral', 'midnight', 'rose', 'lime', 'signal', 'apricot',
  'milk', 'electric', 'sunset', 'lagoon', 'berry'
];

function normalizeTheme(theme) {
  return APP_THEMES.includes(theme) ? theme : 'dark';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = normalizeTheme(theme);
}

function clonePresetValue(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === 'object') return { ...value };
  return value;
}

function createPresetId() {
  return `preset-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizePresets(presets) {
  if (!Array.isArray(presets)) return [];
  return presets
    .filter((preset) => preset && typeof preset === 'object')
    .map((preset, index) => ({
      id: String(preset.id || createPresetId()),
      name: String(preset.name || `Preset ${index + 1}`),
      settings: preset.settings && typeof preset.settings === 'object' ? preset.settings : {},
      paths: preset.paths && typeof preset.paths === 'object' ? preset.paths : {},
      createdAt: preset.createdAt || new Date().toISOString(),
      updatedAt: preset.updatedAt || preset.createdAt || new Date().toISOString()
    }));
}

function capturePresetSettings() {
  const snapshot = {};
  PRESET_SETTING_KEYS.forEach((key) => {
    snapshot[key] = clonePresetValue(settings[key]);
  });
  snapshot.subtitleKaraokeEffects = Array.isArray(snapshot.subtitleKaraokeEffects)
    ? snapshot.subtitleKaraokeEffects.filter((effect) => typeof effect === 'string')
    : ['highlight'];
  if (snapshot.subtitleKaraokeEffects.length === 0) snapshot.subtitleKaraokeEffects = ['highlight'];
  snapshot.subtitleKaraokeMode = legacyModeFromEffects(snapshot.subtitleKaraokeEffects);
  return snapshot;
}

function capturePresetPaths() {
  return {
    sourcePath: sourcePath || null,
    bgFolderPath: bgFolderPath || null,
    outputFolderPath: outputFolderPath || null
  };
}

function updateActivePresetSnapshot() {
  if (!settings.activePresetId) return;
  const presets = normalizePresets(settings.presets);
  const index = presets.findIndex((preset) => preset.id === settings.activePresetId);
  if (index === -1) {
    settings.activePresetId = null;
    settings.presets = presets;
    return;
  }
  presets[index] = {
    ...presets[index],
    settings: capturePresetSettings(),
    paths: capturePresetPaths(),
    updatedAt: new Date().toISOString()
  };
  settings.presets = presets;
}

const I18N = {
  en: {
    tabs: { generator: 'Generator', settings: 'Settings' },
    status: { ready: 'Ready', processing: 'Processing…', done: 'Complete', error: 'Error', idle: 'Ready' },
    buttons: { generate: 'Generate Videos', cancel: 'Cancel', add: 'Add', createPreset: 'Create', savePreset: 'Save Current', deletePreset: 'Delete Preset', resetStats: 'Reset Statistics' },
    warnings: { noKeys: 'Add AI providers, models and build the transcription & analysis chains in Settings before generating.' },
    labels: {
      modeTitle: 'Generation Mode',
      modeStories: 'Stories',
      modeCinema: 'Cinema',
      modeHintStories: 'Find complete stories in a long recording and render vertical clips with backgrounds.',
      modeHintCinema: 'Drop a movie in — AI picks the most viral scenes (dramatic dialogues and action) and renders ready-to-post vertical clips.',
      cinemaScenesLabel: 'Number of Scenes',
      cinemaFillLabel: 'Vertical Frame',
      cinemaFillCrop: 'Center Crop',
      cinemaFillBlur: 'Blurred Background',
      cinemaSectionTitle: 'Cinema Mode',
      cinemaSettingsHint: 'These options apply when the Generator is switched to Cinema mode.',
      cinemaTargetLabel: 'Target Length (sec)',
      cinemaMaxLabel: 'Max Length (sec)',
      sourceTitle: 'Source Audio / Video',
      bgTitle: 'Background Videos Folder',
      outputTitle: 'Output Folder',
      sourcePlaceholder: 'Click to select the source audio or video file…',
      bgPlaceholder: 'Click to select the ADHD background videos folder…',
      outputPlaceholder: 'Click to select where to save generated videos…',
      appLangTitle: 'App Language',
      interfaceLangLabel: 'Interface Language',
      themeLabel: 'Color Theme',
      themeCurrentGroup: 'Current palettes',
      themeClassicGroup: 'Classic palettes',
      themeDark: 'Graphite',
      themeLight: 'Paper',
      themeCopper: 'Copper Night',
      themeClay: 'Terracotta',
      themeForest: 'Forest Linen',
      themeWine: 'Wine Blush',
      themeViolet: 'Violet Ink',
      themeCoral: 'Coral Reef',
      themeMidnight: 'Night Slate',
      themeRose: 'Raspberry Silk',
      themeLime: 'Carbon Lime',
      themeSignal: 'Signal Steel',
      themeApricot: 'Peach Amethyst',
      themeMilk: 'Vanilla',
      themeElectric: 'Electric Lime',
      themeSunset: 'Sunset Pop',
      themeLagoon: 'Lagoon',
      themeBerry: 'Berry Punch',
      presetsTitle: 'Presets',
      presetSelectLabel: 'Active Preset',
      presetNameLabel: 'New Preset Name',
      noPreset: 'No preset selected',
      presetNamePlaceholder: 'Preset name',
      presetsHint: 'Create presets to save AI models, proxy, subtitle settings, language, and selected folders/files.',
      customModelsTitle: 'Custom AI Models',
      customModelsHint: 'A provider holds the shared Base URL and API key — add several models to one provider to reuse the same credentials. Build fallback chains so generation automatically switches to the next model when one hits limits.',
      provTitle: 'Providers',
      cpName: 'Name (optional)',
      cpUrl: 'Base URL',
      cpKey: 'API Key',
      addProvider: 'Add Provider',
      provEmpty: 'No providers yet',
      provModelError: 'Fill Base URL (https://…) and API key',
      modelsTitle: 'Models',
      cmProvider: 'Provider',
      cmNoProvider: 'Add a provider first',
      cmModel: 'Model ID',
      cmName: 'Display name (optional)',
      addModel: 'Add Model',
      cmEmpty: 'No models yet',
      cmModelError: 'Fill Model ID and select a provider',
      chainsTitle: 'Fallback chains',
      chainTc: 'Transcription chain',
      chainAc: 'Analysis chain',
      chainAdd: 'Add',
      chainEmpty: 'Chain is empty — add models',
      chainHint: 'Models are tried in order: when one hits rate limits or fails, the next one takes over automatically.',
      chainModelError: 'Select a model to add to the chain',
      cmModelError: 'Fill Base URL (https://…), API key and Model ID',
      proxyTitle: 'Proxy Configuration',
      enable: 'Enable',
      proxyType: 'Type',
      proxyHost: 'Host',
      proxyPort: 'Port',
      proxyUser: 'Username (optional)',
      proxyPass: 'Password (optional)',
      subtitlesTitle: 'Transcript & Subtitles',
      subStyle: 'Style Preset',
      subModel: 'Model Quality',
      subLanguage: 'Language',
      subCase: 'Case',
      subPosition: 'Position',
      subWords: 'Words Per Subtitle',
      subMaxMs: 'Max Line Duration (ms)',
      subFont: 'Font Size',
      subFontFamily: 'Font Family',
      subMargin: 'Vertical Margin',
      subOffset: 'Subtitle Offset',
      subOffsetHint: 'Positive values make subtitles appear earlier (fixes lag), negative values make them appear later.',
      subKaraoke: 'Karaoke Mode',
      subKaraokeWord: 'Word highlight',
      subKaraokeMode: 'Karaoke Effect',
      subCustomPos: 'Custom position (drag in preview)',
      subCustomPosHint: 'Drag the text in the live preview; the corner handle scales it proportionally (both axes together). While enabled, Position and Vertical Margin above are ignored.',
      subHint: 'The transcript is generated once with the selected transcription model and then reused for subtitles and story analysis.',
      bannerTitle: 'Ad Banner',
      bannerPlaceholder: 'Click to select a banner image or short video…',
      bannerWidth: 'Width (px)',
      bannerHeight: 'Height (px)',
      bannerOpacity: 'Visibility',
      bannerMode: 'Show Mode',
      bannerModeOverlay: 'Always visible (overlay)',
      bannerModeInterstitial: 'Pause video & play banner with sound',
      bannerInterval: 'Pause every (sec)',
      bannerInterstitialHint: 'Pause mode (video banners only): every N seconds the clip pauses while the banner video plays once with its own sound — the pause lasts exactly as long as the banner video. Then the clip resumes where it stopped. Requires an interval shorter than the clip.',
      bannerReset: 'Reset',
      bannerRemove: 'Remove Banner',
      livePreview: 'Live Preview',
      previewDragHint: 'banner: drag to move · corner to resize',
      bannerHint: 'The banner is overlaid on every clip for its full duration. Video banners loop automatically.',
      bannerProbeError: 'Cannot read this file as a banner',
      statsTitle: 'Statistics',
      statTotal: 'Total Videos',
      statTime: 'Total Render Time',
      statAvg: 'Avg Per Video',
      statLast: 'Last Run',
      eta: {
        remaining: 'Remaining',
        waiting: 'Estimating…'
      }
    }
  },
  ru: {
    tabs: { generator: 'Генератор', settings: 'Настройки' },
    status: { ready: 'Готово', processing: 'Обработка…', done: 'Завершено', error: 'Ошибка', idle: 'Готово' },
    buttons: { generate: 'Создать видео', cancel: 'Отмена', add: 'Добавить', createPreset: 'Создать', savePreset: 'Сохранить текущие', deletePreset: 'Удалить пресет', resetStats: 'Сбросить статистику' },
    warnings: { noKeys: 'Добавь провайдеров и модели, собери цепочки транскрибации и анализа в настройках перед запуском.' },
    labels: {
      modeTitle: 'Режим генерации',
      modeStories: 'Истории',
      modeCinema: 'Кино',
      modeHintStories: 'Находит законченные истории в длинной записи и собирает вертикальные клипы с фонами.',
      modeHintCinema: 'Закинь фильм — ИИ отберёт самые вирусные сцены (сильные диалоги и экшн) и соберёт готовые вертикальные ролики для заливки.',
      cinemaScenesLabel: 'Количество сцен',
      cinemaFillLabel: 'Вертикальный кадр',
      cinemaFillCrop: 'Центр-кроп',
      cinemaFillBlur: 'Размытый фон',
      cinemaSectionTitle: 'Режим кино',
      cinemaSettingsHint: 'Эти настройки применяются, когда в Генераторе включён режим «Кино».',
      cinemaTargetLabel: 'Целевая длина (сек)',
      cinemaMaxLabel: 'Макс. длина (сек)',
      sourceTitle: 'Исходное аудио / видео',
      bgTitle: 'Папка с фоновыми видео',
      outputTitle: 'Папка для вывода',
      sourcePlaceholder: 'Нажми, чтобы выбрать исходный аудио- или видеофайл…',
      bgPlaceholder: 'Нажми, чтобы выбрать папку с ADHD-фонами…',
      outputPlaceholder: 'Нажми, чтобы выбрать папку сохранения…',
      appLangTitle: 'Язык приложения',
      interfaceLangLabel: 'Язык интерфейса',
      themeLabel: 'Цветовая тема',
      themeCurrentGroup: 'Текущие палитры',
      themeClassicGroup: 'Классические палитры',
      themeDark: 'Графит',
      themeLight: 'Бумага',
      themeCopper: 'Медная ночь',
      themeClay: 'Терракота',
      themeForest: 'Лесной лён',
      themeWine: 'Винный румянец',
      themeViolet: 'Фиолетовые чернила',
      themeCoral: 'Коралловый риф',
      themeMidnight: 'Ночной сланец',
      themeRose: 'Малиновый шёлк',
      themeLime: 'Карбон-лайм',
      themeSignal: 'Сигнальная сталь',
      themeApricot: 'Персиковый аметист',
      themeMilk: 'Ваниль',
      themeElectric: 'Электро-лайм',
      themeSunset: 'Закатный поп',
      themeLagoon: 'Лагуна',
      themeBerry: 'Ягодный панч',
      presetsTitle: 'Пресеты',
      presetSelectLabel: 'Активный пресет',
      presetNameLabel: 'Имя нового пресета',
      noPreset: 'Пресет не выбран',
      presetNamePlaceholder: 'Название пресета',
      presetsHint: 'Создавай пресеты, чтобы сохранять ИИ-модели, прокси, субтитры, язык и выбранные файлы/папки.',
      customModelsTitle: 'Пользовательские ИИ-модели',
      customModelsHint: 'Провайдер хранит общий базовый URL и API ключ — добавляй несколько моделей к одному провайдеру, чтобы использовать одни и те же данные. Собери цепочки фолбэков, чтобы генерация автоматически переключалась на следующую модель при лимитах.',
      provTitle: 'Провайдеры',
      cpName: 'Название (необязательно)',
      cpUrl: 'Базовый URL',
      cpKey: 'API ключ',
      addProvider: 'Добавить провайдера',
      provEmpty: 'Провайдеры не добавлены',
      provModelError: 'Заполни базовый URL (https://…) и API ключ',
      modelsTitle: 'Модели',
      cmProvider: 'Провайдер',
      cmNoProvider: 'Сначала добавь провайдера',
      cmModel: 'ID модели',
      cmName: 'Название (необязательно)',
      addModel: 'Добавить модель',
      cmEmpty: 'Модели не добавлены',
      cmModelError: 'Заполни ID модели и выбери провайдера',
      chainsTitle: 'Цепочки фолбэков',
      chainTc: 'Цепочка транскрибации',
      chainAc: 'Цепочка анализа',
      chainAdd: 'Добавить',
      chainEmpty: 'Цепочка пуста — добавь модели',
      chainHint: 'Модели пробуются по порядку: если одна упёрлась в лимиты или недоступна — автоматически включается следующая.',
      chainModelError: 'Выбери модель, которую нужно добавить в цепочку',
      cmModelError: 'Заполни базовый URL (https://…), API ключ и ID модели',
      proxyTitle: 'Настройки прокси',
      enable: 'Включить',
      proxyType: 'Тип',
      proxyHost: 'Хост',
      proxyPort: 'Порт',
      proxyUser: 'Логин (необязательно)',
      proxyPass: 'Пароль (необязательно)',
      subtitlesTitle: 'Расшифровка и субтитры',
      subStyle: 'Стиль',
      subModel: 'Качество модели',
      subLanguage: 'Язык',
      subCase: 'Регистр',
      subPosition: 'Позиция',
      subWords: 'Слов за субтитр',
      subMaxMs: 'Макс. длительность строки (мс)',
      subFont: 'Размер шрифта',
      subFontFamily: 'Шрифт',
      subMargin: 'Вертикальный отступ',
      subOffset: 'Смещение субтитров',
      subOffsetHint: 'Положительные значения сдвигают субтитры назад (раньше), отрицательные — вперед (позже).',
      subKaraoke: 'Караоке режим',
      subKaraokeWord: 'Подсветка слов',
      subKaraokeMode: 'Эффект караоке',
      subCustomPos: 'Своя позиция (перетаскивай в превью)',
      subCustomPosHint: 'Перетаскивай текст прямо в живом предпросмотре; угловая точка масштабирует его пропорционально (сразу обе оси). Пока включено, Позиция и Вертикальный отступ выше не используются.',
      subHint: 'Расшифровка делается один раз выбранной моделью транскрибации и потом переиспользуется для субтитров и анализа.',
      bannerTitle: 'Рекламный баннер',
      bannerPlaceholder: 'Нажми, чтобы выбрать фото или короткое видео баннера…',
      bannerWidth: 'Ширина (px)',
      bannerHeight: 'Высота (px)',
      bannerOpacity: 'Видимость',
      bannerMode: 'Режим показа',
      bannerModeOverlay: 'Всегда виден (поверх)',
      bannerModeInterstitial: 'Пауза ролика и баннер со звуком',
      bannerInterval: 'Пауза каждые (сек)',
      bannerInterstitialHint: 'Режим паузы (только для видео-баннеров): каждые N секунд ролик замирает, пока видео-баннер проигрывается один раз со своим звуком — пауза длится ровно столько, сколько сам баннер. Затем ролик продолжается с места паузы. Интервал должен быть короче клипа.',
      bannerReset: 'Сбросить',
      bannerRemove: 'Удалить баннер',
      livePreview: 'Предпросмотр клипа',
      previewDragHint: 'баннер: перетаскивай · угол — размер',
      bannerHint: 'Баннер накладывается на каждый клип всю его длительность. Видео-баннер зацикливается автоматически.',
      bannerProbeError: 'Не удалось прочитать файл как баннер',
      statsTitle: 'Статистика',
      statTotal: 'Всего видео',
      statTime: 'Общее время рендера',
      statAvg: 'Среднее на видео',
      statLast: 'Последний запуск',
      eta: {
        remaining: 'Осталось',
        waiting: 'Оцениваю…'
      }
    }
  }
};

function t(path) {
  const langPack = I18N[uiLang] || I18N.en;
  return path.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : null), langPack) ?? path;
}

function applyTranslations() {
  const tabs = $$('.nav-tab');
  if (tabs[0]) tabs[0].textContent = t('tabs.generator');
  if (tabs[1]) tabs[1].textContent = t('tabs.settings');
  const st = $('#status-text');
  if (st && (!st.textContent || st.textContent === 'Ready' || st.textContent === 'Готово')) st.textContent = t('status.ready');
  $('#btn-generate').textContent = t('buttons.generate');
  $('#btn-cancel').textContent = t('buttons.cancel');
  $('#btn-create-preset').textContent = t('buttons.createPreset');
  $('#btn-save-preset').textContent = t('buttons.savePreset');
  $('#btn-delete-preset').textContent = t('buttons.deletePreset');
  $('#btn-reset-stats').textContent = t('buttons.resetStats');
  $('#no-keys-warning').textContent = t('warnings.noKeys');
  const modeTitle = $('#txt-mode-title'); if (modeTitle) modeTitle.textContent = t('labels.modeTitle');
  const modeStoriesBtn = $('#mode-stories'); if (modeStoriesBtn) modeStoriesBtn.textContent = t('labels.modeStories');
  const modeCinemaBtn = $('#mode-cinema'); if (modeCinemaBtn) modeCinemaBtn.textContent = t('labels.modeCinema');
  const modeHint = $('#txt-mode-hint'); if (modeHint) modeHint.textContent = t(currentGenerationMode() === 'cinema' ? 'labels.modeHintCinema' : 'labels.modeHintStories');
  const cinemaTitle = $('#txt-cinema-title'); if (cinemaTitle) cinemaTitle.textContent = t('labels.cinemaSectionTitle');
  const cinemaHint = $('#cinema-settings-hint'); if (cinemaHint) cinemaHint.textContent = t('labels.cinemaSettingsHint');
  const cinemaTargetLabel = $('#txt-cinema-target-label'); if (cinemaTargetLabel) cinemaTargetLabel.textContent = t('labels.cinemaTargetLabel');
  const cinemaMaxLabel = $('#txt-cinema-max-label'); if (cinemaMaxLabel) cinemaMaxLabel.textContent = t('labels.cinemaMaxLabel');
  const cinemaScenesLabel = $('#txt-cinema-scenes-label'); if (cinemaScenesLabel) cinemaScenesLabel.textContent = t('labels.cinemaScenesLabel');
  const cinemaFillLabel = $('#txt-cinema-fill-label'); if (cinemaFillLabel) cinemaFillLabel.textContent = t('labels.cinemaFillLabel');
  const cinemaFillSelect = $('#cinema-fill-mode');
  if (cinemaFillSelect) {
    [...cinemaFillSelect.options].forEach((option) => {
      if (option.value === 'crop') option.textContent = t('labels.cinemaFillCrop');
      if (option.value === 'blur') option.textContent = t('labels.cinemaFillBlur');
    });
  }
  const sTitle = $('#txt-source-title'); if (sTitle) sTitle.textContent = t('labels.sourceTitle');
  const bTitle = $('#txt-bg-title'); if (bTitle) bTitle.textContent = t('labels.bgTitle');
  const oTitle = $('#txt-output-title'); if (oTitle) oTitle.textContent = t('labels.outputTitle');
  const alTitle = $('#txt-app-lang-title'); if (alTitle) alTitle.textContent = t('labels.appLangTitle');
  const alLabel = $('#txt-interface-lang-label'); if (alLabel) alLabel.textContent = t('labels.interfaceLangLabel');
  const themeLabel = $('#txt-theme-label'); if (themeLabel) themeLabel.textContent = t('labels.themeLabel');
  const currentThemeGroup = $('#app-theme-current-group'); if (currentThemeGroup) currentThemeGroup.label = t('labels.themeCurrentGroup');
  const classicThemeGroup = $('#app-theme-classic-group'); if (classicThemeGroup) classicThemeGroup.label = t('labels.themeClassicGroup');
  const themeSelect = $('#app-theme');
  if (themeSelect) {
    const themeNames = {
      dark: t('labels.themeDark'),
      light: t('labels.themeLight'),
      copper: t('labels.themeCopper'),
      clay: t('labels.themeClay'),
      forest: t('labels.themeForest'),
      wine: t('labels.themeWine'),
      violet: t('labels.themeViolet'),
      coral: t('labels.themeCoral'),
      midnight: t('labels.themeMidnight'),
      rose: t('labels.themeRose'),
      lime: t('labels.themeLime'),
      signal: t('labels.themeSignal'),
      apricot: t('labels.themeApricot'),
      milk: t('labels.themeMilk'),
      electric: t('labels.themeElectric'),
      sunset: t('labels.themeSunset'),
      lagoon: t('labels.themeLagoon'),
      berry: t('labels.themeBerry')
    };
    [...themeSelect.options].forEach((option) => {
      option.textContent = themeNames[option.value] || option.textContent;
    });
  }
  const prTitle = $('#txt-presets-title'); if (prTitle) prTitle.textContent = t('labels.presetsTitle');
  const prSelect = $('#txt-preset-select-label'); if (prSelect) prSelect.textContent = t('labels.presetSelectLabel');
  const prName = $('#txt-preset-name-label'); if (prName) prName.textContent = t('labels.presetNameLabel');
  const prInput = $('#preset-name-input'); if (prInput) prInput.placeholder = t('labels.presetNamePlaceholder');
  const prHint = $('#presets-hint'); if (prHint) prHint.textContent = t('labels.presetsHint');
  const cmt = $('#txt-custom-models-title'); if (cmt) cmt.textContent = t('labels.customModelsTitle');
  const cmh = $('#custom-models-hint'); if (cmh) cmh.textContent = t('labels.customModelsHint');
  const pvt = $('#txt-prov-title'); if (pvt) pvt.textContent = t('labels.provTitle');
  const cpn = $('#txt-cp-name'); if (cpn) cpn.textContent = t('labels.cpName');
  const cpu = $('#txt-cp-url'); if (cpu) cpu.textContent = t('labels.cpUrl');
  const cpk = $('#txt-cp-key'); if (cpk) cpk.textContent = t('labels.cpKey');
  const bap = $('#btn-add-provider'); if (bap) bap.textContent = t('labels.addProvider');
  const mdt = $('#txt-models-title'); if (mdt) mdt.textContent = t('labels.modelsTitle');
  const cmp = $('#txt-cm-provider'); if (cmp) cmp.textContent = t('labels.cmProvider');
  const cmm = $('#txt-cm-model'); if (cmm) cmm.textContent = t('labels.cmModel');
  const cmn = $('#txt-cm-name'); if (cmn) cmn.textContent = t('labels.cmName');
  const bam = $('#btn-add-model'); if (bam) bam.textContent = t('labels.addModel');
  const cht = $('#txt-chains-title'); if (cht) cht.textContent = t('labels.chainsTitle');
  const ctc = $('#txt-chain-tc'); if (ctc) ctc.textContent = t('labels.chainTc');
  const cac = $('#txt-chain-ac'); if (cac) cac.textContent = t('labels.chainAc');
  const bta = $('#btn-chain-tc-add'); if (bta) bta.textContent = t('labels.chainAdd');
  const baa = $('#btn-chain-ac-add'); if (baa) baa.textContent = t('labels.chainAdd');
  const chh = $('#chains-hint'); if (chh) chh.textContent = t('labels.chainHint');
  const nkw = $('#no-keys-warning'); if (nkw) nkw.textContent = t('warnings.noKeys');
  const pt = $('#txt-proxy-title'); if (pt) pt.textContent = t('labels.proxyTitle');
  const ep = $('#txt-enable-proxy'); if (ep) ep.textContent = t('labels.enable');
  const es = $('#txt-enable-subtitles'); if (es) es.textContent = t('labels.enable');
  const pty = $('#txt-proxy-type'); if (pty) pty.textContent = t('labels.proxyType');
  const ph = $('#txt-proxy-host'); if (ph) ph.textContent = t('labels.proxyHost');
  const pp = $('#txt-proxy-port'); if (pp) pp.textContent = t('labels.proxyPort');
  const pu = $('#txt-proxy-user'); if (pu) pu.textContent = t('labels.proxyUser');
  const ppa = $('#txt-proxy-pass'); if (ppa) ppa.textContent = t('labels.proxyPass');
  const stt = $('#txt-subtitles-title'); if (stt) stt.textContent = t('labels.subtitlesTitle');
  const ss = $('#txt-sub-style'); if (ss) ss.textContent = t('labels.subStyle');
  const sm = $('#txt-sub-model'); if (sm) sm.textContent = t('labels.subModel');
  const sl = $('#txt-sub-language'); if (sl) sl.textContent = t('labels.subLanguage');
  const sc = $('#txt-sub-case'); if (sc) sc.textContent = t('labels.subCase');
  const sp = $('#txt-sub-position'); if (sp) sp.textContent = t('labels.subPosition');
  const sw = $('#txt-sub-words'); if (sw) sw.textContent = t('labels.subWords');
  const smax = $('#txt-sub-maxms'); if (smax) smax.textContent = t('labels.subMaxMs');
  const sf = $('#txt-sub-font'); if (sf) sf.textContent = t('labels.subFont');
  const sff = $('#txt-sub-font-family'); if (sff) sff.textContent = t('labels.subFontFamily');
  const svm = $('#txt-sub-margin'); if (svm) svm.textContent = t('labels.subMargin');
  const sof = $('#txt-sub-offset'); if (sof) sof.textContent = t('labels.subOffset');
  const sofh = $('#txt-sub-offset-hint'); if (sofh) sofh.textContent = t('labels.subOffsetHint');
  const sk = $('#txt-sub-karaoke'); if (sk) sk.textContent = t('labels.subKaraoke');
  const skw = $('#txt-sub-karaoke-word'); if (skw) skw.textContent = t('labels.subKaraokeWord');
  const skm = $('#txt-sub-karaoke-mode'); if (skm) skm.textContent = t('labels.subKaraokeMode');
  const scp = $('#txt-sub-custom-pos'); if (scp) scp.textContent = t('labels.subCustomPos');
  const scph = $('#txt-sub-custom-pos-hint'); if (scph) scph.textContent = t('labels.subCustomPosHint');
  const sh = $('#txt-sub-hint'); if (sh) sh.textContent = t('labels.subHint');
  const bt = $('#txt-banner-title'); if (bt) bt.textContent = t('labels.bannerTitle');
  const eb = $('#txt-enable-banner'); if (eb) eb.textContent = t('labels.enable');
  const bw = $('#txt-banner-width'); if (bw) bw.textContent = t('labels.bannerWidth');
  const bhl = $('#txt-banner-height'); if (bhl) bhl.textContent = t('labels.bannerHeight');
  const bop = $('#txt-banner-opacity'); if (bop) bop.textContent = t('labels.bannerOpacity');
  const bmd = $('#txt-banner-mode'); if (bmd) bmd.textContent = t('labels.bannerMode');
  const bin = $('#txt-banner-interval'); if (bin) bin.textContent = t('labels.bannerInterval');
  const bih = $('#txt-banner-interstitial-hint'); if (bih) bih.textContent = t('labels.bannerInterstitialHint');
  const modeSelect = $('#banner-mode');
  if (modeSelect) {
    [...modeSelect.options].forEach((option) => {
      if (option.value === 'overlay') option.textContent = t('labels.bannerModeOverlay');
      if (option.value === 'interstitial') option.textContent = t('labels.bannerModeInterstitial');
    });
  }
  const brs = $('#btn-reset-banner'); if (brs) brs.textContent = t('labels.bannerReset');
  const br = $('#btn-remove-banner'); if (br) br.textContent = t('labels.bannerRemove');
  const lp = $('#txt-live-preview-title'); if (lp) lp.textContent = t('labels.livePreview');
  const pdh = $('#preview-drag-hint'); if (pdh) pdh.textContent = t('labels.previewDragHint');
  const bh = $('#txt-banner-hint'); if (bh) bh.textContent = t('labels.bannerHint');
  if (!settings.bannerPath) {
    const bl = $('#banner-label'); if (bl) bl.textContent = t('labels.bannerPlaceholder');
  }
  const sTitle2 = $('#txt-stats-title'); if (sTitle2) sTitle2.textContent = t('labels.statsTitle');
  const st1 = $('#txt-stat-total'); if (st1) st1.textContent = t('labels.statTotal');
  const st2 = $('#txt-stat-time'); if (st2) st2.textContent = t('labels.statTime');
  const st3 = $('#txt-stat-avg'); if (st3) st3.textContent = t('labels.statAvg');
  const st4 = $('#txt-stat-last'); if (st4) st4.textContent = t('labels.statLast');

  if (!sourcePath) $('#source-label').textContent = t('labels.sourcePlaceholder');
  if (!bgFolderPath) $('#bg-label').textContent = t('labels.bgPlaceholder');
  if (!outputFolderPath) $('#output-label').textContent = t('labels.outputPlaceholder');
  renderPresets();
  renderProviders();
  renderCustomModels();
  updateModelCount();
  updateSubtitlePreview();
  window.SharpSelect?.refreshAll();
}

async function loadSettings() {
  try {
    settings = await window.api.getSettings() || { proxy: null, customProviders: [], customModels: [] };
    settings = {
      ...DEFAULT_SETTINGS,
      ...settings
    };
    settings.appTheme = normalizeTheme(settings.appTheme);
    settings.presets = normalizePresets(settings.presets);
    ['activePresetId', 'activePresetIdStories', 'activePresetIdCinema'].forEach((key) => {
      if (settings[key] && !settings.presets.some((preset) => preset.id === settings[key])) {
        settings[key] = null;
      }
    });
    syncActivePresetIdAlias();
  } catch (err) {
    console.error('Failed to load settings:', err);
    settings = { ...DEFAULT_SETTINGS, presets: [] };
  }
}

async function saveSettings() {
  try {
    updateActivePresetSnapshot();
    await window.api.saveSettings(settings);
    renderPresets();
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

// ===== DOM REFS =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function syncSettingsFromControls() {
  if ($('#cinema-scene-count')) {
    settings.generationMode = currentGenerationMode();
    settings.cinemaSceneCount = Math.max(5, Math.min(20, Number($('#cinema-scene-count').value) || 10));
    settings.cinemaFillMode = $('#cinema-fill-mode')?.value === 'blur' ? 'blur' : 'crop';
    if ($('#cinema-target-sec')) {
      const target = clampCinemaTarget($('#cinema-target-sec').value);
      settings.cinemaTargetSec = target;
      settings.cinemaMaxSec = clampCinemaMax($('#cinema-max-sec')?.value, target);
    }
  }

  if ($('#proxy-toggle')) {
    if ($('#proxy-toggle').checked) {
      settings.proxy = {
        type: $('#proxy-type').value,
        host: $('#proxy-host').value,
        port: $('#proxy-port').value,
        username: $('#proxy-user').value,
        password: $('#proxy-pass').value
      };
    } else {
      settings.proxy = null;
    }
  }

  if ($('#subtitles-toggle')) {
    settings.subtitlesEnabled = !!$('#subtitles-toggle').checked;
    settings.subtitleStyle = $('#subtitle-style').value;
    settings.subtitleLanguage = $('#subtitle-language').value;
    settings.subtitlePosition = $('#subtitle-position').value;
    settings.subtitleWordsPerLine = Number($('#subtitle-words-per-line').value || 3);
    settings.subtitleMaxLineMs = Number($('#subtitle-max-line-ms').value || 1200);
    settings.subtitleFontSize = Number($('#subtitle-font-size').value || 20);
    settings.subtitleFontFamily = $('#subtitle-font-family').value || 'Inter';
    settings.subtitleMarginV = Number($('#subtitle-margin-v').value || 40);
    settings.subtitleOffsetMs = Number($('#subtitle-offset').value || 0);
    settings.subtitleKaraoke = !!$('#subtitle-karaoke').checked;
    settings.subtitleKaraokeEffects = getSelectedKaraokeEffects();
    settings.subtitleKaraokeMode = legacyModeFromEffects(settings.subtitleKaraokeEffects);
    settings.subtitleCase = $('#subtitle-case').value || 'sentence';
    settings.subtitleCustomPos = !!$('#subtitle-custom-pos')?.checked;
  }

  if ($('#banner-toggle')) {
    settings.bannerEnabled = !!$('#banner-toggle').checked;
    settings.bannerWidth = Number($('#banner-width').value || 300);
    settings.bannerHeight = Number($('#banner-height').value || 150);
    settings.bannerOpacity = clampBannerOpacity($('#banner-opacity').value);
    settings.bannerMode = $('#banner-mode')?.value === 'interstitial' ? 'interstitial' : 'overlay';
    settings.bannerIntervalSec = clampBannerSeconds($('#banner-interval-sec').value, 60, 5, 3600);
  }

  if ($('#app-language')) {
    settings.appLanguage = $('#app-language').value;
    uiLang = settings.appLanguage || 'en';
  }
  if ($('#app-theme')) {
    settings.appTheme = normalizeTheme($('#app-theme').value);
    applyTheme(settings.appTheme);
  }
}

function setPathLabel(label, path, placeholder) {
  if (!label) return;
  if (path) {
    label.textContent = path;
    label.className = 'path';
  } else {
    label.textContent = placeholder;
    label.className = 'label';
  }
}

function syncPathLabels() {
  setPathLabel($('#source-label'), sourcePath, t('labels.sourcePlaceholder'));
  setPathLabel($('#bg-label'), bgFolderPath, t('labels.bgPlaceholder'));
  setPathLabel($('#output-label'), outputFolderPath, t('labels.outputPlaceholder'));
}

function syncSettingsToControls() {
  settings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    presets: normalizePresets(settings.presets)
  };
  // Build custom model options before assigning select values.
  renderProviders();
  renderCustomModels();

  $('#app-language').value = settings.appLanguage || 'en';
  uiLang = settings.appLanguage || 'en';
  settings.appTheme = normalizeTheme(settings.appTheme);
  $('#app-theme').value = settings.appTheme;
  applyTheme(settings.appTheme);

  const hasProxy = !!settings.proxy;
  $('#proxy-toggle').checked = hasProxy;
  $('#proxy-fields').style.opacity = hasProxy ? '1' : '0.4';
  $('#proxy-fields').style.pointerEvents = hasProxy ? 'auto' : 'none';
  setContainerControlsDisabled('#proxy-fields', !hasProxy);
  $('#proxy-type').value = settings.proxy?.type || 'http';
  $('#proxy-host').value = settings.proxy?.host || '';
  $('#proxy-port').value = settings.proxy?.port || '';
  $('#proxy-user').value = settings.proxy?.username || '';
  $('#proxy-pass').value = settings.proxy?.password || '';

  $('#subtitles-toggle').checked = !!settings.subtitlesEnabled;
  setSubtitleFieldsExpanded(!!settings.subtitlesEnabled);
  $('#cinema-scene-count').value = String(Math.max(5, Math.min(20, Number(settings.cinemaSceneCount) || 10)));
  $('#cinema-scene-count-value').textContent = String(Math.max(5, Math.min(20, Number(settings.cinemaSceneCount) || 10)));
  $('#cinema-fill-mode').value = settings.cinemaFillMode === 'blur' ? 'blur' : 'crop';
  $('#cinema-target-sec').value = String(clampCinemaTarget(settings.cinemaTargetSec));
  $('#cinema-max-sec').value = String(clampCinemaMax(settings.cinemaMaxSec, clampCinemaTarget(settings.cinemaTargetSec)));
  applyGenerationModeUi();
  $('#subtitle-style').value = settings.subtitleStyle || 'Classic';
  $('#subtitle-language').value = settings.subtitleLanguage || 'ru';
  $('#subtitle-position').value = settings.subtitlePosition || 'bottom';
  $('#subtitle-words-per-line').value = String(settings.subtitleWordsPerLine || 3);
  $('#subtitle-max-line-ms').value = String(settings.subtitleMaxLineMs || 1200);
  $('#subtitle-font-size').value = String(settings.subtitleFontSize || 20);
  $('#subtitle-font-family').value = settings.subtitleFontFamily || 'Inter';
  $('#subtitle-margin-v').value = String(settings.subtitleMarginV || 40);
  const savedOffset = Number(settings.subtitleOffsetMs || 0);
  $('#subtitle-offset').value = String(savedOffset);
  $('#subtitle-offset-value').textContent = savedOffset > 0 ? `+${savedOffset} ms` : `${savedOffset} ms`;
  $('#subtitle-karaoke').checked = !!settings.subtitleKaraoke;
  const savedEffects = Array.isArray(settings.subtitleKaraokeEffects)
    ? settings.subtitleKaraokeEffects
      : (settings.subtitleKaraokeMode === 'both'
      ? ['highlight', 'box']
      : settings.subtitleKaraokeMode === 'underline'
        ? ['box']
        : settings.subtitleKaraokeMode === 'caps'
          ? ['caps']
          : ['highlight']);
  setSelectedKaraokeEffects(savedEffects);
  $('#subtitle-case').value = settings.subtitleCase || 'sentence';
  updateKaraokeFieldsState();
  $('#subtitle-custom-pos').checked = !!settings.subtitleCustomPos;
  setSubtitleCustomPosUi(!!settings.subtitleCustomPos);

  $('#banner-toggle').checked = !!settings.bannerEnabled;
  setBannerFieldsExpanded(!!settings.bannerEnabled);
  $('#banner-width').value = String(settings.bannerWidth || 300);
  $('#banner-height').value = String(settings.bannerHeight || 150);
  $('#banner-opacity').value = String(clampBannerOpacity(settings.bannerOpacity));
  $('#banner-opacity-value').textContent = `${Math.round(clampBannerOpacity(settings.bannerOpacity))}%`;
  $('#banner-mode').value = ['overlay', 'interstitial'].includes(settings.bannerMode) ? settings.bannerMode : 'overlay';
  $('#banner-interval-sec').value = String(clampBannerSeconds(settings.bannerIntervalSec, 60, 5, 3600));
  syncBannerLabel();
  updateBannerPreview();

  renderPresets();
  syncPathLabels();
  updateGenerateBtn();
  updateSubtitlePreview();
  window.SharpSelect?.refreshAll();
}

// ===== PRESETS (per generation mode) =====
// Each preset stores its own generationMode; the dropdown only shows the
// presets of the currently selected mode, and each mode remembers its own
// active preset.
function presetMode(preset) {
  return preset?.settings?.generationMode === 'cinema' ? 'cinema' : 'stories';
}

function activePresetIdKey(mode) {
  return mode === 'cinema' ? 'activePresetIdCinema' : 'activePresetIdStories';
}

function presetsForCurrentMode() {
  const mode = currentGenerationMode();
  return normalizePresets(settings.presets).filter((preset) => presetMode(preset) === mode);
}

function syncActivePresetIdAlias() {
  // `activePresetId` stays as the per-mode pointer alias so the rest of the
  // code (paths restore, snapshot updates) keeps working unchanged.
  settings.activePresetId = settings[activePresetIdKey(currentGenerationMode())] || null;
}

function renderPresets() {
  const select = $('#preset-select');
  if (!select) return;

  const allPresets = normalizePresets(settings.presets);
  settings.presets = allPresets;
  const visible = presetsForCurrentMode();
  select.innerHTML = '';

  if (visible.length === 0) {
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = t('labels.noPreset');
    select.appendChild(emptyOption);
  }

  visible.forEach((preset) => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    select.appendChild(option);
  });

  const idKey = activePresetIdKey(currentGenerationMode());
  const activeId = settings[idKey];
  if (activeId && visible.some((preset) => preset.id === activeId)) {
    select.value = activeId;
  } else if (visible.length > 0) {
    settings[idKey] = visible[0].id;
    select.value = visible[0].id;
  } else {
    settings[idKey] = null;
    select.value = '';
  }
  syncActivePresetIdAlias();

  const hasActive = !!settings[idKey];
  $('#btn-save-preset').disabled = !hasActive || isProcessing;
  $('#btn-delete-preset').disabled = !hasActive || isProcessing;
  window.SharpSelect?.refresh(select);
}

async function createPreset() {
  syncSettingsFromControls();
  const input = $('#preset-name-input');
  const name = input.value.trim();
  if (!name) return;

  const now = new Date().toISOString();
  const preset = {
    id: createPresetId(),
    name,
    settings: capturePresetSettings(),
    paths: capturePresetPaths(),
    createdAt: now,
    updatedAt: now
  };

  settings.presets = [...normalizePresets(settings.presets), preset];
  settings[activePresetIdKey(currentGenerationMode())] = preset.id;
  syncActivePresetIdAlias();
  input.value = '';
  $('#btn-create-preset').disabled = true;
  await saveSettings();
  renderPresets();
}

async function saveCurrentPreset() {
  if (!settings.activePresetId) return;
  syncSettingsFromControls();
  await saveSettings();
  renderPresets();
}

async function applyPreset(id) {
  if (!id) {
    settings[activePresetIdKey(currentGenerationMode())] = null;
    syncActivePresetIdAlias();
    await saveSettings();
    renderPresets();
    return;
  }

  const presets = normalizePresets(settings.presets);
  const preset = presets.find((item) => item.id === id);
  if (!preset) return;

  // Presets are per-mode: a preset saved in another mode never applies here.
  if (presetMode(preset) !== currentGenerationMode()) return;

  settings = {
    ...settings,
    ...DEFAULT_SETTINGS,
    ...preset.settings,
    presets,
    activePresetId: preset.id
  };
  settings[activePresetIdKey(currentGenerationMode())] = preset.id;

  sourcePath = preset.paths?.sourcePath || null;
  bgFolderPath = preset.paths?.bgFolderPath || null;
  outputFolderPath = preset.paths?.outputFolderPath || null;

  syncSettingsToControls();
  applyTranslations();
  refreshBannerProbe();
  await saveSettings();
}

async function deleteActivePreset() {
  const idKey = activePresetIdKey(currentGenerationMode());
  if (!settings[idKey]) return;
  const activePreset = normalizePresets(settings.presets).find((preset) => preset.id === settings[idKey]);
  const name = activePreset?.name || 'preset';
  const message = uiLang === 'ru'
    ? `Удалить пресет "${name}"?`
    : `Delete preset "${name}"?`;
  if (!window.confirm(message)) return;

  settings.presets = normalizePresets(settings.presets).filter((preset) => preset.id !== settings[idKey]);
  settings[idKey] = null;
  syncActivePresetIdAlias();

  // Fall back to the next preset of the SAME mode, not another mode's one.
  const nextSameMode = presetsForCurrentMode().find((preset) => preset.id !== (activePreset?.id));
  if (nextSameMode) {
    await applyPreset(nextSameMode.id);
    return;
  }
  await saveSettings();
  renderPresets();
}

// ===== TABS =====
$$('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.nav-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    $('#tab-generator').style.display = target === 'generator' ? '' : 'none';
    $('#tab-settings').style.display = target === 'settings' ? '' : 'none';
    // The Settings tab is hidden at startup, so preview stage sizes are 0
    // until it is opened for the first time — rescale once it becomes visible.
    if (target === 'settings') syncSharedPreviewFrame();
  });
});

// ===== WINDOW CONTROLS =====
$('#btn-minimize').addEventListener('click', () => window.api.minimizeWindow());
$('#btn-maximize').addEventListener('click', () => window.api.maximizeWindow());
$('#btn-close').addEventListener('click', () => window.api.closeWindow());

// ===== FILE PICKERS =====
$('#pick-source').addEventListener('click', async () => {
  const p = await window.api.openFile([{ name: 'Audio / Video Files', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mkv', 'avi', 'mov', 'webm'] }]);
  if (p) { sourcePath = p; $('#source-label').textContent = p; $('#source-label').className = 'path'; }
  if (p && settings.activePresetId) saveSettings();
  updateGenerateBtn();
});

$('#pick-background').addEventListener('click', async () => {
  const p = await window.api.openFolder();
  if (p) { bgFolderPath = p; $('#bg-label').textContent = p; $('#bg-label').className = 'path'; }
  if (p && settings.activePresetId) saveSettings();
  updateGenerateBtn();
});

$('#pick-output').addEventListener('click', async () => {
  const p = await window.api.selectOutputFolder();
  if (p) { outputFolderPath = p; $('#output-label').textContent = p; $('#output-label').className = 'path'; }
  if (p && settings.activePresetId) saveSettings();
  updateGenerateBtn();
});

// ===== GENERATION MODE (Stories / Cinema) =====
function currentGenerationMode() {
  return settings.generationMode === 'cinema' ? 'cinema' : 'stories';
}

function applyGenerationModeUi() {
  const mode = currentGenerationMode();
  const isCinema = mode === 'cinema';
  $('#mode-stories').classList.toggle('active', !isCinema);
  $('#mode-cinema').classList.toggle('active', isCinema);
  $('#txt-mode-hint').textContent = t(isCinema ? 'labels.modeHintCinema' : 'labels.modeHintStories');
  // Scene count is a cinema-only setting: in stories mode the whole source
  // footage goes into the output clips.
  const sceneCountField = $('#cinema-scene-count-field');
  if (sceneCountField) sceneCountField.style.display = isCinema ? '' : 'none';
  syncActivePresetIdAlias();
  renderPresets();
  updateGenerateBtn();
}

function setGenerationMode(mode) {
  const normalized = mode === 'cinema' ? 'cinema' : 'stories';
  if (currentGenerationMode() === normalized) return;
  settings.generationMode = normalized;
  applyGenerationModeUi();
  saveSettings();
}

$('#mode-stories').addEventListener('click', () => setGenerationMode('stories'));
$('#mode-cinema').addEventListener('click', () => setGenerationMode('cinema'));

$('#cinema-scene-count').addEventListener('input', () => {
  const value = Math.max(5, Math.min(20, Number($('#cinema-scene-count').value) || 10));
  $('#cinema-scene-count-value').textContent = String(value);
  settings.cinemaSceneCount = value;
});

$('#cinema-scene-count').addEventListener('change', () => {
  saveSettings();
});

$('#cinema-fill-mode').addEventListener('change', () => {
  settings.cinemaFillMode = $('#cinema-fill-mode').value === 'blur' ? 'blur' : 'crop';
  saveSettings();
});

function clampCinemaTarget(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 45;
  return Math.max(10, Math.min(300, Math.round(n)));
}

function clampCinemaMax(value, targetSec) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 90;
  return Math.max(targetSec, Math.max(15, Math.min(600, Math.round(n))));
}

$('#cinema-target-sec').addEventListener('change', () => {
  const target = clampCinemaTarget($('#cinema-target-sec').value);
  $('#cinema-target-sec').value = String(target);
  settings.cinemaTargetSec = target;
  // Max can never be smaller than target — sync it when needed.
  if (clampCinemaMax($('#cinema-max-sec').value, target) < target || Number($('#cinema-max-sec').value) < target) {
    const max = clampCinemaMax($('#cinema-max-sec').value, target);
    $('#cinema-max-sec').value = String(max);
    settings.cinemaMaxSec = max;
  }
  saveSettings();
});

$('#cinema-max-sec').addEventListener('change', () => {
  const target = clampCinemaTarget($('#cinema-target-sec').value);
  const max = clampCinemaMax($('#cinema-max-sec').value, target);
  $('#cinema-max-sec').value = String(max);
  settings.cinemaMaxSec = max;
  saveSettings();
});

// ===== SETTINGS: PRESETS =====
$('#preset-name-input').addEventListener('input', () => {
  $('#btn-create-preset').disabled = !$('#preset-name-input').value.trim() || isProcessing;
});

$('#preset-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#btn-create-preset').disabled) createPreset();
});

$('#btn-create-preset').addEventListener('click', createPreset);
$('#btn-save-preset').addEventListener('click', saveCurrentPreset);
$('#btn-delete-preset').addEventListener('click', deleteActivePreset);

$('#preset-select').addEventListener('change', () => {
  applyPreset($('#preset-select').value);
});

// ===== SETTINGS: CUSTOM AI MODELS =====
function isCustomModelKey(key) {
  return String(key || '').startsWith('custom:');
}

function normalizeBaseUrlLocal(url) {
  const raw = String(url || '').trim().replace(/\/+$/, '');
  if (!raw || !/^https?:\/\//i.test(raw)) return '';
  return raw;
}

function getProviders() {
  return Array.isArray(settings.customProviders) ? settings.customProviders : [];
}

function getModels() {
  return Array.isArray(settings.customModels) ? settings.customModels : [];
}

function isChainResolvable(chain) {
  const models = new Set(getModels().map((model) => model.id));
  const keys = Array.isArray(chain) ? chain : [];
  return keys.length > 0 && keys.every((key) => isCustomModelKey(key) && models.has(key.slice('custom:'.length)));
}

function bothModelsCustom() {
  return isChainResolvable(settings.transcriptionChain) && isChainResolvable(settings.analysisChain);
}

function updateNoKeysWarning() {
  const missing = !bothModelsCustom();
  $('#no-keys-warning').style.display = missing ? '' : 'none';
}

function updateListCounts() {
  const counts = { providers: getProviders().length, models: getModels().length };
  Object.entries(counts).forEach(([key, value]) => {
    const el = $(`#count-${key}`);
    if (el) el.textContent = value > 0 ? `· ${value}` : '';
  });
}

function renderProviders() {
  const list = $('#provider-list');
  const select = $('#cm-provider');
  const providers = getProviders();
  settings.customProviders = providers;

  if (list) {
    list.innerHTML = '';
    if (providers.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'key-tag';
      empty.style.opacity = '0.6';
      empty.textContent = t('labels.provEmpty');
      list.appendChild(empty);
    }
    providers.forEach((provider) => {
      const tag = document.createElement('span');
      tag.className = 'key-tag';
      const modelCount = getModels().filter((model) => model.providerId === provider.id).length;
      tag.textContent = `${provider.name} · ${provider.baseUrl.replace(/^https?:\/\//, '')}${modelCount ? ` · ${modelCount}` : ''} `;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove';
      removeBtn.title = 'Remove provider';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => removeProvider(provider.id));
      tag.appendChild(removeBtn);
      list.appendChild(tag);
    });
  }

  if (select) {
    const prev = select.value;
    select.innerHTML = '';
    if (providers.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = t('labels.cmNoProvider');
      select.appendChild(option);
    }
    providers.forEach((provider) => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.name;
      select.appendChild(option);
    });
    const wanted = prev && providers.some((p) => p.id === prev) ? prev : (providers[0]?.id || '');
    select.value = wanted;
  }
  updateListCounts();
  window.SharpSelect?.refresh();
}

function renderCustomModels() {
  const list = $('#custom-model-list');
  const models = getModels();
  settings.customModels = models;

  if (list) {
    list.innerHTML = '';
    if (models.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'key-tag';
      empty.style.opacity = '0.6';
      empty.textContent = t('labels.cmEmpty');
      list.appendChild(empty);
    }
    models.forEach((model) => {
      const tag = document.createElement('span');
      tag.className = 'key-tag';
      const provider = getProviders().find((p) => p.id === model.providerId);
      const label = provider ? `${model.name} · ${provider.name}` : model.name;
      tag.textContent = `${label} `;
      tag.title = model.modelId;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove';
      removeBtn.title = 'Remove model';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => removeModel(model.id));
      tag.appendChild(removeBtn);
      list.appendChild(tag);
    });
  }

  renderChainSelect('tc');
  renderChainSelect('ac');
  renderChain('tc');
  renderChain('ac');
  updateListCounts();
  updateModelCount();
  updateNoKeysWarning();
}

function renderChainSelect(role) {
  const select = role === 'tc' ? $('#chain-tc-select') : $('#chain-ac-select');
  if (!select) return;
  const prev = select.value;
  const models = getModels();
  select.innerHTML = '';
  if (models.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = t('labels.cmEmpty');
    select.appendChild(option);
  }
  models.forEach((model) => {
    const option = document.createElement('option');
    option.value = `custom:${model.id}`;
    const provider = getProviders().find((p) => p.id === model.providerId);
    option.textContent = provider ? `${provider.name} · ${model.name}` : model.name;
    select.appendChild(option);
  });
  const wanted = prev && models.some((m) => `custom:${m.id}` === prev) ? prev : '';
  select.value = wanted;
  const addBtn = role === 'tc' ? $('#btn-chain-tc-add') : $('#btn-chain-ac-add');
  if (addBtn) addBtn.disabled = !wanted;
}

function renderChain(role) {
  const list = role === 'tc' ? $('#chain-tc-list') : $('#chain-ac-list');
  if (!list) return;
  const chainKey = role === 'tc' ? 'transcriptionChain' : 'analysisChain';
  const chain = Array.isArray(settings[chainKey]) ? settings[chainKey] : [];
  settings[chainKey] = chain;
  const models = getModels();
  list.innerHTML = '';

  if (chain.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'key-tag';
    empty.style.opacity = '0.6';
    empty.textContent = t('labels.chainEmpty');
    list.appendChild(empty);
    return;
  }

  chain.forEach((key, index) => {
    const modelId = key.slice('custom:'.length);
    const model = models.find((m) => m.id === modelId);
    const tag = document.createElement('span');
    tag.className = 'key-tag chain-tag';
    if (!model) tag.style.opacity = '0.5';
    const order = document.createElement('span');
    order.className = 'chain-order';
    order.textContent = `${index + 1}.`;
    tag.appendChild(order);

    // Two columns: provider name first, then the model display name — no
    // technical model ids. Both columns truncate with ellipsis when narrow.
    const provider = model ? getProviders().find((p) => p.id === model.providerId) : null;
    const providerCol = document.createElement('span');
    providerCol.className = 'chain-col provider-col';
    providerCol.textContent = provider ? provider.name : (model ? '—' : key);
    providerCol.title = provider ? provider.name : '';
    tag.appendChild(providerCol);

    const modelCol = document.createElement('span');
    modelCol.className = 'chain-col';
    modelCol.textContent = model ? model.name : key;
    modelCol.title = model ? model.name : key;
    tag.appendChild(modelCol);

    const upBtn = document.createElement('button');
    upBtn.className = 'move';
    upBtn.title = 'Move up';
    upBtn.textContent = '↑';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => moveChainItem(role, index, -1));
    tag.appendChild(upBtn);

    const downBtn = document.createElement('button');
    downBtn.className = 'move';
    downBtn.title = 'Move down';
    downBtn.textContent = '↓';
    downBtn.disabled = index === chain.length - 1;
    downBtn.addEventListener('click', () => moveChainItem(role, index, 1));
    tag.appendChild(downBtn);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove';
    removeBtn.title = 'Remove from chain';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeFromChain(role, index));
    tag.appendChild(removeBtn);
    list.appendChild(tag);
  });
}

function addProvider() {
  const baseUrl = normalizeBaseUrlLocal($('#cp-url').value);
  const apiKey = String($('#cp-key').value || '').trim();
  const name = String($('#cp-name').value || '').trim();
  if (!baseUrl || !apiKey) {
    window.alert(t('labels.provModelError'));
    return;
  }
  settings.customProviders = [
    ...getProviders(),
    {
      id: `prov-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: name || baseUrl.replace(/^https?:\/\//, ''),
      baseUrl,
      apiKey
    }
  ];
  saveSettings();
  $('#cp-name').value = '';
  $('#cp-url').value = '';
  $('#cp-key').value = '';
  $('#btn-add-provider').disabled = true;
  renderProviders();
  renderCustomModels();
  updateGenerateBtn();
}

function removeProvider(id) {
  settings.customProviders = getProviders().filter((provider) => provider.id !== id);
  // Drop models bound to the removed provider and prune chain entries.
  const removedModelIds = new Set(getModels().filter((model) => model.providerId === id).map((model) => model.id));
  settings.customModels = getModels().filter((model) => model.providerId !== id);
  ['transcriptionChain', 'analysisChain'].forEach((key) => {
    settings[key] = (Array.isArray(settings[key]) ? settings[key] : [])
      .filter((keyId) => !removedModelIds.has(String(keyId).slice('custom:'.length)));
  });
  saveSettings();
  renderProviders();
  renderCustomModels();
  updateGenerateBtn();
}

function addModel() {
  const providerId = String($('#cm-provider').value || '').trim();
  const modelId = String($('#cm-model').value || '').trim();
  const name = String($('#cm-name').value || '').trim();
  if (!providerId || !modelId) {
    window.alert(t('labels.cmModelError'));
    return;
  }
  settings.customModels = [
    ...getModels(),
    {
      id: `cm-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      providerId,
      name: name || modelId,
      modelId
    }
  ];
  saveSettings();
  $('#cm-name').value = '';
  $('#cm-model').value = '';
  $('#btn-add-model').disabled = true;
  renderCustomModels();
  updateGenerateBtn();
}

function removeModel(id) {
  settings.customModels = getModels().filter((model) => model.id !== id);
  // Prune chain entries pointing to the removed model.
  ['transcriptionChain', 'analysisChain'].forEach((key) => {
    settings[key] = (Array.isArray(settings[key]) ? settings[key] : [])
      .filter((keyId) => keyId !== `custom:${id}`);
  });
  saveSettings();
  renderCustomModels();
  updateNoKeysWarning();
  updateGenerateBtn();
}

function addToChain(role) {
  const select = role === 'tc' ? $('#chain-tc-select') : $('#chain-ac-select');
  const key = String(select?.value || '');
  if (!isCustomModelKey(key)) {
    window.alert(t('labels.chainModelError'));
    return;
  }
  const chainKey = role === 'tc' ? 'transcriptionChain' : 'analysisChain';
  const chain = Array.isArray(settings[chainKey]) ? settings[chainKey] : [];
  if (chain.includes(key)) {
    window.alert(t('labels.chainModelError'));
    return;
  }
  settings[chainKey] = [...chain, key];
  saveSettings();
  renderChainSelect(role);
  renderChain(role);
  updateNoKeysWarning();
  updateGenerateBtn();
}

function removeFromChain(role, index) {
  const chainKey = role === 'tc' ? 'transcriptionChain' : 'analysisChain';
  const chain = Array.isArray(settings[chainKey]) ? settings[chainKey] : [];
  settings[chainKey] = chain.filter((_, i) => i !== index);
  saveSettings();
  renderChain(role);
  updateNoKeysWarning();
  updateGenerateBtn();
}

function moveChainItem(role, index, delta) {
  const chainKey = role === 'tc' ? 'transcriptionChain' : 'analysisChain';
  const chain = [...(Array.isArray(settings[chainKey]) ? settings[chainKey] : [])];
  const target = index + delta;
  if (target < 0 || target >= chain.length) return;
  [chain[index], chain[target]] = [chain[target], chain[index]];
  settings[chainKey] = chain;
  saveSettings();
  renderChain(role);
}

// Collapsible subsections (providers / models / chains): the state is
// remembered between sessions via localStorage.
const COLLAPSE_STORAGE_KEY = 'shotshorts-collapsed-lists';

function loadCollapsedSections() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveCollapsedSections(state) {
  try { localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function applyCollapsible(title, body, collapsed) {
  body.style.display = collapsed ? 'none' : '';
  title.classList.toggle('collapsed', collapsed);
  const chevron = title.querySelector('.chevron');
  if (chevron) chevron.textContent = collapsed ? '▸' : '▾';
}

function bindCollapsibleSection(titleId, bodyId, storageKey) {
  const title = $(`#${titleId}`);
  const body = $(`#${bodyId}`);
  if (!title || !body) return;
  applyCollapsible(title, body, !!loadCollapsedSections()[storageKey]);
  title.addEventListener('click', () => {
    const state = loadCollapsedSections();
    state[storageKey] = !state[storageKey];
    saveCollapsedSections(state);
    applyCollapsible(title, body, !!state[storageKey]);
  });
}

bindCollapsibleSection('title-providers', 'body-providers', 'providers');
bindCollapsibleSection('title-models', 'body-models', 'models');
bindCollapsibleSection('title-chains', 'body-chains', 'chains');

$('#btn-add-provider').addEventListener('click', addProvider);
['cp-url', 'cp-key'].forEach((id) => {
  $(`#${id}`).addEventListener('input', () => {
    const ok = normalizeBaseUrlLocal($('#cp-url').value)
      && String($('#cp-key').value || '').trim();
    $('#btn-add-provider').disabled = !ok;
  });
  $(`#${id}`).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('#btn-add-provider').disabled) addProvider();
  });
});

$('#btn-add-model').addEventListener('click', addModel);
['cm-model', 'cm-name'].forEach((id) => {
  $(`#${id}`).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('#btn-add-model').disabled) addModel();
  });
});
$('#cm-model').addEventListener('input', () => {
  $('#btn-add-model').disabled = !String($('#cm-model').value || '').trim();
});

$('#btn-chain-tc-add').addEventListener('click', () => addToChain('tc'));
$('#btn-chain-ac-add').addEventListener('click', () => addToChain('ac'));
// The chain Add buttons start disabled and only light up when a custom model
// is actually picked in the dropdown — without these change listeners the
// buttons never re-enabled after render.
['chain-tc-select', 'chain-ac-select'].forEach((id) => {
  $(`#${id}`).addEventListener('change', () => {
    const btn = $(id === 'chain-tc-select' ? '#btn-chain-tc-add' : '#btn-chain-ac-add');
    if (btn) btn.disabled = !isCustomModelKey($(`#${id}`).value);
  });
});

// ===== SETTINGS: PROXY =====
$('#proxy-toggle').addEventListener('change', () => {
  const on = $('#proxy-toggle').checked;
  $('#proxy-fields').style.opacity = on ? '1' : '0.4';
  $('#proxy-fields').style.pointerEvents = on ? 'auto' : 'none';
  setContainerControlsDisabled('#proxy-fields', !on);
  updateProxySettings();
});

['proxy-host', 'proxy-port', 'proxy-user', 'proxy-pass'].forEach(id => {
  $(`#${id}`).addEventListener('input', updateProxySettings);
});
$('#proxy-type').addEventListener('change', updateProxySettings);

function updateProxySettings() {
  if ($('#proxy-toggle').checked) {
    settings.proxy = {
      type: $('#proxy-type').value,
      host: $('#proxy-host').value,
      port: $('#proxy-port').value,
      username: $('#proxy-user').value,
      password: $('#proxy-pass').value
    };
  } else {
    settings.proxy = null;
  }
  saveSettings();
}

const SUBTITLE_STYLE_FONT_SIZES = {
  Classic: 20,
  Minimal: 18,
  Highlight: 22,
  TikTokBold: 24,
  HeavyShadow: 24,
  SoftBox: 20
};

function syncSubtitleStyleFontSize() {
  // Apply preset default font size ONLY if the user hasn't customized it yet
  // (current value matches some other preset's default). This avoids silently
  // overriding a manually chosen font size.
  const style = $('#subtitle-style')?.value || 'Classic';
  const presetSize = SUBTITLE_STYLE_FONT_SIZES[style];
  if (!presetSize) return;
  const currentSize = Number($('#subtitle-font-size')?.value || 0);
  const presetValues = new Set(Object.values(SUBTITLE_STYLE_FONT_SIZES));
  const looksLikePresetDefault = presetValues.has(currentSize);
  if (looksLikePresetDefault && currentSize !== presetSize) {
    $('#subtitle-font-size').value = String(presetSize);
    settings.subtitleFontSize = presetSize;
  }
}

// ===== SETTINGS: SUBTITLES =====
function setContainerControlsDisabled(containerId, disabled) {
  const container = $(containerId);
  if (!container) return;
  container.querySelectorAll('input, select, button').forEach(el => {
    if (containerId === '#subtitle-fields' && !disabled) {
      if (el.closest('#subtitle-karaoke-modes') || el.id === 'karaoke-mode-highlight' || el.id === 'karaoke-mode-box' || el.id === 'karaoke-mode-caps') {
        return;
      }
    }
    el.disabled = disabled;
  });
  window.SharpSelect?.refresh(container);
}

function updateKaraokeFieldsState() {
  const subsEnabled = !!$('#subtitles-toggle').checked;
  const karaokeEnabled = !!$('#subtitle-karaoke').checked;
  const on = subsEnabled && karaokeEnabled;
  
  const karaokeLeft = $('.karaoke-left');
  if (karaokeLeft) {
    karaokeLeft.style.opacity = on ? '1' : '0.4';
    karaokeLeft.style.pointerEvents = on ? 'auto' : 'none';
  }
  $$('#subtitle-karaoke-modes input').forEach(input => {
    input.disabled = !on;
  });
}

function setSubtitleFieldsExpanded(on) {
  const fields = $('#subtitle-fields');
  if (!fields) return;
  fields.style.display = '';
  fields.style.opacity = on ? '1' : '0.4';
  fields.style.pointerEvents = on ? 'auto' : 'none';
  setContainerControlsDisabled('#subtitle-fields', !on);
}

// ===== SETTINGS: BANNER =====
const BANNER_MIN_SIZE = 20;
const BANNER_MAX_WIDTH = 2160;
const BANNER_MAX_HEIGHT = 3840;
const BANNER_MIN_VISIBLE = 10;

function clampBannerSize(value, max) {
  const num = Math.round(Number(value) || 0);
  return Math.max(BANNER_MIN_SIZE, Math.min(max, num));
}

function clampBannerOpacity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 100;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function clampBannerSeconds(value, fallback, min, max) {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

// Invisible snap guides along both axes: the banner's start edge, center and
// end edge stick to the canvas start / center / end when within threshold.
const BANNER_SNAP_THRESHOLD = 28;

function snapBannerCoord(pos, size, canvas) {
  if (Math.abs(pos) <= BANNER_SNAP_THRESHOLD) return 0;
  if (Math.abs(pos + size / 2 - canvas / 2) <= BANNER_SNAP_THRESHOLD) return canvas / 2 - size / 2;
  if (Math.abs(pos + size - canvas) <= BANNER_SNAP_THRESHOLD) return canvas - size;
  return pos;
}

// The banner may hang outside the 1080x1920 frame, but at least
// BANNER_MIN_VISIBLE pixels always stay inside so it cannot be lost.
function clampBannerPos(x, y, width, height) {
  return {
    x: Math.round(Math.max(-width + BANNER_MIN_VISIBLE, Math.min(1080 - BANNER_MIN_VISIBLE, Number(x) || 0))),
    y: Math.round(Math.max(-height + BANNER_MIN_VISIBLE, Math.min(1920 - BANNER_MIN_VISIBLE, Number(y) || 0)))
  };
}

function setBannerFieldsExpanded(on) {
  const fields = $('#banner-fields');
  if (!fields) return;
  fields.style.opacity = on ? '1' : '0.4';
  fields.style.pointerEvents = on ? 'auto' : 'none';
  setContainerControlsDisabled('#banner-fields', !on);
}

function syncBannerLabel() {
  const label = $('#banner-label');
  if (label) {
    if (settings.bannerPath) {
      label.textContent = settings.bannerPath;
      label.className = 'path';
    } else {
      label.textContent = t('labels.bannerPlaceholder');
      label.className = 'label';
    }
  }
  const removeBtn = $('#btn-remove-banner');
  if (removeBtn) removeBtn.disabled = !settings.bannerPath || isProcessing;
  const resetBtn = $('#btn-reset-banner');
  if (resetBtn) resetBtn.disabled = !settings.bannerPath || isProcessing;
}

function bannerPreviewScale() {
  const stage = $('#subtitle-preview-stage');
  // Hidden stage (e.g. Settings tab closed at startup) has zero size —
  // report 0 so callers keep the previous transform instead of scale(0).
  if (!stage || !stage.clientWidth || !stage.clientHeight) return 0;
  return Math.min(stage.clientWidth / 1080, stage.clientHeight / 1920);
}

function bannerHeightFromAspect(width) {
  const aspect = Number.isFinite(bannerAspect) && bannerAspect > 0 ? bannerAspect : 9 / 16;
  let height = Math.round(width * aspect);
  if (height % 2 !== 0) height += 1;
  return Math.max(BANNER_MIN_SIZE, Math.min(BANNER_MAX_HEIGHT, height));
}

function isBannerActive() {
  return !!$('#banner-toggle')?.checked && !!settings.bannerPath;
}

// Shared 1080x1920 preview frame: subtitles overlay + draggable banner item.
// Visible when subtitles are enabled OR a banner is selected.
function syncSharedPreviewFrame() {
  const stage = $('#subtitle-preview-stage');
  const frame = $('#subtitle-preview-frame');
  const overlay = $('#subtitle-preview-overlay');
  const card = document.querySelector('.subtitle-preview-card');
  const dragHint = $('#preview-drag-hint');
  if (!stage || !frame) return;

  const subsOn = !!$('#subtitles-toggle')?.checked;
  const bannerOn = isBannerActive();

  if (overlay) overlay.style.display = subsOn ? '' : 'none';
  if (dragHint) dragHint.style.display = bannerOn ? '' : 'none';

  const expanded = subsOn || bannerOn;
  if (card) card.classList.toggle('collapsed', !expanded);
  stage.style.display = expanded ? '' : 'none';

  if (expanded) {
    const scale = bannerPreviewScale();
    if (scale > 0) frame.style.transform = `scale(${scale})`;
  }
}

function updateBannerPreview() {
  const item = $('#banner-preview-item');
  if (!item) return;

  const hasBanner = isBannerActive();
  item.style.display = hasBanner ? '' : 'none';
  if (!hasBanner) {
    syncSharedPreviewFrame();
    return;
  }

  const width = clampBannerSize(settings.bannerWidth || 300, BANNER_MAX_WIDTH);
  const height = clampBannerSize(settings.bannerHeight || 150, BANNER_MAX_HEIGHT);
  const pos = clampBannerPos(settings.bannerX, settings.bannerY, width, height);

  item.style.left = `${pos.x}px`;
  item.style.top = `${pos.y}px`;
  item.style.width = `${width}px`;
  item.style.height = `${height}px`;

  // Opacity applies to the banner picture only; the frame and handles stay
  // visible so a fully transparent banner can still be grabbed and restored.
  const media = $('#banner-preview-media');
  if (media) {
    media.style.opacity = String(clampBannerOpacity(settings.bannerOpacity) / 100);
    if (bannerThumbnail) {
      media.style.backgroundImage = `url("${bannerThumbnail}")`;
      item.classList.add('has-media');
    } else {
      media.style.backgroundImage = '';
      item.classList.remove('has-media');
    }
  }
  syncSharedPreviewFrame();
}

async function probeBannerFile(filePath) {
  try {
    const res = await window.api.probeMedia(filePath);
    if (!res || !res.success) throw new Error(res?.error || 'probe failed');
    bannerAspect = res.height / res.width;
    bannerThumbnail = res.thumbnail || null;
    return true;
  } catch (err) {
    console.error('Banner probe failed:', err);
    bannerAspect = null;
    bannerThumbnail = null;
    return false;
  }
}

async function refreshBannerProbe() {
  if (settings.bannerPath) {
    await probeBannerFile(settings.bannerPath);
  } else {
    bannerAspect = null;
    bannerThumbnail = null;
  }
  syncBannerLabel();
  updateBannerPreview();
}

function removeBanner() {
  settings.bannerPath = '';
  bannerAspect = null;
  bannerThumbnail = null;
  syncBannerLabel();
  updateBannerPreview();
  saveSettings();
}

function resetBannerLayout() {
  settings.bannerX = 740;
  settings.bannerY = 60;
  settings.bannerWidth = 300;
  settings.bannerHeight = bannerHeightFromAspect(300);
  const widthInput = $('#banner-width');
  if (widthInput) widthInput.value = String(settings.bannerWidth);
  const heightInput = $('#banner-height');
  if (heightInput) heightInput.value = String(settings.bannerHeight);
  updateBannerPreview();
  saveSettings();
}

$('#banner-toggle').addEventListener('change', () => {
  const on = $('#banner-toggle').checked;
  setBannerFieldsExpanded(on);
  settings.bannerEnabled = on;
  saveSettings();
  updateBannerPreview();
});

$('#banner-width').addEventListener('input', () => {
  const raw = Number($('#banner-width').value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return;
  const width = clampBannerSize(raw, BANNER_MAX_WIDTH);
  const height = clampBannerSize(settings.bannerHeight || 150, BANNER_MAX_HEIGHT);
  settings.bannerWidth = width;
  const pos = clampBannerPos(settings.bannerX, settings.bannerY, width, height);
  settings.bannerX = pos.x;
  settings.bannerY = pos.y;
  saveSettings();
  updateBannerPreview();
});

$('#banner-height').addEventListener('input', () => {
  const raw = Number($('#banner-height').value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return;
  const width = clampBannerSize(settings.bannerWidth || 300, BANNER_MAX_WIDTH);
  const height = clampBannerSize(raw, BANNER_MAX_HEIGHT);
  settings.bannerHeight = height;
  const pos = clampBannerPos(settings.bannerX, settings.bannerY, width, height);
  settings.bannerX = pos.x;
  settings.bannerY = pos.y;
  saveSettings();
  updateBannerPreview();
});

$('#banner-opacity').addEventListener('input', () => {
  const val = clampBannerOpacity($('#banner-opacity').value);
  settings.bannerOpacity = val;
  const valEl = $('#banner-opacity-value');
  if (valEl) valEl.textContent = `${val}%`;
  saveSettings();
  updateBannerPreview();
});

['banner-mode', 'banner-interval-sec'].forEach((id) => {
  $(`#${id}`).addEventListener('change', () => {
    settings.bannerMode = $('#banner-mode')?.value === 'interstitial' ? 'interstitial' : 'overlay';
    settings.bannerIntervalSec = clampBannerSeconds($('#banner-interval-sec').value, 60, 5, 3600);
    saveSettings();
  });
});

$('#pick-banner').addEventListener('click', async () => {
  const p = await window.api.openFile([
    {
      name: 'Images & Videos',
      extensions: [
        'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif',
        'mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts',
        '3gp', '3gpp', 'ogv', 'vob', 'f4v', 'asf', 'divx', 'rm', 'rmvb'
      ]
    },
    { name: 'All Files', extensions: ['*'] }
  ]);
  if (!p) return;
  const ok = await probeBannerFile(p);
  if (!ok) {
    window.alert(t('labels.bannerProbeError'));
    return;
  }
  settings.bannerPath = p;
  // Initial height follows the media aspect ratio; the user can stretch freely afterwards.
  settings.bannerHeight = bannerHeightFromAspect(clampBannerSize(settings.bannerWidth || 300, BANNER_MAX_WIDTH));
  const heightInput = $('#banner-height');
  if (heightInput) heightInput.value = String(settings.bannerHeight);
  syncBannerLabel();
  updateBannerPreview();
  saveSettings();
});

$('#btn-remove-banner').addEventListener('click', removeBanner);
$('#btn-reset-banner').addEventListener('click', resetBannerLayout);

let bannerDragState = null;

$('#banner-preview-item').addEventListener('pointerdown', (e) => {
  if (!settings.bannerPath) return;
  e.preventDefault();
  e.stopPropagation();
  const handle = e.target.closest ? e.target.closest('.banner-handle') : null;
  const scale = bannerPreviewScale() || 1;
  if (handle) {
    const origWidth = Number(settings.bannerWidth || 300);
    const origHeight = Number(settings.bannerHeight || 150);
    bannerDragState = {
      mode: 'resize',
      axis: handle.dataset.axis || 'se',
      startX: e.clientX,
      startY: e.clientY,
      origWidth,
      origHeight,
      ratio: origWidth > 0 ? origHeight / origWidth : 1,
      scale
    };
  } else {
    bannerDragState = {
      mode: 'move',
      startX: e.clientX,
      startY: e.clientY,
      origX: Number(settings.bannerX || 0),
      origY: Number(settings.bannerY || 0),
      scale
    };
  }
  $('#banner-preview-item').classList.add('dragging');
});

window.addEventListener('pointermove', (e) => {
  if (!bannerDragState) return;
  e.preventDefault();
  const st = bannerDragState;
  const dx = (e.clientX - st.startX) / st.scale;
  const dy = (e.clientY - st.startY) / st.scale;

  if (st.mode === 'move') {
    const width = clampBannerSize(settings.bannerWidth || 300, BANNER_MAX_WIDTH);
    const height = clampBannerSize(settings.bannerHeight || 150, BANNER_MAX_HEIGHT);
    const pos = clampBannerPos(st.origX + dx, st.origY + dy, width, height);
    const snappedX = snapBannerCoord(pos.x, width, 1080);
    const snappedY = snapBannerCoord(pos.y, height, 1920);
    const finalPos = clampBannerPos(snappedX, snappedY, width, height);
    settings.bannerX = finalPos.x;
    settings.bannerY = finalPos.y;
  } else if (st.mode === 'resize') {
    let width;
    let height;
    if (st.axis === 'se') {
      // Corner handle scales proportionally so the picture is never distorted.
      const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      width = clampBannerSize(st.origWidth + delta, BANNER_MAX_WIDTH);
      height = clampBannerSize(Math.round(width * st.ratio), BANNER_MAX_HEIGHT);
      width = clampBannerSize(Math.round(height / st.ratio), BANNER_MAX_WIDTH);
    } else {
      width = clampBannerSize(st.origWidth, BANNER_MAX_WIDTH);
      height = clampBannerSize(st.origHeight, BANNER_MAX_HEIGHT);
      if (st.axis.includes('e')) width = clampBannerSize(st.origWidth + dx, BANNER_MAX_WIDTH);
      if (st.axis.includes('s')) height = clampBannerSize(st.origHeight + dy, BANNER_MAX_HEIGHT);
    }
    settings.bannerWidth = width;
    settings.bannerHeight = height;
    const pos = clampBannerPos(settings.bannerX, settings.bannerY, width, height);
    settings.bannerX = pos.x;
    settings.bannerY = pos.y;
    const widthInput = $('#banner-width');
    if (widthInput) widthInput.value = String(width);
    const heightInput = $('#banner-height');
    if (heightInput) heightInput.value = String(height);
  }
  updateBannerPreview();
});

window.addEventListener('pointerup', () => {
  if (!bannerDragState) return;
  bannerDragState = null;
  $('#banner-preview-item')?.classList.remove('dragging');
  saveSettings();
});


$('#subtitles-toggle').addEventListener('change', () => {
  const on = $('#subtitles-toggle').checked;
  setSubtitleFieldsExpanded(on);
  updateKaraokeFieldsState();
  settings.subtitlesEnabled = on;
  settings.subtitleStyle = $('#subtitle-style').value;
  settings.subtitleLanguage = $('#subtitle-language').value;
  settings.subtitlePosition = $('#subtitle-position').value;
  settings.subtitleWordsPerLine = Number($('#subtitle-words-per-line').value || 3);
  settings.subtitleMaxLineMs = Number($('#subtitle-max-line-ms').value || 1200);
  settings.subtitleFontSize = Number($('#subtitle-font-size').value || 20);
  settings.subtitleFontFamily = $('#subtitle-font-family').value || 'Inter';
  settings.subtitleMarginV = Number($('#subtitle-margin-v').value || 40);
  settings.subtitleOffsetMs = Number($('#subtitle-offset').value || 0);
  settings.subtitleKaraoke = !!$('#subtitle-karaoke').checked;
  settings.subtitleKaraokeEffects = getSelectedKaraokeEffects();
  settings.subtitleKaraokeMode = legacyModeFromEffects(settings.subtitleKaraokeEffects);
  // New: store case setting for karaoke
  settings.subtitleCase = $('#subtitle-case').value || 'sentence';
  saveSettings();
  updateSubtitlePreview();
});

['subtitle-style', 'subtitle-language', 'subtitle-font-family', 'subtitle-case'].forEach(id => {
  $(`#${id}`).addEventListener('change', () => {
    settings.subtitleStyle = $('#subtitle-style').value;
    settings.subtitleLanguage = $('#subtitle-language').value;
    settings.subtitleFontFamily = $('#subtitle-font-family').value || 'Inter';
    settings.subtitleKaraokeEffects = getSelectedKaraokeEffects();
    settings.subtitleKaraokeMode = legacyModeFromEffects(settings.subtitleKaraokeEffects);
    settings.subtitleCase = $('#subtitle-case').value || 'sentence';
    if (id === 'subtitle-style') {
      syncSubtitleStyleFontSize();
    }
    saveSettings();
    updateSubtitlePreview();
  });
});
['subtitle-position', 'subtitle-words-per-line', 'subtitle-max-line-ms', 'subtitle-font-size', 'subtitle-margin-v'].forEach(id => {
  $(`#${id}`).addEventListener('input', () => {
    settings.subtitlePosition = $('#subtitle-position').value;
    settings.subtitleWordsPerLine = Number($('#subtitle-words-per-line').value || 3);
    settings.subtitleMaxLineMs = Number($('#subtitle-max-line-ms').value || 1200);
    settings.subtitleFontSize = Number($('#subtitle-font-size').value || 20);
    settings.subtitleMarginV = Number($('#subtitle-margin-v').value || 40);
    saveSettings();
    updateSubtitlePreview();
  });
});
$('#subtitle-offset').addEventListener('input', () => {
  const val = $('#subtitle-offset').value;
  $('#subtitle-offset-value').textContent = val > 0 ? `+${val} ms` : `${val} ms`;
  settings.subtitleOffsetMs = Number(val);
  saveSettings();
});
$('#subtitle-karaoke').addEventListener('change', () => {
  updateKaraokeFieldsState();
  settings.subtitleKaraoke = !!$('#subtitle-karaoke').checked;
  settings.subtitleKaraokeEffects = getSelectedKaraokeEffects();
  settings.subtitleKaraokeMode = legacyModeFromEffects(settings.subtitleKaraokeEffects);
  saveSettings();
  updateSubtitlePreview();
});
['karaoke-mode-highlight', 'karaoke-mode-box', 'karaoke-mode-caps'].forEach(id => {
  $(`#${id}`)?.addEventListener('change', () => {
    settings.subtitleKaraokeEffects = getSelectedKaraokeEffects();
    settings.subtitleKaraokeMode = legacyModeFromEffects(settings.subtitleKaraokeEffects);
    saveSettings();
    updateSubtitlePreview();
  });
});

// ===== SUBTITLES: FREE POSITION =====
function isSubtitleFreePosActive() {
  return !!$('#subtitles-toggle')?.checked && !!$('#subtitle-custom-pos')?.checked;
}

function setSubtitleCustomPosUi(on) {
  ['subtitle-position-group', 'subtitle-margin-group'].forEach((id) => {
    const group = $('#' + id);
    if (!group) return;
    group.style.opacity = on ? '0.4' : '1';
    group.style.pointerEvents = on ? 'none' : 'auto';
    group.querySelectorAll('input, select').forEach((el) => { el.disabled = on; });
  });
  window.SharpSelect?.refresh();
}

$('#subtitle-custom-pos').addEventListener('change', () => {
  const on = $('#subtitle-custom-pos').checked;
  setSubtitleCustomPosUi(on);
  settings.subtitleCustomPos = on;
  saveSettings();
  updateSubtitlePreview();
});

let subtitleDragState = null;

$('#subtitle-preview-overlay').addEventListener('pointerdown', (e) => {
  if (!isSubtitleFreePosActive()) return;
  e.preventDefault();
  e.stopPropagation();
  const overlay = $('#subtitle-preview-overlay');
  const scale = bannerPreviewScale() || 1;
  if (e.target.closest && e.target.closest('#subtitle-preview-handle')) {
    // Corner handle: the text frame keeps its shape and scales
    // proportionally (both axes together) — mapped to font size.
    subtitleDragState = {
      mode: 'scale',
      startX: e.clientX,
      startY: e.clientY,
      origSize: Number($('#subtitle-font-size').value || 20),
      startW: overlay.offsetWidth || 1,
      scale
    };
  } else {
    subtitleDragState = {
      mode: 'move',
      startX: e.clientX,
      startY: e.clientY,
      origX: Number(settings.subtitleX || 540),
      origY: Number(settings.subtitleY || 1850),
      scale
    };
  }
  overlay.classList.add('dragging');
});

window.addEventListener('pointermove', (e) => {
  if (!subtitleDragState) return;
  e.preventDefault();
  const st = subtitleDragState;

  if (st.mode === 'move') {
    // X/Y anchor is the block center (ASS \pos + Alignment 5).
    const x = Math.max(0, Math.min(1080, st.origX + (e.clientX - st.startX) / st.scale));
    const y = Math.max(0, Math.min(1920, st.origY + (e.clientY - st.startY) / st.scale));
    const overlay = $('#subtitle-preview-overlay');
    const bw = (overlay ? overlay.offsetWidth : 200) / st.scale;
    const bh = (overlay ? overlay.offsetHeight : 60) / st.scale;
    // Snap guides work on top-left coordinates — convert center -> corner,
    // snap, then back so the invisible sticks match the banner's.
    settings.subtitleX = Math.round(Math.max(0, Math.min(1080, snapBannerCoord(x - bw / 2, bw, 1080) + bw / 2)));
    settings.subtitleY = Math.round(Math.max(0, Math.min(1920, snapBannerCoord(y - bh / 2, bh, 1920) + bh / 2)));
  } else if (st.mode === 'scale') {
    const factor = (st.startW + (e.clientX - st.startX)) / st.startW;
    const size = Math.max(12, Math.min(72, Math.round(st.origSize * factor)));
    settings.subtitleFontSize = size;
    const sizeInput = $('#subtitle-font-size');
    if (sizeInput) sizeInput.value = String(size);
  }
  updateSubtitlePreview();
});

window.addEventListener('pointerup', () => {
  if (!subtitleDragState) return;
  subtitleDragState = null;
  $('#subtitle-preview-overlay')?.classList.remove('dragging');
  saveSettings();
});
$('#app-language').addEventListener('change', () => {
  settings.appLanguage = $('#app-language').value;
  uiLang = settings.appLanguage || 'en';
  applyTranslations();
  saveSettings();
});

$('#app-theme').addEventListener('change', () => {
  settings.appTheme = normalizeTheme($('#app-theme').value);
  applyTheme(settings.appTheme);
  saveSettings();
});


function updateModelCount() {
  const count = (Array.isArray(settings.customModels) ? settings.customModels : []).length;
  $('#key-count').textContent = count > 0
    ? (uiLang === 'ru' ? `Моделей: ${count}` : `Models: ${count}`)
    : (uiLang === 'ru' ? 'Добавь ИИ-модель' : 'No AI models');
}

function updateGenerateBtn() {
  const modelsOk = bothModelsCustom();
  const bgRequired = currentGenerationMode() !== 'cinema';
  const canStart = sourcePath && (!bgRequired || bgFolderPath) && outputFolderPath && modelsOk && !isProcessing;
  $('#btn-generate').disabled = !canStart;
}

$('#btn-generate').addEventListener('click', startGeneration);
$('#btn-cancel').addEventListener('click', cancelGeneration);

async function startGeneration() {
  isProcessing = true;
  cancelRequested = false;
  setControlsDisabled(true);
  processStartTime = Date.now();
  const isCinema = currentGenerationMode() === 'cinema';
  etaEstimator = createEtaEstimator(stats.stageTimesMs || {}, { isCinema });
  etaEstimator.onEvent({ stage: 'extract', stagePercent: 0 });
  updateGenerateBtn();
  setStatus('processing', 'Processing…');
  showProgress('Initializing…', 0, 'Starting pipeline', { stage: 'extract', stagePercent: 0 });
  $('#btn-generate').style.display = 'none';
  $('#btn-cancel').style.display = '';

  etaInterval = setInterval(updateEta, 1000);

  progressCleanup = window.api.onProgress((data) => {
    showProgress(data.step, data.percent, data.message, data);
  });

  try {
    const result = await window.api.startProcessing({
      sourceVideo: sourcePath,
      mode: currentGenerationMode(),
      cinemaSceneCount: Math.max(5, Math.min(20, Number(settings.cinemaSceneCount) || 10)),
      cinemaFillMode: settings.cinemaFillMode === 'blur' ? 'blur' : 'crop',
      cinemaTargetSec: clampCinemaTarget(settings.cinemaTargetSec),
      cinemaMaxSec: clampCinemaMax(settings.cinemaMaxSec, clampCinemaTarget(settings.cinemaTargetSec)),
      backgroundFolder: currentGenerationMode() === 'cinema' ? '' : bgFolderPath,
      outputFolder: outputFolderPath,
      subtitlesEnabled: !!settings.subtitlesEnabled,
      subtitleStyle: settings.subtitleStyle || 'Classic',
      subtitleLanguage: settings.subtitleLanguage || 'ru',
      subtitlePosition: settings.subtitlePosition || 'bottom',
      subtitleWordsPerLine: Number(settings.subtitleWordsPerLine || 3),
      subtitleMaxLineMs: Number(settings.subtitleMaxLineMs || 1200),
      subtitleFontSize: Number(settings.subtitleFontSize || 20),
      subtitleFontFamily: settings.subtitleFontFamily || 'Inter',
      subtitleMarginV: Number(settings.subtitleMarginV || 40),
      subtitleOffsetMs: Number(settings.subtitleOffsetMs || 0),
      subtitleKaraoke: !!settings.subtitleKaraoke,
      subtitleKaraokeMode: settings.subtitleKaraokeMode || 'highlight',
      subtitleKaraokeEffects: Array.isArray(settings.subtitleKaraokeEffects) ? settings.subtitleKaraokeEffects : ['highlight'],
      subtitleCase: settings.subtitleCase || 'sentence',
      subtitleCustomPos: !!settings.subtitleCustomPos,
      subtitleX: Number(settings.subtitleX || 540),
      subtitleY: Number(settings.subtitleY || 1850),
      bannerEnabled: !!settings.bannerEnabled,
      bannerPath: settings.bannerPath || '',
      bannerX: Number(settings.bannerX || 0),
      bannerY: Number(settings.bannerY || 0),
      bannerWidth: Number(settings.bannerWidth || 300),
      bannerHeight: Number(settings.bannerHeight || 150),
      bannerOpacity: clampBannerOpacity(settings.bannerOpacity),
      bannerMode: ['overlay', 'interstitial'].includes(settings.bannerMode) ? settings.bannerMode : 'overlay',
      bannerIntervalSec: clampBannerSeconds(settings.bannerIntervalSec, 60, 5, 3600),
      customProviders: getProviders(),
      customModels: getModels(),
      transcriptionChain: Array.isArray(settings.transcriptionChain) ? settings.transcriptionChain : [],
      analysisChain: Array.isArray(settings.analysisChain) ? settings.analysisChain : []
    });

    const renderTimeMs = Date.now() - processStartTime;

    if (result.success) {
      const count = result.outputFiles?.length || 0;
      const elapsed = Date.now() - processStartTime;
      recordStageHistory(elapsed, result.chunksProduced || result.storiesDetected || count || 0);
      etaEstimator.complete();
      setStatus('done', 'Complete');
      showProgress('Done!', 100, `Created ${count} video(s)`, { stage: 'finalize', stagePercent: 100 });
      stats.totalVideos += count;
      stats.totalRenderTimeMs += renderTimeMs;
      stats.lastRun = new Date().toLocaleString();
      saveStats();
      renderStats();
    } else if (result.cancelled) {
      setStatus('idle', 'Ready');
      showProgress('Cancelled', 0, 'Generation cancelled', { raw: true });
    } else {
      setStatus('error', 'Error');
      showProgress('Error', 0, result.error || 'Unknown error', { raw: true });
    }
  } catch (err) {
    if (cancelRequested) {
      setStatus('idle', 'Ready');
      showProgress('Cancelled', 0, 'Generation cancelled', { raw: true });
    } else {
      setStatus('error', 'Error');
      showProgress('Error', 0, String(err), { raw: true });
    }
  } finally {
    isProcessing = false;
    cancelRequested = false;
    setControlsDisabled(false);
    processStartTime = null;
    etaEstimator = null;
    if (etaInterval) { clearInterval(etaInterval); etaInterval = null; }
    if (progressCleanup) progressCleanup();
    $('#btn-generate').style.display = '';
    $('#btn-cancel').style.display = 'none';
    $('#btn-cancel').disabled = false;
    updateGenerateBtn();
  }
}

// Fold the observed per-stage wall times into the long-term history stored in
// stats. Render gets an accurate per-chunk figure; length-dependent stages
// (transcribe/analyze/scenes) are normalized to one minute of source material.
function recordStageHistory(runTotalMs, chunkCount) {
  if (!etaEstimator) return;
  const durations = etaEstimator.collectStageDurations();
  const sourceMinutes = etaEstimator.getSourceMinutes();
  const chunks = Math.max(1, chunkCount || etaEstimator.currentChunkCount() || 1);
  const store = stats.stageTimesMs && typeof stats.stageTimesMs === 'object' ? stats.stageTimesMs : {};
  for (const stage of STAGE_ORDER) {
    const d = durations[stage];
    if (!d || d.ms <= 0) continue;
    let perChunkMs = 0;
    if (stage === 'render') {
      perChunkMs = d.ms / chunks;
    } else if (stage === 'transcribe' || stage === 'analyze' || stage === 'scenes') {
      perMinMs = sourceMinutes > 0.2 ? d.ms / sourceMinutes : 0;
    }
    EtaHistory.record(store, stage, d.ms, perMinMs, stage === 'render' ? chunks : 0);
  }
  stats.stageTimesMs = store;
}

function cancelGeneration() {
  if (!isProcessing || cancelRequested) return;
  cancelRequested = true;
  window.api.cancelProcessing();
  $('#btn-cancel').disabled = true;
  setStatus('processing', 'Processing…');
  showProgress('Cancelling…', etaEstimator ? etaEstimator.getPercent() : 0, 'Stopping current work…', { raw: true });
}

// ===== UI HELPERS =====
function setControlsDisabled(disabled) {
  const selectors = [
    '#pick-source', '#pick-background', '#pick-output',
    '#mode-stories', '#mode-cinema', '#cinema-scene-count', '#cinema-fill-mode', '#cinema-target-sec', '#cinema-max-sec',
    '#app-language', '#app-theme',
    '#preset-select', '#preset-name-input', '#btn-create-preset', '#btn-save-preset', '#btn-delete-preset',
    '#proxy-toggle',
    '#proxy-type', '#proxy-host', '#proxy-port', '#proxy-user', '#proxy-pass',
    '#subtitles-toggle', '#subtitle-style', '#subtitle-language',
    '#subtitle-position', '#subtitle-words-per-line', '#subtitle-max-line-ms', '#subtitle-font-size', '#subtitle-font-family', '#subtitle-margin-v', '#subtitle-offset', '#subtitle-case', '#subtitle-karaoke',
    '#subtitle-custom-pos',
    '#karaoke-mode-highlight', '#karaoke-mode-box', '#karaoke-mode-caps',
    '#banner-toggle', '#pick-banner', '#banner-width', '#banner-height', '#banner-opacity', '#btn-reset-banner', '#btn-remove-banner',
    '#banner-mode', '#banner-interval-sec',
    '#cm-provider', '#cm-name', '#cm-model', '#btn-add-model',
    '#cp-name', '#cp-url', '#cp-key', '#btn-add-provider',
    '#chain-tc-select', '#btn-chain-tc-add', '#chain-ac-select', '#btn-chain-ac-add',
    '#btn-reset-stats'
  ];

  selectors.forEach(sel => {
    const el = $(sel);
    if (!el) return;
    
    if (['INPUT', 'SELECT', 'BUTTON'].includes(el.tagName)) {
      el.disabled = disabled;
    } else {
      // For div pickers (source, background, output)
      el.style.pointerEvents = disabled ? 'none' : 'auto';
      el.style.opacity = disabled ? '0.5' : '1';
    }
  });

  // Also disable remove buttons for model tags
  $$('.key-tag .remove').forEach(btn => {
    btn.disabled = disabled;
    btn.style.pointerEvents = disabled ? 'none' : 'auto';
    btn.style.opacity = disabled ? '0.5' : '1';
  });

  if (!disabled) {
    $('#btn-create-preset').disabled = !$('#preset-name-input').value.trim();
    renderPresets();
    setContainerControlsDisabled('#proxy-fields', !$('#proxy-toggle').checked);
    setContainerControlsDisabled('#subtitle-fields', !$('#subtitles-toggle').checked);
    updateKaraokeFieldsState();
    $('#btn-add-provider').disabled = !(normalizeBaseUrlLocal($('#cp-url').value) && String($('#cp-key').value || '').trim());
    $('#btn-add-model').disabled = !String($('#cm-model').value || '').trim();
    const tcSelect = $('#chain-tc-select');
    const acSelect = $('#chain-ac-select');
    if (tcSelect) $('#btn-chain-tc-add').disabled = !isCustomModelKey(tcSelect.value);
    if (acSelect) $('#btn-chain-ac-add').disabled = !isCustomModelKey(acSelect.value);
  }
  window.SharpSelect?.refreshAll();
}

function setStatus(state, text) {
  const dot = $('#status-dot');
  dot.className = `status-dot ${state}`;
  const mapped = {
    Ready: t('status.ready'),
    'Processing…': t('status.processing'),
    Complete: t('status.done'),
    Error: t('status.error')
  };
  $('#status-text').textContent = mapped[text] || text;
}

function showProgress(step, percent, message, data = {}) {
  $('#progress-container').style.display = '';
  $('#progress-step').textContent = step;
  $('#progress-message').textContent = message;

  if (etaEstimator && !data.raw) {
    etaEstimator.onEvent(data);
    paintProgress();
    return;
  }

  // Raw paint (cancel / error): keep the bar where it is.
  $('#progress-fill').style.width = `${percent}%`;
  $('#progress-percent').textContent = `${Math.round(percent)}%`;
  $('#progress-eta').style.display = 'none';
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '--:--';
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

function formatSpeed(bps) {
  if (!bps || bps <= 0) return null;
  const mbps = bps / 1048576;
  if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}

// Paints the estimator state: eased monotonic percent + smoothed ETA + live
// upload speed. Runs on the 1s interval and can be called directly.
function paintProgress() {
  if (!etaEstimator) return;
  const snap = etaEstimator.tick();
  $('#progress-fill').style.width = `${snap.percent}%`;
  $('#progress-percent').textContent = `${Math.floor(snap.percent)}%`;

  const el = $('#progress-eta');
  if (snap.percent >= 99.9) {
    el.style.display = 'none';
    return;
  }
  if (snap.stalled || snap.etaMs == null) {
    el.style.display = '';
    el.textContent = t('labels.eta.waiting');
    return;
  }
  const speedText = formatSpeed(snap.speedBps);
  el.style.display = '';
  el.textContent = `${t('labels.eta.remaining')}: ${formatDuration(snap.etaMs)}${speedText ? ` · ↑ ${speedText}` : ''}`;
}

function updateEta() {
  if (!processStartTime || !etaEstimator) return;
  paintProgress();
}

function hideProgress() {
  $('#progress-container').style.display = 'none';
  $('#progress-eta').style.display = 'none';
}

function buildPreviewChunks(phrase, wordsPerLine) {
  const words = String(phrase || '').trim().split(/\s+/).filter(Boolean);
  const size = Math.max(1, Number(wordsPerLine || 3));
  const chunks = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(words.slice(i, i + size).join(' '));
  }
  return chunks.length ? chunks : [phrase];
}

function renderPreviewChunk(textEl, phrase, karaoke, karaokeEffects = ['highlight'], caseName = 'sentence') {
  const current = subtitlePreviewChunks[subtitlePreviewChunkIndex % subtitlePreviewChunks.length] || phrase;
  const effects = new Set(Array.isArray(karaokeEffects) ? karaokeEffects : []);
  const applyCase = (value) => {
    const v = String(value || '');
    if (caseName === 'uppercase') return v.toUpperCase();
    if (caseName === 'lowercase') return v.toLowerCase();
    if (!v) return v;
    return v.charAt(0).toUpperCase() + v.slice(1);
  };
  if (karaoke) {
    const words = applyCase(current).split(' ');
    const highlightIndex = words.length > 1 ? Math.floor(words.length / 2) : 0;
    const escaped = words.map((w, i) => {
      if (i !== highlightIndex) return w;
      const classes = ['subtitle-preview-word'];
      if (effects.has('highlight')) classes.push('mode-highlight');
      if (effects.has('box')) classes.push('mode-box');
      const value = (effects.has('caps') && caseName !== 'uppercase') ? w.toUpperCase() : w;
      return `<span class="${classes.join(' ')}">${value}</span>`;
    });
    textEl.innerHTML = escaped.join(' ');
  } else {
    textEl.textContent = applyCase(current);
  }
}

function updateSubtitlePreview() {
  const stage = $('#subtitle-preview-stage');
  const frame = $('#subtitle-preview-frame');
  const overlay = $('#subtitle-preview-overlay');
  const text = $('#subtitle-preview-text');
  if (!stage || !overlay || !text) return;

  const enabled = !!$('#subtitles-toggle')?.checked;
  // Real export values (1080x1920). Preview uses these directly inside
  // a 1080x1920 frame that is scaled down via CSS transform — so visual
  // proportions match the exported video exactly.
  const realFontSize = Math.max(12, Number($('#subtitle-font-size')?.value || 20));
  const marginV = Math.max(10, Number($('#subtitle-margin-v')?.value || 40));
  const marginH = 40; // matches ASS_STYLES.*.marginH default
  const wordsPerLine = Math.max(1, Number($('#subtitle-words-per-line')?.value || 3));
  const lineMs = Math.max(300, Number($('#subtitle-max-line-ms')?.value || 1200));
  const fontFamily = $('#subtitle-font-family')?.value || 'Inter';
  const karaoke = !!$('#subtitle-karaoke')?.checked;
  const karaokeEffects = getSelectedKaraokeEffects();
  const caseName = $('#subtitle-case')?.value || 'sentence';
  const stylePreset = $('#subtitle-style')?.value || 'Classic';
  const position = $('#subtitle-position')?.value || 'bottom';
  const phrase = uiLang === 'ru'
    ? 'Это пример предпросмотра отображения субтитров в вашем стиле'
    : 'This is a live subtitle preview phrase in your design style';

  // Apply ASS-equivalent values directly (px == ASS unit thanks to scaled frame).
  overlay.style.fontFamily = `'${fontFamily}', sans-serif`;
  overlay.style.fontSize = `${realFontSize}px`;
  overlay.style.opacity = enabled ? '1' : '0.45';
  overlay.style.left = `${marginH}px`;
  overlay.style.right = `${marginH}px`;
  overlay.classList.remove(
    'preview-style-classic',
    'preview-style-minimal',
    'preview-style-highlight',
    'preview-style-tiktokbold',
    'preview-style-heavyshadow',
    'preview-style-softbox'
  );
  if (stylePreset === 'Minimal') {
    overlay.classList.add('preview-style-minimal');
  } else if (stylePreset === 'Highlight') {
    overlay.classList.add('preview-style-highlight');
  } else if (stylePreset === 'TikTokBold') {
    overlay.classList.add('preview-style-tiktokbold');
  } else if (stylePreset === 'HeavyShadow') {
    overlay.classList.add('preview-style-heavyshadow');
  } else if (stylePreset === 'SoftBox') {
    overlay.classList.add('preview-style-softbox');
  } else {
    overlay.classList.add('preview-style-classic');
  }

  subtitlePreviewChunks = buildPreviewChunks(phrase, wordsPerLine);
  subtitlePreviewChunkIndex = subtitlePreviewChunkIndex % subtitlePreviewChunks.length;
  renderPreviewChunk(text, phrase, karaoke, karaokeEffects, caseName);

  if (subtitlePreviewInterval) clearInterval(subtitlePreviewInterval);
  subtitlePreviewInterval = setInterval(() => {
    subtitlePreviewChunkIndex = (subtitlePreviewChunkIndex + 1) % subtitlePreviewChunks.length;
    renderPreviewChunk(text, phrase, karaoke, karaokeEffects, caseName);
  }, lineMs);

  // Position: apply to preview overlay in real ASS coordinates.
  // Free positioning mode: the block center follows (subtitleX, subtitleY)
  // exactly like the renderer's \pos() + Alignment 5 anchor.
  const freePos = isSubtitleFreePosActive();
  const previewHandle = $('#subtitle-preview-handle');
  overlay.classList.toggle('free-pos', freePos);
  if (freePos) {
    const x = Math.max(0, Math.min(1080, Math.round(Number(settings.subtitleX || 540))));
    const y = Math.max(0, Math.min(1920, Math.round(Number(settings.subtitleY || 1850))));
    overlay.style.left = `${x}px`;
    overlay.style.top = `${y}px`;
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
    overlay.style.transform = 'translate(-50%, -50%)';
    if (previewHandle) previewHandle.style.display = '';
  } else {
    if (previewHandle) previewHandle.style.display = 'none';
    // ASS Alignment 8 (top): MarginV from top. ASS Alignment 2 (bottom): MarginV from bottom.
    // ASS Alignment 5 (middle): vertically centered, MarginV ignored.
    overlay.style.top = '';
    overlay.style.bottom = '';
    overlay.style.transform = '';
    if (position === 'top') {
      overlay.style.top = `${marginV}px`;
      overlay.style.bottom = 'auto';
    } else if (position === 'middle') {
      overlay.style.top = '50%';
      overlay.style.transform = 'translateY(-50%)';
      overlay.style.bottom = 'auto';
    } else {
      overlay.style.bottom = `${marginV}px`;
      overlay.style.top = 'auto';
    }
  }

  // Shared preview frame: scaling + collapse state depend on both the
  // subtitle toggle and the selected banner.
  syncSharedPreviewFrame();
}

// ===== STATS =====
async function loadStats() {
  try {
    const s = await window.api.getStats();
    if (s) stats = { ...stats, ...s };
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

async function saveStats() {
  try {
    await window.api.saveStats(stats);
  } catch (err) {
    console.error('Failed to save stats:', err);
  }
}

function renderStats() {
  $('#stat-total').textContent = stats.totalVideos;
  const totalMin = Math.round(stats.totalRenderTimeMs / 60000);
  if (totalMin < 60) {
    $('#stat-time').textContent = `${totalMin}m`;
  } else {
    const hr = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    $('#stat-time').textContent = `${hr}h ${min}m`;
  }
  if (stats.totalVideos > 0) {
    const avgSec = Math.round(stats.totalRenderTimeMs / stats.totalVideos / 1000);
    if (avgSec < 60) {
      $('#stat-avg').textContent = `${avgSec}s`;
    } else {
      const min = Math.floor(avgSec / 60);
      const sec = avgSec % 60;
      $('#stat-avg').textContent = `${min}m ${sec}s`;
    }
  } else {
    $('#stat-avg').textContent = '0s';
  }
  $('#stat-last').textContent = stats.lastRun || '—';
}

async function resetStats() {
  stats = { totalVideos: 0, totalRenderTimeMs: 0, lastRun: null, stageTimesMs: {} };
  await saveStats();
  renderStats();
}

$('#btn-reset-stats').addEventListener('click', resetStats);

// ===== INIT =====
async function init() {
  await loadSettings();
  await loadStats();
  const activePreset = normalizePresets(settings.presets).find((preset) => preset.id === settings.activePresetId);
  if (activePreset?.paths) {
    sourcePath = activePreset.paths.sourcePath || null;
    bgFolderPath = activePreset.paths.bgFolderPath || null;
    outputFolderPath = activePreset.paths.outputFolderPath || null;
  }
  syncSettingsToControls();
  applyTranslations();
  window.SharpSelect?.mountAll();
  window.SharpSelect?.refreshAll();
  refreshBannerProbe();
  // Recompute preview scale on window resize so the 1080x1920 frame keeps
  // fitting the available stage width.
  let __subPreviewResizeRaf = 0;
  window.addEventListener('resize', () => {
    if (__subPreviewResizeRaf) cancelAnimationFrame(__subPreviewResizeRaf);
    __subPreviewResizeRaf = requestAnimationFrame(() => {
      syncSharedPreviewFrame();
    });
  });
}

init();

window.addEventListener('beforeunload', () => {
  if (subtitlePreviewInterval) {
    clearInterval(subtitlePreviewInterval);
    subtitlePreviewInterval = null;
  }
});
