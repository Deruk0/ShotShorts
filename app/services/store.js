let storeInstance = null;

async function getStore() {
  if (!storeInstance) {
    const { default: Store } = await import('electron-store');
    const schema = {
      customProviders: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            baseUrl: { type: 'string' },
            apiKey: { type: 'string' }
          }
        },
        default: []
      },
      proxy: {
        type: ['object', 'null'],
        properties: {
          type: { type: 'string' },
          host: { type: 'string' },
          port: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' }
        },
        default: null
      },
      subtitlesEnabled: { type: 'boolean', default: false },
      subtitleStyle: { type: 'string', default: 'Classic' },
      subtitleLanguage: { type: 'string', default: 'ru' },
      subtitlePosition: { type: 'string', default: 'bottom' },
      subtitleWordsPerLine: { type: 'number', default: 3 },
      subtitleMaxLineMs: { type: 'number', default: 1200 },
      subtitleFontSize: { type: 'number', default: 20 },
      subtitleFontFamily: { type: 'string', default: 'Inter' },
      subtitleMarginV: { type: 'number', default: 40 },
      subtitleKaraoke: { type: 'boolean', default: false },
      subtitleKaraokeMode: { type: 'string', default: 'highlight' },
      subtitleKaraokeEffects: {
        type: 'array',
        items: { type: 'string' },
        default: ['highlight']
      },
      subtitleCase: { type: 'string', default: 'sentence' },
      subtitleOffsetMs: { type: 'number', default: 0 },
      subtitleCustomPos: { type: 'boolean', default: false },
      subtitleX: { type: 'number', default: 540 },
      subtitleY: { type: 'number', default: 1850 },
      analysisModelKey: { type: 'string', default: '' },
      transcriptionChain: {
        type: 'array',
        items: { type: 'string' },
        default: []
      },
      analysisChain: {
        type: 'array',
        items: { type: 'string' },
        default: []
      },
      customModels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            providerId: { type: 'string' },
            name: { type: 'string' },
            modelId: { type: 'string' }
          }
        },
        default: []
      },
      bannerEnabled: { type: 'boolean', default: false },
      bannerPath: { type: 'string', default: '' },
      bannerX: { type: 'number', default: 740 },
      bannerY: { type: 'number', default: 60 },
      bannerWidth: { type: 'number', default: 300 },
      bannerHeight: { type: 'number', default: 150 },
      bannerChromaKey: { type: 'boolean', default: false },
      bannerOpacity: { type: 'number', default: 100 },
      bannerMode: { type: 'string', default: 'overlay' },
      bannerIntervalSec: { type: 'number', default: 60 },
      bannerDurationSec: { type: 'number', default: 5 },
      generationMode: { type: 'string', default: 'stories' },
      cinemaSceneCount: { type: 'number', default: 10 },
      cinemaFillMode: { type: 'string', default: 'crop' },
      cinemaTargetSec: { type: 'number', default: 45 },
      cinemaMaxSec: { type: 'number', default: 90 },
      cinemaMinSec: { type: 'number', default: 20 },
      cinemaMaxSecEnabled: { type: 'boolean', default: true },
      cinemaReviewEnabled: { type: 'boolean', default: true },
      cinemaBgEnabled: { type: 'boolean', default: false },
      cinemaBgCanvasFill: { type: 'string', default: 'black' },
      cinemaBgLayerOrder: { type: 'string', default: 'movieTop' },
      cinemaClipX: { type: 'number', default: 0 },
      cinemaClipY: { type: 'number', default: 0 },
      cinemaClipWidth: { type: 'number', default: 1080 },
      cinemaClipHeight: { type: 'number', default: 960 },
      cinemaBgX: { type: 'number', default: 0 },
      cinemaBgY: { type: 'number', default: 960 },
      cinemaBgWidth: { type: 'number', default: 1080 },
      cinemaBgHeight: { type: 'number', default: 960 },
      storiesTargetMinSec: { type: 'number', default: 90 },
      storiesTargetMaxSec: { type: 'number', default: 300 },
      storiesHardMinSec: { type: 'number', default: 60 },
      storiesHardMaxSec: { type: 'number', default: 390 },
      appLanguage: { type: 'string', default: 'en' },
      appTheme: { type: 'string', default: 'dark' },
      activePresetIdStories: {
        type: ['string', 'null'],
        default: null
      },
      activePresetIdCinema: {
        type: ['string', 'null'],
        default: null
      },
      activePresetId: {
        type: ['string', 'null'],
        default: null
      },
      presets: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true
        },
        default: []
      },
      stats: {
        type: 'object',
        properties: {
          totalVideos: { type: 'number', default: 0 },
          totalRenderTimeMs: { type: 'number', default: 0 },
          lastRun: { type: ['string', 'null'], default: null },
          stageTimesMs: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                totalMs: { type: 'number', default: 0 },
                perMinMs: { type: 'number', default: 0 },
                perChunkMs: { type: 'number', default: 0 },
                samples: { type: 'number', default: 0 }
              }
            },
            default: {}
          }
        },
        default: { totalVideos: 0, totalRenderTimeMs: 0, lastRun: null, stageTimesMs: {} }
      }
    };
    storeInstance = new Store({ schema });
  }
  return storeInstance;
}

async function getSettings() {
  const store = await getStore();

  // Legacy layouts (models carrying their own baseUrl/apiKey, single-model
  // selects) are migrated once to providers + models + fallback chains.
  const raw = {
    customProviders: store.get('customProviders'),
    customModels: store.get('customModels'),
    transcriptionChain: store.get('transcriptionChain'),
    analysisChain: store.get('analysisChain'),
    subtitleModel: store.get('subtitleModel'),
    analysisModelKey: store.get('analysisModelKey')
  };
  const { migrateLegacyModels, normalizeCustomProviders, normalizeCustomModels, normalizeModelKeyList } = require('./model-registry');
  const migrated = migrateLegacyModels(raw);
  if (migrated) {
    store.set('customProviders', migrated.customProviders);
    store.set('customModels', migrated.customModels);
    store.set('transcriptionChain', migrated.transcriptionChain);
    store.set('analysisChain', migrated.analysisChain);
  }

  const customProviders = normalizeCustomProviders(store.get('customProviders'));
  const customModels = normalizeCustomModels(store.get('customModels'), customProviders);
  const transcriptionChain = normalizeModelKeyList(store.get('transcriptionChain'));
  const analysisChain = normalizeModelKeyList(store.get('analysisChain'));

  return {
    proxy: store.get('proxy'),
    subtitlesEnabled: store.get('subtitlesEnabled'),
    subtitleStyle: store.get('subtitleStyle'),
    subtitleLanguage: store.get('subtitleLanguage'),
    subtitlePosition: store.get('subtitlePosition'),
    subtitleWordsPerLine: store.get('subtitleWordsPerLine'),
    subtitleMaxLineMs: store.get('subtitleMaxLineMs'),
    subtitleFontSize: store.get('subtitleFontSize'),
    subtitleFontFamily: store.get('subtitleFontFamily'),
    subtitleMarginV: store.get('subtitleMarginV'),
    subtitleKaraoke: store.get('subtitleKaraoke'),
    subtitleKaraokeMode: store.get('subtitleKaraokeMode'),
    subtitleKaraokeEffects: store.get('subtitleKaraokeEffects'),
    subtitleCase: store.get('subtitleCase'),
    subtitleOffsetMs: store.get('subtitleOffsetMs'),
    subtitleCustomPos: store.get('subtitleCustomPos'),
    subtitleX: store.get('subtitleX'),
    subtitleY: store.get('subtitleY'),
    customProviders,
    customModels,
    transcriptionChain,
    analysisChain,
    bannerEnabled: store.get('bannerEnabled'),
    bannerPath: store.get('bannerPath'),
    bannerX: store.get('bannerX'),
    bannerY: store.get('bannerY'),
    bannerWidth: store.get('bannerWidth'),
    bannerHeight: store.get('bannerHeight'),
    bannerOpacity: store.get('bannerOpacity'),
    bannerChromaKey: store.get('bannerChromaKey'),
    bannerMode: store.get('bannerMode'),
    bannerIntervalSec: store.get('bannerIntervalSec'),
    bannerDurationSec: store.get('bannerDurationSec'),
    generationMode: store.get('generationMode'),
    cinemaSceneCount: store.get('cinemaSceneCount'),
    cinemaFillMode: store.get('cinemaFillMode'),
    cinemaTargetSec: store.get('cinemaTargetSec'),
    cinemaMaxSec: store.get('cinemaMaxSec'),
    cinemaMinSec: store.get('cinemaMinSec'),
    cinemaMaxSecEnabled: store.get('cinemaMaxSecEnabled'),
    cinemaReviewEnabled: store.get('cinemaReviewEnabled'),
    cinemaBgEnabled: store.get('cinemaBgEnabled'),
    cinemaBgCanvasFill: store.get('cinemaBgCanvasFill'),
    cinemaBgLayerOrder: store.get('cinemaBgLayerOrder'),
    cinemaClipX: store.get('cinemaClipX'),
    cinemaClipY: store.get('cinemaClipY'),
    cinemaClipWidth: store.get('cinemaClipWidth'),
    cinemaClipHeight: store.get('cinemaClipHeight'),
    cinemaBgX: store.get('cinemaBgX'),
    cinemaBgY: store.get('cinemaBgY'),
    cinemaBgWidth: store.get('cinemaBgWidth'),
    cinemaBgHeight: store.get('cinemaBgHeight'),
    storiesTargetMinSec: store.get('storiesTargetMinSec'),
    storiesTargetMaxSec: store.get('storiesTargetMaxSec'),
    storiesHardMinSec: store.get('storiesHardMinSec'),
    storiesHardMaxSec: store.get('storiesHardMaxSec'),
    appLanguage: store.get('appLanguage'),
    appTheme: store.get('appTheme'),
    activePresetIdStories: store.get('activePresetIdStories'),
    activePresetIdCinema: store.get('activePresetIdCinema'),
    activePresetId: store.get('activePresetId'),
    presets: store.get('presets')
  };
}

async function saveSettings(settings) {
  const store = await getStore();

  if (settings.proxy !== undefined) {
    store.set('proxy', settings.proxy);
  }
  if (settings.subtitlesEnabled !== undefined) store.set('subtitlesEnabled', !!settings.subtitlesEnabled);
  if (settings.subtitleStyle !== undefined) store.set('subtitleStyle', settings.subtitleStyle);
  if (settings.subtitleLanguage !== undefined) store.set('subtitleLanguage', settings.subtitleLanguage);
  if (settings.subtitlePosition !== undefined) store.set('subtitlePosition', settings.subtitlePosition);
  if (settings.subtitleWordsPerLine !== undefined) store.set('subtitleWordsPerLine', Number(settings.subtitleWordsPerLine));
  if (settings.subtitleMaxLineMs !== undefined) store.set('subtitleMaxLineMs', Number(settings.subtitleMaxLineMs));
  if (settings.subtitleFontSize !== undefined) store.set('subtitleFontSize', Number(settings.subtitleFontSize));
  if (settings.subtitleFontFamily !== undefined) store.set('subtitleFontFamily', settings.subtitleFontFamily);
  if (settings.subtitleMarginV !== undefined) store.set('subtitleMarginV', Number(settings.subtitleMarginV));
  if (settings.subtitleKaraoke !== undefined) store.set('subtitleKaraoke', !!settings.subtitleKaraoke);
  if (settings.subtitleKaraokeMode !== undefined) store.set('subtitleKaraokeMode', settings.subtitleKaraokeMode);
  if (settings.subtitleKaraokeEffects !== undefined) {
    const effects = Array.isArray(settings.subtitleKaraokeEffects)
      ? settings.subtitleKaraokeEffects.filter((e) => typeof e === 'string')
      : [];
    store.set('subtitleKaraokeEffects', effects.length > 0 ? effects : ['highlight']);
  }
  if (settings.subtitleCase !== undefined) store.set('subtitleCase', settings.subtitleCase);
  if (settings.subtitleOffsetMs !== undefined) store.set('subtitleOffsetMs', Number(settings.subtitleOffsetMs));
  if (settings.subtitleCustomPos !== undefined) store.set('subtitleCustomPos', !!settings.subtitleCustomPos);
  if (settings.subtitleX !== undefined) store.set('subtitleX', Number(settings.subtitleX));
  if (settings.subtitleY !== undefined) store.set('subtitleY', Number(settings.subtitleY));
  if (settings.customProviders !== undefined) {
    const { normalizeCustomProviders } = require('./model-registry');
    store.set('customProviders', normalizeCustomProviders(settings.customProviders));
  }
  if (settings.customModels !== undefined) {
    const { normalizeCustomModels } = require('./model-registry');
    store.set('customModels', normalizeCustomModels(settings.customModels, settings.customProviders || store.get('customProviders')));
  }
  if (settings.transcriptionChain !== undefined) {
    const { normalizeModelKeyList } = require('./model-registry');
    store.set('transcriptionChain', normalizeModelKeyList(settings.transcriptionChain));
  }
  if (settings.analysisChain !== undefined) {
    const { normalizeModelKeyList } = require('./model-registry');
    store.set('analysisChain', normalizeModelKeyList(settings.analysisChain));
  }
  if (settings.bannerEnabled !== undefined) store.set('bannerEnabled', !!settings.bannerEnabled);
  if (settings.bannerPath !== undefined) store.set('bannerPath', String(settings.bannerPath || ''));
  if (settings.bannerX !== undefined) store.set('bannerX', Number(settings.bannerX));
  if (settings.bannerY !== undefined) store.set('bannerY', Number(settings.bannerY));
  if (settings.bannerWidth !== undefined) store.set('bannerWidth', Number(settings.bannerWidth));
  if (settings.bannerHeight !== undefined) store.set('bannerHeight', Number(settings.bannerHeight));
  if (settings.bannerChromaKey !== undefined) store.set('bannerChromaKey', settings.bannerChromaKey === true);
  if (settings.bannerOpacity !== undefined) store.set('bannerOpacity', Number(settings.bannerOpacity));
  if (settings.bannerMode !== undefined) store.set('bannerMode', ['overlay', 'interstitial'].includes(settings.bannerMode) ? settings.bannerMode : 'overlay');
  if (settings.bannerIntervalSec !== undefined) store.set('bannerIntervalSec', Math.max(1, Math.min(3600, Number(settings.bannerIntervalSec) || 60)));
  if (settings.bannerDurationSec !== undefined) store.set('bannerDurationSec', Math.max(1, Math.min(30, Number(settings.bannerDurationSec) || 5)));
  if (settings.generationMode !== undefined) {
    store.set('generationMode', settings.generationMode === 'cinema' ? 'cinema' : 'stories');
  }
  if (settings.cinemaSceneCount !== undefined) {
    const sceneCount = Math.round(Number(settings.cinemaSceneCount));
    store.set('cinemaSceneCount', Math.max(5, Math.min(20, Number.isFinite(sceneCount) ? sceneCount : 10)));
  }
  if (settings.cinemaFillMode !== undefined) {
    store.set('cinemaFillMode', settings.cinemaFillMode === 'blur' ? 'blur' : 'crop');
  }
  if (settings.cinemaTargetSec !== undefined) {
    const target = Number(settings.cinemaTargetSec);
    store.set('cinemaTargetSec', Number.isFinite(target) ? Math.max(10, Math.min(300, Math.round(target))) : 45);
  }
  if (settings.cinemaMinSec !== undefined) {
    const min = Number(settings.cinemaMinSec);
    store.set('cinemaMinSec', Number.isFinite(min) ? Math.max(5, Math.min(300, Math.round(min))) : 20);
  }
  if (settings.cinemaMaxSecEnabled !== undefined) {
    store.set('cinemaMaxSecEnabled', settings.cinemaMaxSecEnabled !== false);
  }
  if (settings.cinemaReviewEnabled !== undefined) {
    store.set('cinemaReviewEnabled', settings.cinemaReviewEnabled !== false);
  }
  if (settings.cinemaBgEnabled !== undefined) store.set('cinemaBgEnabled', !!settings.cinemaBgEnabled);
  if (settings.cinemaBgCanvasFill !== undefined) {
    store.set('cinemaBgCanvasFill', ['black', 'blurMovie', 'blurBg'].includes(settings.cinemaBgCanvasFill) ? settings.cinemaBgCanvasFill : 'black');
  }
  if (settings.cinemaBgLayerOrder !== undefined) {
    store.set('cinemaBgLayerOrder', settings.cinemaBgLayerOrder === 'bgTop' ? 'bgTop' : 'movieTop');
  }
  // Rectangle layouts are stored raw (renderer + cinema-bg-utils clamp them).
  [
    'cinemaClipX', 'cinemaClipY', 'cinemaClipWidth', 'cinemaClipHeight',
    'cinemaBgX', 'cinemaBgY', 'cinemaBgWidth', 'cinemaBgHeight'
  ].forEach((key) => {
    if (settings[key] !== undefined) store.set(key, Number(settings[key]));
  });
  if (settings.cinemaMaxSec !== undefined) {
    const max = Number(settings.cinemaMaxSec);
    // The soft max only applies when the limit is enabled; otherwise any
    // scene length is allowed in cinema mode.
    const maxEnabled = settings.cinemaMaxSecEnabled !== undefined
      ? settings.cinemaMaxSecEnabled !== false
      : store.get('cinemaMaxSecEnabled') !== false;
    const target = Number(store.get('cinemaTargetSec')) || 45;
    const clamped = Number.isFinite(max) ? Math.max(15, Math.min(600, Math.round(max))) : 90;
    store.set('cinemaMaxSec', maxEnabled ? Math.max(target, clamped) : clamped);
  }
  if (settings.storiesTargetMinSec !== undefined ||
      settings.storiesTargetMaxSec !== undefined ||
      settings.storiesHardMinSec !== undefined ||
      settings.storiesHardMaxSec !== undefined) {
    // Keep the chain consistent: hardMin <= targetMin <= targetMax <= hardMax.
    const clampSec = (value, min, max, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
    };
    const prev = {
      targetMin: clampSec(store.get('storiesTargetMinSec'), 15, 1800, 90),
      targetMax: clampSec(store.get('storiesTargetMaxSec'), 15, 1800, 300),
      hardMin: clampSec(store.get('storiesHardMinSec'), 15, 1800, 60),
      hardMax: clampSec(store.get('storiesHardMaxSec'), 15, 1800, 390)
    };
    const next = { ...prev };
    if (settings.storiesHardMinSec !== undefined) next.hardMin = clampSec(settings.storiesHardMinSec, 15, 1800, prev.hardMin);
    if (settings.storiesTargetMinSec !== undefined) next.targetMin = clampSec(settings.storiesTargetMinSec, 15, 1800, prev.targetMin);
    if (settings.storiesTargetMaxSec !== undefined) next.targetMax = clampSec(settings.storiesTargetMaxSec, 15, 1800, prev.targetMax);
    if (settings.storiesHardMaxSec !== undefined) next.hardMax = clampSec(settings.storiesHardMaxSec, 15, 1800, prev.hardMax);

    next.targetMin = Math.max(next.hardMin, next.targetMin);
    next.targetMax = Math.max(next.targetMin, next.targetMax);
    next.hardMax = Math.max(next.targetMax, next.hardMax);

    store.set('storiesHardMinSec', next.hardMin);
    store.set('storiesTargetMinSec', next.targetMin);
    store.set('storiesTargetMaxSec', next.targetMax);
    store.set('storiesHardMaxSec', next.hardMax);
  }
  if (settings.appLanguage !== undefined) store.set('appLanguage', settings.appLanguage);
  if (settings.appTheme !== undefined) store.set('appTheme', settings.appTheme);
  if (settings.activePresetId !== undefined) store.set('activePresetId', settings.activePresetId || null);
  if (settings.activePresetIdStories !== undefined) store.set('activePresetIdStories', settings.activePresetIdStories || null);
  if (settings.activePresetIdCinema !== undefined) store.set('activePresetIdCinema', settings.activePresetIdCinema || null);
  if (settings.presets !== undefined) {
    const presets = Array.isArray(settings.presets) ? settings.presets : [];
    store.set('presets', presets);
  }
}

async function getProxy() {
  const store = await getStore();
  return store.get('proxy');
}

async function getStats() {
  const store = await getStore();
  return store.get('stats') || { totalVideos: 0, totalRenderTimeMs: 0, lastRun: null, stageTimesMs: {} };
}

async function saveStats(stats) {
  const store = await getStore();
  store.set('stats', stats);
}

module.exports = {
  getSettings,
  saveSettings,
  getProxy,
  getStats,
  saveStats
};
