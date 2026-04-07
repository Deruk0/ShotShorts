let storeInstance = null;

async function getStore() {
  if (!storeInstance) {
    const { default: Store } = await import('electron-store');
    const schema = {
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
  return {
    apiKeys: store.get('apiKeys'),
    proxy: store.get('proxy')
  };
}

async function saveSettings(settings) {
  const store = await getStore();
  if (settings.apiKeys !== undefined) {
    store.set('apiKeys', settings.apiKeys);
  }
  if (settings.proxy !== undefined) {
    store.set('proxy', settings.proxy);
  }
}

async function getApiKeys() {
  const store = await getStore();
  return store.get('apiKeys');
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
  getApiKeys,
  getProxy,
  getStats,
  saveStats
};
