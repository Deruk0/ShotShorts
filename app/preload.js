const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  openFile: (filters) => ipcRenderer.invoke('dialog:openFile', filters),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  selectOutputFolder: () => ipcRenderer.invoke('dialog:selectOutputFolder'),

  startProcessing: (config) => ipcRenderer.invoke('process:start', config),
  cancelProcessing: () => ipcRenderer.send('process:cancel'),

  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('process:progress', handler);
    return () => ipcRenderer.removeListener('process:progress', handler);
  },

  getStats: () => ipcRenderer.invoke('stats:get'),
  saveStats: (stats) => ipcRenderer.invoke('stats:save', stats)
});
