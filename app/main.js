const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const { getSettings, saveSettings, getStats, saveStats } = require('./services/store');
const { runCleanup } = require('./services/cleanup');
const { isImageBanner, resolveDisplayDimensions } = require('./services/banner-utils');

let mainWindow = null;

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

function buildBannerThumbnail(filePath, isImage) {
  if (isImage) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > 4 * 1024 * 1024) return Promise.resolve(null);
      const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()] || 'image/png';
      return Promise.resolve(`data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`);
    } catch {
      return Promise.resolve(null);
    }
  }

  const out = path.join(os.tmpdir(), `ss_banner_thumb_${Date.now()}.png`);
  return new Promise((resolve) => {
    ffmpeg(filePath)
      .outputOptions(['-frames:v', '1', '-vf', 'scale=360:-2'])
      .output(out)
      .on('end', () => {
        try {
          resolve(`data:image/png;base64,${fs.readFileSync(out).toString('base64')}`);
        } catch {
          resolve(null);
        } finally {
          try { fs.unlinkSync(out); } catch {}
        }
      })
      .on('error', () => {
        try { fs.unlinkSync(out); } catch {}
        resolve(null);
      })
      .run();
  });
}

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

ipcMain.handle('media:probe', async (_event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string' || !fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' };
    }
    const data = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, probeData) => (err ? reject(err) : resolve(probeData)));
    });
    const stream = (data.streams || []).find((s) => s.width && s.height);
    if (!stream) return { success: false, error: 'No readable video stream' };
    const dims = resolveDisplayDimensions(stream);
    if (!dims.width || !dims.height) return { success: false, error: 'No readable video stream' };
    const isImage = isImageBanner(filePath);
    const thumbnail = await buildBannerThumbnail(filePath, isImage);
    return { success: true, width: dims.width, height: dims.height, isImage, thumbnail };
  } catch (err) {
    return { success: false, error: err.message || 'Probe failed' };
  }
});
