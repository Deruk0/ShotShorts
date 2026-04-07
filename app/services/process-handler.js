const { ipcMain, BrowserWindow } = require('electron');
const { GeminiClient } = require('./gemini-client');
const { MediaProcessor } = require('./media-processor');
const { getApiKeys, getProxy } = require('./store');
const fs = require('fs');

let processor = null;
let isRunning = false;

function register() {
  const mp = new MediaProcessor();

  ipcMain.handle('process:start', async (event, config) => {
    if (isRunning) return { success: false, error: 'Process already running' };

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false, error: 'No window' };

    if (!config || !config.sourceVideo || !config.backgroundFolder || !config.outputFolder) {
      return { success: false, error: 'Missing required configuration' };
    }

    isRunning = true;
    processor = mp;
    mp.reset();

    const send = (data) => { try { win.webContents.send('process:progress', data); } catch {} };

    const tempFiles = [];

    try {
      if (!fs.existsSync(config.sourceVideo)) return { success: false, error: 'Source video not found' };
      if (!fs.existsSync(config.backgroundFolder)) return { success: false, error: 'Background folder not found' };
      if (!fs.existsSync(config.outputFolder)) fs.mkdirSync(config.outputFolder, { recursive: true });

      // 1. Extract audio
      send({ step: 'Extracting Audio', percent: 2, message: 'Starting…' });
      const audioPath = await mp.extractAudio(config.sourceVideo, send);
      if (audioPath) tempFiles.push(audioPath);

      // 2. AI analysis
      send({ step: 'Analyzing Audio', percent: 22, message: 'Optimizing audio for AI (makes sending faster)…' });
      const aiAudioPath = await mp.downsampleAudioForAI(audioPath, send);
      if (aiAudioPath) tempFiles.push(aiAudioPath);
      
      send({ step: 'Analyzing Audio', percent: 25, message: 'Sending to Gemini AI…' });
      const apiKeys = (await getApiKeys()) || [];
      const proxy = await getProxy();
      if (!apiKeys || apiKeys.length === 0) return { success: false, error: 'No Gemini API keys configured' };

      const gemini = new GeminiClient(apiKeys, proxy);
      const segments = await gemini.analyzeAudio(aiAudioPath, (msg) => {
        send({ step: 'AI Analysis', percent: 25, message: msg });
      });
      // (aiAudioPath will be cleaned up in finally block)
      
      if (!segments?.length) return { success: false, error: 'No stories detected by AI' };

      // Add 5-second buffer to start and end of each segment
      for (const seg of segments) {
        seg.start = Math.max(0, seg.start - 5);
        seg.end = seg.end + 5;
      }

      send({ step: 'Stories Detected', percent: 35, message: `Found ${segments.length} stories` });

      // 3. Background videos
      const allBgs = mp.getBackgroundVideos(config.backgroundFolder);
      if (!allBgs.length) return { success: false, error: 'No video files in background folder' };
      const bgContext = {
        all: allBgs,
        unused: [...allBgs].sort(() => Math.random() - 0.5),
        durations: {}
      };

      // 4. Assemble each story
      const outputFiles = [];
      const base = 35;
      // Combine short stories (< 120s) with adjacent ones
      const mergedSegments = [];
      for (let i = 0; i < segments.length; i++) {
        let seg = { ...segments[i] };
        
        // Group stories if the current one is shorter than 2 minutes
        while ((seg.end - seg.start) < 120 && i + 1 < segments.length) {
          let nextSeg = segments[i + 1];
          seg.end = nextSeg.end;
          seg.title = seg.title + " & " + (nextSeg.title || `Story ${nextSeg.index}`);
          i++; // Skip the next segment since it's merged
        }
        
        mergedSegments.push(seg);
      }

      // СИСТЕМА ДЕЛЕНИЯ (работает только для историй <= 15 минут)
      const chunks = [];
      
      for (let seg of mergedSegments) {
        let duration = seg.end - seg.start;
        
        if (duration > 420 && duration <= 900) { 
          // История больше 7 минут (420с) и не более 15 минут (900с). Делим!
          // Целимся на длительность частей около 4 минут (240с)
          let numParts = Math.ceil(duration / 240);
          if (numParts > 3) numParts = 3; // Максимум 3 части
          
          let partLength = (duration + (numParts - 1) * 5) / numParts;
          let pStart = seg.start;
          
          for (let j = 0; j < numParts; j++) {
            let pEnd = (j === numParts - 1) ? seg.end : pStart + partLength;
            chunks.push({ 
              ...seg, 
              start: pStart, 
              end: pEnd, 
              partIndex: null 
            });
            // 5 секунд нахлеста для следующей части
            pStart = pEnd - 5; 
          }
        } else {
          // Если история <= 7 минут или > 15 минут — не делим
          chunks.push({ 
            ...seg, 
            partIndex: null 
          });
        }
      }

      // Assign part indices to chunks with the same title
      const titleCounts = {};
      chunks.forEach(c => titleCounts[c.title] = (titleCounts[c.title] || 0) + 1);
      const titleCurrent = {};
      chunks.forEach((c, index) => {
        c.index = index + 1;
        if (titleCounts[c.title] > 1) {
          titleCurrent[c.title] = (titleCurrent[c.title] || 0) + 1;
          c.partIndex = titleCurrent[c.title];
        }
      });

      const per = 60 / chunks.length;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const pBase = base + (i * per);
        const sp = (d) => send({ 
          step: d.step, 
          percent: Math.min(pBase + (d.percent / 100) * per, 95), 
          message: d.message 
        });
        const out = await mp.assembleVideo(chunk, audioPath, bgContext, config.outputFolder, sp);
        outputFiles.push(out);
      }

      // (audioPath will be cleaned up in finally block)
      send({ step: 'Complete!', percent: 100, message: `Created ${outputFiles.length} video(s)` });
      return { success: true, outputFiles };

    } catch (err) {
      const msg = err.message || 'Unknown error';
      send({ step: 'Error', percent: 0, message: msg });
      return { success: false, error: msg };
    } finally {
      processor = null;
      isRunning = false;
      for (const f of tempFiles) {
        try { if (f) fs.unlinkSync(f); } catch {}
      }
    }
  });

  ipcMain.on('process:cancel', () => { if (processor) processor.cancel(); });
}

module.exports = { register };
