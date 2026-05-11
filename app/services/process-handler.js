const { ipcMain, BrowserWindow } = require('electron');
const { GeminiClient } = require('./gemini-client');
const { MediaProcessor } = require('./media-processor');
const { WhisperService } = require('./whisper-service');
const { SubtitleRenderer } = require('./subtitle-renderer');
const { getApiKeys, getProxy } = require('./store');
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
      // Combine short stories (< 180s) with adjacent ones (use first story's title only)
      const mergedSegments = [];
      for (let i = 0; i < normalizedSegments.length; i++) {
        let seg = { ...normalizedSegments[i] };
        
        // Group stories if the current one is shorter than 3 minutes
        while ((seg.end - seg.start) < 180 && i + 1 < normalizedSegments.length) {
          let nextSeg = normalizedSegments[i + 1];
          seg.end = nextSeg.end;
          // Keep the FIRST story's title, do not concatenate
          i++; // Skip the next segment since it's merged
        }
        
        mergedSegments.push(seg);
      }

      // Split long stories (> 7 min and <= 15 min) into parts
      const chunks = [];
      
      for (let seg of mergedSegments) {
        let duration = seg.end - seg.start;
        
        if (duration > 420 && duration <= 900) { 
          // Story longer than 7 min (420s) and not more than 15 min (900s). Split it!
          // Target part duration ~4 minutes (240s)
          let numParts = Math.ceil(duration / 240);
          if (numParts > 3) numParts = 3; // Max 3 parts
          
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
          // If story <= 7 min or > 15 min — do not split
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
      const subtitleModel    = config.subtitleModel || 'medium';
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

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const pBase = base + (i * per);
        const sp = (d) => send({ 
          step: d.step, 
          percent: Math.min(pBase + (d.percent / 100) * per, 95), 
          message: d.message 
        });

        // --- Optional transcription via HTML→PNG→WebM (100% CSS match) ---
        let subtitlePath = null;
        let subtitleRenderer = null;
        if (subtitlesEnabled) {
          try {
            const chunkDuration = chunk.end - chunk.start;
            // Extract the segment audio first (whisper needs the exact clip)
            const segWav = path.join(os.tmpdir(), `ss_whisper_${i}_${Date.now()}.wav`);
            tempFiles.push(segWav);

            sp({ step: `Transcribing Story ${chunk.index}`, percent: 0, message: 'Extracting segment audio for Whisper…' });
            await new Promise((res, rej) => {
              const ffmpegBin = require('fluent-ffmpeg');
              ffmpegBin(audioPath)
                .setStartTime(chunk.start)
                .setDuration(chunkDuration)
                .audioCodec('pcm_s16le').audioChannels(1).audioFrequency(16000)
                .format('wav').output(segWav)
                .on('end', res)
                .on('error', (e) => rej(e))
                .run();
            });

            const segments = await whisper.transcribe(
              segWav,
              { model: subtitleModel, language: subtitleLanguage },
              (msg) => sp({ step: `Transcribing Story ${chunk.index}`, percent: 30, message: msg })
            );

            // Try HTML→PNG renderer first (100% CSS match), fallback to ASS
            subtitleRenderer = new SubtitleRenderer();
            const chromiumFound = subtitleRenderer.isAvailable();
            console.log(`[ShotShorts] Chromium available: ${chromiumFound}, path: ${subtitleRenderer.chromiumPath || 'none'}`);
            if (chromiumFound) {
              sp({ step: `Transcribing Story ${chunk.index}`, percent: 50, message: 'Rendering subtitles via HTML→PNG…' });
              try {
                const subVideoPath = await subtitleRenderer.renderSubtitleTrack(
                  segments,
                  subtitleOptions,
                  os.tmpdir(),
                  (msg) => sp({ step: `Transcribing Story ${chunk.index}`, percent: 75, message: msg })
                );
                tempFiles.push(subVideoPath);
                subtitlePath = subVideoPath;
                console.log(`[ShotShorts] Subtitle video rendered: ${subVideoPath}`);
              } catch (renderErr) {
                console.error(`[ShotShorts] HTML subtitle render failed: ${renderErr.message}, falling back to ASS`);
                sp({ step: `Transcribing Story ${chunk.index}`, percent: 50, message: `HTML render failed, using ASS fallback…` });
                // Immediate ASS fallback — do not throw
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
                console.log(`[ShotShorts] ASS subtitle written (fallback): ${assFile}`);
              }
            } else {
              console.log('[ShotShorts] Chromium not found, using ASS fallback');
              sp({ step: `Transcribing Story ${chunk.index}`, percent: 50, message: 'Chromium not found, using ASS fallback…' });
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
            }

            sp({ step: `Transcribing Story ${chunk.index}`, percent: 100, message: 'Subtitles ready ✓' });
          } catch (whisperErr) {
            const failMsg = `Subtitles failed for story ${chunk.index}: ${whisperErr.message}`;
            send({ step: `Story ${chunk.index}`, percent: 0, message: failMsg });
            throw new Error(failMsg);
          } finally {
            if (subtitleRenderer) {
              try { await subtitleRenderer.close(); } catch {}
            }
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
