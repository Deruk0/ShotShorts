const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { getSettings, saveSettings, getStats, saveStats } = require('./services/store');
const { runCleanup } = require('./services/cleanup');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, 'icon.png'),
    width: 900,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  runCleanup();
  require('./services/process-handler').register();
  createWindow();
});

app.on('window-all-closed', () => {
  runCleanup();
  app.quit();
});

app.on('will-quit', () => {
  runCleanup();
});

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:save', (_event, settings) => saveSettings(settings));

ipcMain.handle('stats:get', () => getStats());
ipcMain.handle('stats:save', (_event, stats) => saveStats(stats));

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

ipcMain.handle('dialog:openFile', async (_event, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: 'Video Files', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:selectOutputFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});
