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
      bannerOpacity: { type: 'number', default: 100 },
      bannerMode: { type: 'string', default: 'overlay' },
      bannerIntervalSec: { type: 'number', default: 60 },
      bannerDurationSec: { type: 'number', default: 5 },
      generationMode: { type: 'string', default: 'stories' },
      cinemaSceneCount: { type: 'number', default: 10 },
      cinemaFillMode: { type: 'string', default: 'crop' },
      appLanguage: { type: 'string', default: 'en' },
      appTheme: { type: 'string', default: 'dark' },
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
          lastRun: { type: ['string', 'null'], default: null }
        },
        default: { totalVideos: 0, totalRenderTimeMs: 0, lastRun: null }
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
    bannerMode: store.get('bannerMode'),
    bannerIntervalSec: store.get('bannerIntervalSec'),
    bannerDurationSec: store.get('bannerDurationSec'),
    generationMode: store.get('generationMode'),
    cinemaSceneCount: store.get('cinemaSceneCount'),
    cinemaFillMode: store.get('cinemaFillMode'),
    appLanguage: store.get('appLanguage'),
    appTheme: store.get('appTheme'),
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
  if (settings.appLanguage !== undefined) store.set('appLanguage', settings.appLanguage);
  if (settings.appTheme !== undefined) store.set('appTheme', settings.appTheme);
  if (settings.activePresetId !== undefined) store.set('activePresetId', settings.activePresetId || null);
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
  return store.get('stats') || { totalVideos: 0, totalRenderTimeMs: 0, lastRun: null };
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
