const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  tiktok: {
    queue: {
      openStudio: (id) => ipcRenderer.invoke('tiktok:studio:open', id),
      accounts: () => ipcRenderer.invoke('tiktok:studio:accounts'),
      refreshAccounts: () => ipcRenderer.invoke('tiktok:studio:refreshAccounts'),
      addAccount: () => ipcRenderer.invoke('tiktok:studio:addAccount'),
      previewCaption: (input) => ipcRenderer.invoke('tiktok:queue:previewCaption', input),
      saveCaptionPreset: (input) => ipcRenderer.invoke('tiktok:queue:saveCaptionPreset', input),
      saveHashtagPreset: (input) => ipcRenderer.invoke('tiktok:queue:saveHashtagPreset', input),
      removeCaptionPreset: (id) => ipcRenderer.invoke('tiktok:queue:removeCaptionPreset', id),
      removeHashtagPreset: (id) => ipcRenderer.invoke('tiktok:queue:removeHashtagPreset', id),
      get: () => ipcRenderer.invoke('tiktok:queue:get'),
      template: (input) => ipcRenderer.invoke('tiktok:queue:template', input),
      update: (input) => ipcRenderer.invoke('tiktok:queue:update', input),
      remove: (id) => ipcRenderer.invoke('tiktok:queue:remove', id),
      send: (input) => ipcRenderer.invoke('tiktok:queue:send', input),
      pause: () => ipcRenderer.invoke('tiktok:queue:pause'),
      resume: () => ipcRenderer.invoke('tiktok:queue:resume'),
      reconcile: (input) => ipcRenderer.invoke('tiktok:queue:reconcile', input),
      onChanged: (callback) => {
        const handler = () => callback();
        ipcRenderer.on('tiktok:queueChanged', handler);
        return () => ipcRenderer.removeListener('tiktok:queueChanged', handler);
      }
    },
    policy: (name) => ipcRenderer.invoke('tiktok:policy', name),
    state: () => ipcRenderer.invoke('tiktok:state'),
    configure: (input) => ipcRenderer.invoke('tiktok:configure', input),
    connect: () => ipcRenderer.invoke('tiktok:connect'),
    disconnect: () => ipcRenderer.invoke('tiktok:disconnect'),
    creator: () => ipcRenderer.invoke('tiktok:creator'),
    publish: (input) => ipcRenderer.invoke('tiktok:publish', input),
    status: () => ipcRenderer.invoke('tiktok:status'),
    cancel: () => ipcRenderer.invoke('tiktok:cancel'),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('tiktok:progress', handler);
      return () => ipcRenderer.removeListener('tiktok:progress', handler);
    }
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  openFile: (filters) => ipcRenderer.invoke('dialog:openFile', filters),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  selectOutputFolder: () => ipcRenderer.invoke('dialog:selectOutputFolder'),
  probeMedia: (filePath, options) => ipcRenderer.invoke('media:probe', filePath, options),

  startProcessing: (config) => ipcRenderer.invoke('process:start', config),
  cancelProcessing: () => ipcRenderer.send('process:cancel'),
  reviewScenes: (payload) => ipcRenderer.send('cinema:reviewDecision', payload),

  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('process:progress', handler);
    return () => ipcRenderer.removeListener('process:progress', handler);
  },

  getStats: () => ipcRenderer.invoke('stats:get'),
  saveStats: (stats) => ipcRenderer.invoke('stats:save', stats)
});
