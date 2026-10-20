const path = require('node:path');
const fs = require('node:fs/promises');
const ffmpeg = require('fluent-ffmpeg');
const { createTikTokService, createSecureStorage } = require('./tiktok-service');
const { createTikTokQueue, createQueueStorage } = require('./tiktok-queue');
const { createStudioDriver } = require('./tiktok-studio');
const { createStatisticsStore } = require('./tiktok-statistics');

function register({ app, ipcMain, safeStorage, shell, getWindow }) {
  const studio = createStudioDriver({ profilePath: path.join(app.getPath('userData'), 'tiktok-studio-profile') });
  const statistics = createStatisticsStore(path.join(app.getPath('userData'), 'tiktok-statistics.json'), id => studio.statistics(id));
  for (const method of ['get', 'refresh']) {
    ipcMain.handle(`tiktok:statistics:${method}`, async (event, payload) => {
      const win = getWindow();
      if (!win || event.senderFrame !== win.webContents.mainFrame) return { success: false, error: 'invalid_sender' };
      try { return { success: true, data: await statistics[method](payload) }; }
      catch (error) { return { success: false, error: /^[a-z_]{1,100}$/.test(error.message) ? error.message : 'statistics_storage_error' }; }
    });
  }
  const queue = createTikTokQueue({
    upload: (item, signal) => studio.upload(item, signal),
    storage: createQueueStorage(path.join(app.getPath('userData'), 'tiktok-queue.json')),
    notify: () => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('tiktok:queueChanged');
    }
  });
  for (const method of ['get', 'preferences', 'template', 'update', 'remove', 'send', 'pause', 'resume', 'reconcile', 'previewCaption', 'saveCaptionPreset', 'saveHashtagPreset', 'removeCaptionPreset', 'removeHashtagPreset']) {
    ipcMain.handle(`tiktok:queue:${method}`, async (event, payload) => {
      const win = getWindow();
      if (!win || event.senderFrame !== win.webContents.mainFrame) return { success: false, error: 'invalid_sender' };
      try { return { success: true, data: await queue[method](payload) }; }
      catch (error) { return { success: false, error: /^[a-z_]{1,100}$/.test(error.message) ? error.message : 'queue_storage_error' }; }
    });
  }
  ipcMain.handle('tiktok:queue:openVideo', async (event, id) => {
    const win = getWindow();
    if (!win || event.senderFrame !== win.webContents.mainFrame) return { success: false, error: 'invalid_sender' };
    try {
      const item = (await queue.get()).items.find(entry => entry.id === id);
      if (!item || !path.isAbsolute(item.filePath) || !/\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(item.filePath)) return { success: false, error: 'invalid_video_file' };
      const info = await fs.stat(item.filePath).catch(() => null);
      if (!info?.isFile()) return { success: false, error: 'video_file_missing' };
      if (await shell.openPath(item.filePath)) return { success: false, error: 'video_open_failed' };
      return { success: true };
    } catch { return { success: false, error: 'video_open_failed' }; }
  });
  for (const [channel, method] of Object.entries({ open: 'open', accounts: 'accounts', refreshAccounts: 'refreshAccounts', addAccount: 'addAccount' })) {
    ipcMain.handle(`tiktok:studio:${channel}`, async (event, payload) => {
      const win = getWindow();
      if (!win || event.senderFrame !== win.webContents.mainFrame) return { success: false, error: 'invalid_sender' };
      try { return { success: true, data: await studio[method](payload) }; }
      catch (error) { return { success: false, error: /^[a-z_]{1,100}$/.test(error.message) ? error.message : 'studio_edge_unavailable' }; }
    });
  }
  app.on('before-quit', () => { queue.shutdown(); studio.close().catch(() => {}); });
  const service = createTikTokService({
    storage: createSecureStorage(path.join(app.getPath('userData'), 'tiktok-credentials.enc'), safeStorage),
    openExternal: (url) => shell.openExternal(url),
    probe: (filePath) => new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (error, data) => {
        if (error) { reject(new Error('video_probe_failed')); return; }
        resolve({ duration: Number(data.format?.duration), hasVideo: data.streams?.some((s) => s.codec_type === 'video') });
      });
    }),
    onProgress: (progress) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('tiktok:progress', progress);
    }
  });
  for (const method of ['state', 'configure', 'connect', 'disconnect', 'creator', 'publish', 'status', 'cancel']) {
    ipcMain.handle(`tiktok:${method}`, async (event, payload) => {
      const win = getWindow();
      if (!win || event.senderFrame !== win.webContents.mainFrame) return { success: false, error: 'invalid_sender' };
      try { return { success: true, data: await service[method](payload) }; }
      catch (error) {
        const code = /^[a-zA-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'unexpected_tiktok_error';
        return { success: false, error: code };
      }
    });
  }
  app.on('before-quit', () => service.cancel());
  ipcMain.handle('tiktok:policy', async (event, name) => {
    const win = getWindow();
    const urls = { music: 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en',
      policy: 'https://www.tiktok.com/legal/page/global/bc-policy/en' };
    if (!win || event.senderFrame !== win.webContents.mainFrame || !Object.hasOwn(urls, name)) return { success: false, error: 'invalid_policy' };
    try { await shell.openExternal(urls[name]); return { success: true }; }
    catch { return { success: false, error: 'browser_open_failed' }; }
  });
  return { addGenerated: (files) => queue.addGenerated(files) };
}

module.exports = { register };
