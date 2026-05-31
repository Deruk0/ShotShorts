const { ipcMain, BrowserWindow } = require('electron');
const { OpenRouterClient } = require('./openrouter-client');
const { NvidiaClient } = require('./nvidia-client');
const { MediaProcessor } = require('./media-processor');
const { WhisperService } = require('./whisper-service');
const { FontManager } = require('./font-manager');
const { getApiProvider, getApiKeys, getNvidiaApiKeys, getProxy, getGroqApiKey } = require('./store');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
      const sourceAudioDuration = await mp.getVideoDuration(audioPath);

      // 2. AI analysis
      send({ step: 'Analyzing Audio', percent: 22, message: 'Optimizing audio for AI (makes sending faster)…' });
      const aiAudioPath = await mp.downsampleAudioForAI(audioPath, send);
      if (aiAudioPath) tempFiles.push(aiAudioPath);

      const apiProvider = await getApiProvider();
      const proxy = await getProxy();

      let apiKeys;
      let client;
      let providerName;
      if (apiProvider === 'nvidia') {
        apiKeys = (await getNvidiaApiKeys()) || [];
        providerName = 'NVIDIA NIM';
        client = new NvidiaClient(apiKeys, proxy);
      } else {
        apiKeys = (await getApiKeys()) || [];
        providerName = 'OpenRouter';
        client = new OpenRouterClient(apiKeys, proxy);
      }

      send({ step: 'Analyzing Audio', percent: 25, message: `Sending to NVIDIA Nemotron AI via ${providerName}…` });
      if (!apiKeys || apiKeys.length === 0) return { success: false, error: `No ${providerName} API keys configured` };
      const segments = await client.analyzeAudio(aiAudioPath, (msg) => {
        send({ step: 'AI Analysis', percent: 25, message: msg });
      });
      // (aiAudioPath will be cleaned up in finally block)

      if (!segments?.length) return { success: false, error: 'No stories detected by AI' };

      // Add 5-second buffer and clamp to real audio duration to avoid silent/out-of-range chunks.
      const normalizedSegments = segments
        .map((seg) => ({
          ...seg,
          start: Math.max(0, Number(seg.start || 0) - 5),
          end: Math.min(
            Number.isFinite(sourceAudioDuration) && sourceAudioDuration > 0 ? sourceAudioDuration : Number(seg.end || 0) + 5,
            Number(seg.end || 0) + 5
          )
        }))
        .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end - seg.start >= 1.0);
      if (!normalizedSegments.length) return { success: false, error: 'AI returned only invalid/out-of-range story segments' };

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
      // Combine short stories (< 120s / 2 min) with adjacent ones (use first story's title only)
      const MAX_GAP_SEC = 30; // Don't merge segments that are more than 30s apart
      const mergedSegments = [];
      for (let i = 0; i < normalizedSegments.length; i++) {
        let seg = { ...normalizedSegments[i] };

        // Group stories if the current one is shorter than 2 minutes and the next one is close enough
        while (i + 1 < normalizedSegments.length) {
          const duration = seg.end - seg.start;
          if (duration >= 120) break;
          const nextSeg = normalizedSegments[i + 1];
          const gap = Math.abs(nextSeg.start - seg.end);
          if (gap > MAX_GAP_SEC) break; // Too far apart — don't merge
          seg.end = nextSeg.end;
          // Keep the FIRST story's title, do not concatenate
          i++; // Skip the next segment since it's merged
        }

        mergedSegments.push(seg);
      }

      // Split long stories (> 5 min / 300s) into parts
      const chunks = [];

      for (let seg of mergedSegments) {
        let duration = seg.end - seg.start;

        if (duration > 300) {
          // Story longer than 5 min — split into parts (~3 min each)
          let numParts = Math.ceil(duration / 180);
          if (numParts > 5) numParts = 5; // Max 5 parts

          let partLength = (duration + (numParts - 1) * 5) / numParts;
          let pStart = seg.start;

          for (let j = 0; j < numParts; j++) {
            let pEnd = (j === numParts - 1) ? seg.end : pStart + partLength;
            chunks.push({
              ...seg,
              start: pStart,
              end: pEnd,
              partIndex: j + 1
            });
            // 5 second overlap for next part
            pStart = pEnd - 5;
          }
        } else {
          // Story 2-5 min — keep as-is
          chunks.push({
            ...seg,
            partIndex: null
          });
        }
      }

      if (chunks.length === 0) {
        return { success: false, error: 'No valid story chunks were produced from AI segments' };
      }

      const per = 60 / chunks.length;
      const whisper = new WhisperService();
      const subtitlesEnabled = !!config.subtitlesEnabled;
      const subtitleStyle    = config.subtitleStyle || 'Classic';
      const subtitleModel    = config.subtitleModel || 'whisper-large-v3';
      const subtitleLanguage = config.subtitleLanguage || 'ru';
      const subtitleOptions  = {
        stylePreset:   subtitleStyle,
        position:      config.subtitlePosition    || 'bottom',
        wordsPerLine:  Number(config.subtitleWordsPerLine || 3),
        maxLineMs:     Number(config.subtitleMaxLineMs    || 1200),
        fontSize:      Number(config.subtitleFontSize     || 20),
        fontFamily:    config.subtitleFontFamily || 'Inter',
        marginV:       Number(config.subtitleMarginV      || 40),
        karaoke:       !!config.subtitleKaraoke,
        karaokeMode:   config.subtitleKaraokeMode    || 'highlight',
        karaokeEffects: Array.isArray(config.subtitleKaraokeEffects) && config.subtitleKaraokeEffects.length > 0
          ? config.subtitleKaraokeEffects
          : ['highlight'],
        caseName:      config.subtitleCase || 'sentence'
      };
      console.log('[ShotShorts] Subtitle options:', JSON.stringify(subtitleOptions));

      // Get Groq API key for transcription
      let groqApiKey = null;
      if (subtitlesEnabled) {
        groqApiKey = await getGroqApiKey();
        if (!groqApiKey) {
          return { success: false, error: 'Subtitles enabled but no Groq API key configured. Add it in Settings.' };
        }
        whisper.setApiKey(groqApiKey);
        whisper.setProxy(proxy);

        // Make sure libass can find the chosen UI font (Inter / Montserrat /
        // Oswald / JetBrains Mono). Best-effort: if download fails we fall
        // back to a system font so the export never breaks.
        try {
          const fm = new FontManager();
          await fm.ensureTtfFonts((msg) => send({ step: 'Preparing fonts', percent: 36, message: msg }));
          if (fm.hasAnyTtf()) {
            subtitleOptions.fontsDir = fm.getTtfDir();
          } else {
            subtitleOptions.fontFamily = 'Arial';
            console.log('[ShotShorts] No TTF fonts cached; falling back to Arial in ASS.');
          }
        } catch (fontErr) {
          console.log('[ShotShorts] FontManager.ensureTtfFonts failed:', fontErr.message);
          subtitleOptions.fontFamily = 'Arial';
        }
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const pBase = base + (i * per);
        const sp = (d) => send({
          step: d.step,
          percent: Math.min(pBase + (d.percent / 100) * per, 95),
          message: d.message
        });

        // --- Transcription via Groq API → ASS burn-in ---
        let subtitlePath = null;
        if (subtitlesEnabled) {
          try {
            const chunkDuration = chunk.end - chunk.start;

            sp({ step: `Transcribing Story ${chunk.index}`, percent: 0, message: 'Extracting segment audio for Whisper…' });
            // Compress to MP3 for faster upload (~10x smaller than WAV)
            const segMp3 = path.join(os.tmpdir(), `ss_whisper_${i}_${Date.now()}.mp3`);
            tempFiles.push(segMp3);
            await new Promise((res, rej) => {
              const ffmpegBin = require('fluent-ffmpeg');
              ffmpegBin(audioPath)
                .setStartTime(chunk.start)
                .setDuration(chunkDuration)
                .audioCodec('libmp3lame').audioChannels(1).audioFrequency(16000)
                .audioBitrate('64k')
                .format('mp3').output(segMp3)
                .on('end', res)
                .on('error', (e) => rej(e))
                .run();
            });

            const mp3Size = fs.statSync(segMp3).size;
            console.log(`[ShotShorts] MP3 file: ${(mp3Size / 1024).toFixed(0)} KB, proxy: ${proxy ? `${proxy.host}:${proxy.port}` : 'none'}`);

            const segments = await whisper.transcribe(
              segMp3,
              { model: subtitleModel, language: subtitleLanguage, apiKey: groqApiKey, proxy },
              (msg) => sp({ step: `Transcribing Story ${chunk.index}`, percent: 30, message: msg })
            );

            // Generate ASS subtitle file directly (no Playwright/Chromium needed)
            sp({ step: `Transcribing Story ${chunk.index}`, percent: 80, message: 'Generating subtitles…' });
            const assContent = whisper.toASS(
              segments,
              subtitleStyle,
              0,
              subtitleOptions,
              subtitleOptions.caseName || 'sentence'
            );
            const assFile = path.join(os.tmpdir(), `ss_sub_${i}_${Date.now()}.ass`);
            fs.writeFileSync(assFile, assContent, 'utf8');
            tempFiles.push(assFile);
            subtitlePath = assFile;
            console.log(`[ShotShorts] ASS subtitle written: ${assFile}`);

            sp({ step: `Transcribing Story ${chunk.index}`, percent: 100, message: 'Subtitles ready' });
          } catch (whisperErr) {
            const failMsg = `Subtitles failed for story ${chunk.index}: ${whisperErr.message}`;
            send({ step: `Story ${chunk.index}`, percent: 0, message: failMsg });
            throw new Error(failMsg);
          }
        }

        const out = await mp.assembleVideo(
          chunk,
          audioPath,
          bgContext,
          config.outputFolder,
          sp,
          subtitlePath,
          subtitleOptions
        );
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
