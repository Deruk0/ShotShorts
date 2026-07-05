let storeInstance = null;

function normalizeGroqApiKeys(apiKeys, legacyKey = '') {
  const merged = [];

  if (Array.isArray(apiKeys)) {
    merged.push(...apiKeys);
  }
  if (typeof legacyKey === 'string' && legacyKey.trim()) {
    merged.push(legacyKey);
  }

  return [...new Set(
    merged
      .map((key) => String(key || '').trim())
      .filter(Boolean)
      .filter((key) => !key.startsWith('AIzaSy'))
  )];
}

async function getStore() {
  if (!storeInstance) {
    const { default: Store } = await import('electron-store');
    const schema = {
      apiProvider: { type: 'string', default: 'groq' },
      apiKeys: {
        type: 'array',
        items: {
          type: 'string'
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
      subtitleModel: { type: 'string', default: 'whisper-large-v3' },
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
      groqApiKey: { type: 'string', default: '' },
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
  const apiKeys = normalizeGroqApiKeys(store.get('apiKeys'), store.get('groqApiKey'));

  return {
    apiProvider: store.get('apiProvider'),
    apiKeys,
    proxy: store.get('proxy'),
    subtitlesEnabled: store.get('subtitlesEnabled'),
    subtitleStyle: store.get('subtitleStyle'),
    subtitleModel: store.get('subtitleModel'),
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
    groqApiKey: apiKeys[0] || '',
    appLanguage: store.get('appLanguage'),
    appTheme: store.get('appTheme'),
    activePresetId: store.get('activePresetId'),
    presets: store.get('presets')
  };
}

async function saveSettings(settings) {
  const store = await getStore();
  if (settings.apiProvider !== undefined) store.set('apiProvider', settings.apiProvider);

  if (settings.apiKeys !== undefined || settings.groqApiKey !== undefined) {
    const normalizedKeys = settings.apiKeys !== undefined
      ? normalizeGroqApiKeys(settings.apiKeys, settings.groqApiKey !== undefined ? settings.groqApiKey : '')
      : normalizeGroqApiKeys([], settings.groqApiKey);
    store.set('apiKeys', normalizedKeys);
    store.set('groqApiKey', normalizedKeys[0] || '');
  }

  if (settings.proxy !== undefined) {
    store.set('proxy', settings.proxy);
  }
  if (settings.subtitlesEnabled !== undefined) store.set('subtitlesEnabled', !!settings.subtitlesEnabled);
  if (settings.subtitleStyle !== undefined) store.set('subtitleStyle', settings.subtitleStyle);
  if (settings.subtitleModel !== undefined) store.set('subtitleModel', settings.subtitleModel);
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
  if (settings.appLanguage !== undefined) store.set('appLanguage', settings.appLanguage);
  if (settings.appTheme !== undefined) store.set('appTheme', settings.appTheme);
  if (settings.activePresetId !== undefined) store.set('activePresetId', settings.activePresetId || null);
  if (settings.presets !== undefined) {
    const presets = Array.isArray(settings.presets) ? settings.presets : [];
    store.set('presets', presets);
  }
}

async function getApiProvider() {
  const store = await getStore();
  return store.get('apiProvider');
}

async function getApiKeys() {
  const store = await getStore();
  return normalizeGroqApiKeys(store.get('apiKeys'), store.get('groqApiKey'));
}

async function getProxy() {
  const store = await getStore();
  return store.get('proxy');
}

async function getGroqApiKeys() {
  return getApiKeys();
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
  getApiProvider,
  getApiKeys,
  getProxy,
  getGroqApiKeys,
  getStats,
  saveStats
};
