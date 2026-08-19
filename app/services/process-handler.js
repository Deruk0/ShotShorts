const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { MediaProcessor } = require('./media-processor');
const { WhisperService } = require('./whisper-service');
const { GroqStoryAnalyzer } = require('./groq-story-analyzer');
const { FontManager } = require('./font-manager');
const { getProxy, getGroqApiKeys } = require('./store');
const { isAbortError, runFfmpegCommand, throwIfAborted } = require('./cancellation');
const { alignStoriesToTranscript } = require('./story-padding');
const { buildStoryChunks } = require('./story-chunker');

let processor = null;
let isRunning = false;
let activeAbortController = null;

function normalizeStories(stories, totalDuration) {
  return (Array.isArray(stories) ? stories : [])
    .map((story, index) => ({
      index: index + 1,
      title: String(story?.title || `Story ${index + 1}`).trim() || `Story ${index + 1}`,
      start: Math.max(0, Number(story?.start) || 0),
      end: Math.min(
        Number.isFinite(totalDuration) && totalDuration > 0 ? totalDuration : Number(story?.end) || 0,
        Number(story?.end) || 0
      )
    }))
    .filter((story) => Number.isFinite(story.start) && Number.isFinite(story.end) && story.end - story.start >= 1);
}

function buildSubtitleOptions(config) {
  return {
    stylePreset: config.subtitleStyle || 'Classic',
    position: config.subtitlePosition || 'bottom',
    wordsPerLine: Number(config.subtitleWordsPerLine || 3),
    maxLineMs: Number(config.subtitleMaxLineMs || 1200),
    fontSize: Number(config.subtitleFontSize || 20),
    fontFamily: config.subtitleFontFamily || 'Inter',
    marginV: Number(config.subtitleMarginV || 40),
    karaoke: !!config.subtitleKaraoke,
    karaokeMode: config.subtitleKaraokeMode || 'highlight',
    karaokeEffects: Array.isArray(config.subtitleKaraokeEffects) && config.subtitleKaraokeEffects.length > 0
      ? config.subtitleKaraokeEffects
      : ['highlight'],
    caseName: config.subtitleCase || 'sentence'
  };
}

function prepareAudioForWhisper(inputAudioPath, onProgress, signal) {
  throwIfAborted(signal);
  const outPath = path.join(os.tmpdir(), `ss_whisper_full_${Date.now()}.mp3`);
  onProgress?.({ step: 'Preparing Transcript Audio', percent: 0, message: 'Compressing audio for faster Whisper upload…' });

  const cmd = ffmpeg(inputAudioPath)
      .audioCodec('libmp3lame')
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('32k')
      .format('mp3')
      .output(outPath)
      .on('progress', (info) => {
        if (signal?.aborted) return;
        onProgress?.({
          step: 'Preparing Transcript Audio',
          percent: Math.min(Number(info?.percent) || 0, 100),
          message: `Compressing audio for Whisper… ${Math.round(Number(info?.percent) || 0)}%`
        });
      });

  return runFfmpegCommand(cmd, { signal }).then(() => outPath);
}

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
    const abortController = new AbortController();
    activeAbortController = abortController;
    const { signal } = abortController;

    const send = (data) => { try { win.webContents.send('process:progress', data); } catch {} };
    const tempFiles = [];

    try {
      throwIfAborted(signal);
      if (!fs.existsSync(config.sourceVideo)) return { success: false, error: 'Source media not found' };
      if (!fs.existsSync(config.backgroundFolder)) return { success: false, error: 'Background folder not found' };
      if (!fs.existsSync(config.outputFolder)) fs.mkdirSync(config.outputFolder, { recursive: true });

      const proxy = await getProxy();
      const groqApiKeys = await getGroqApiKeys();
      if (!Array.isArray(groqApiKeys) || groqApiKeys.length === 0) {
        return { success: false, error: 'No Groq API keys configured. Add at least one in Settings.' };
      }

      send({ step: 'Extracting Audio', percent: 2, message: 'Preparing source media…' });
      const audioPath = await mp.extractAudio(config.sourceVideo, send);
      throwIfAborted(signal);
      if (audioPath) tempFiles.push(audioPath);
      const sourceAudioDuration = await mp.getVideoDuration(audioPath);
      throwIfAborted(signal);
      const whisperAudioPath = await prepareAudioForWhisper(audioPath, (data) => send({
        step: data.step,
        percent: 10,
        message: data.message
      }), signal);
      throwIfAborted(signal);
      if (whisperAudioPath) tempFiles.push(whisperAudioPath);

      const subtitlesEnabled = !!config.subtitlesEnabled;
      const subtitleModel = config.subtitleModel || 'whisper-large-v3';
      const subtitleLanguage = config.subtitleLanguage || 'ru';
      const subtitleOffsetSec = Number(config.subtitleOffsetMs || 0) / 1000;
      const subtitleOptions = buildSubtitleOptions(config);

      const whisper = new WhisperService();
      whisper.setApiKeys(groqApiKeys);
      whisper.setProxy(proxy);

      send({ step: 'Transcribing Audio', percent: 12, message: `Sending audio to Groq Whisper (${subtitleModel})…` });
      const transcriptSegments = await whisper.transcribe(
        whisperAudioPath,
        { model: subtitleModel, language: subtitleLanguage, apiKeys: groqApiKeys, proxy, signal },
        (msg) => send({ step: 'Transcribing Audio', percent: 20, message: msg })
      );
      throwIfAborted(signal);

      if (!transcriptSegments.length) {
        return { success: false, error: 'Whisper returned no transcript.' };
      }

      send({ step: 'Analyzing Stories', percent: 30, message: 'Compressing transcript for Qwen…' });
      const analyzer = new GroqStoryAnalyzer(groqApiKeys, proxy);
      const analysis = await analyzer.analyzeTranscript(
        transcriptSegments,
        sourceAudioDuration,
        (msg) => send({ step: 'Analyzing Stories', percent: 36, message: msg }),
        { signal }
      );
      throwIfAborted(signal);

      const normalizedStories = alignStoriesToTranscript(
        normalizeStories(analysis.stories, sourceAudioDuration),
        transcriptSegments,
        sourceAudioDuration
      );
      if (!normalizedStories.length) {
        return { success: false, error: 'Qwen returned only invalid or empty story segments.' };
      }

      send({
        step: 'Stories Detected',
        percent: 45,
        message: `Found ${normalizedStories.length} stories from ${analysis.blocks.length} transcript blocks`
      });

      const allBgs = mp.getBackgroundVideos(config.backgroundFolder);
      if (!allBgs.length) return { success: false, error: 'No video files in background folder' };
      const bgContext = {
        all: allBgs,
        unused: [...allBgs].sort(() => Math.random() - 0.5),
        durations: {}
      };

      const chunks = buildStoryChunks(normalizedStories, transcriptSegments);
      if (!chunks.length) {
        return { success: false, error: 'No valid story chunks were produced from Qwen output.' };
      }

      if (subtitlesEnabled) {
        try {
          throwIfAborted(signal);
          const fm = new FontManager();
          await fm.ensureTtfFonts((msg) => send({ step: 'Preparing Fonts', percent: 48, message: msg }), signal);
          throwIfAborted(signal);
          if (fm.hasAnyTtf()) {
            subtitleOptions.fontsDir = fm.getTtfDir();
          } else {
            subtitleOptions.fontFamily = 'Arial';
          }
        } catch (fontErr) {
          console.log('[ShotShorts] FontManager.ensureTtfFonts failed:', fontErr.message);
          subtitleOptions.fontFamily = 'Arial';
        }
      }

      const outputFiles = [];
      const subtitleFailures = [];
      const basePercent = 50;
      const perChunkPercent = 45 / Math.max(chunks.length, 1);
      for (let i = 0; i < chunks.length; i++) {
        throwIfAborted(signal);
        const chunk = chunks[i];
        const percentBase = basePercent + i * perChunkPercent;
        const sp = (data) => send({
          step: data.step,
          percent: Math.min(percentBase + (data.percent / 100) * perChunkPercent, 96),
          message: data.message
        });

        let subtitlePath = null;
        if (subtitlesEnabled) {
          try {
            sp({ step: `Preparing Story ${chunk.index}`, percent: 0, message: 'Slicing subtitles from full transcript…' });
            const localSegments = whisper.sliceSegments(transcriptSegments, chunk.start, chunk.end);
            if (localSegments.length > 0) {
              // A VP9/WebM subtitle track can lose its alpha channel on some
              // Windows FFmpeg builds, turning the transparent layer black and
              // hiding the selected background footage. ASS is burned directly
              // into the already composed background and has no alpha layer.
              sp({ step: `Preparing Story ${chunk.index}`, percent: 15, message: 'Preparing subtitles…' });
              const assContent = whisper.toASS(
                localSegments,
                subtitleOptions.stylePreset,
                subtitleOffsetSec,
                subtitleOptions,
                subtitleOptions.caseName
              );
              const assFile = path.join(os.tmpdir(), `ss_sub_${i}_${Date.now()}.ass`);
              fs.writeFileSync(assFile, assContent, 'utf8');
              tempFiles.push(assFile);
              subtitlePath = assFile;
              sp({ step: `Preparing Story ${chunk.index}`, percent: 100, message: 'Subtitles ready' });
            } else {
              sp({ step: `Preparing Story ${chunk.index}`, percent: 100, message: 'No subtitle text inside this clip window' });
            }
          } catch (subtitleErr) {
            if (isAbortError(subtitleErr) || signal.aborted) throw subtitleErr;
            subtitleFailures.push(chunk.index);
            subtitlePath = null;
            send({
              step: `Story ${chunk.index}`,
              percent: percentBase,
              message: `Subtitle generation failed for story ${chunk.index} (${subtitleErr.message}). Rendering without subtitles.`
            });
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
        throwIfAborted(signal);
        outputFiles.push(out);
      }

      let doneMsg = `Created ${outputFiles.length} video(s)`;
      if (subtitleFailures.length > 0) {
        doneMsg += ` - subtitles unavailable for story ${subtitleFailures.join(', ')}`;
      }

      send({ step: 'Complete!', percent: 100, message: doneMsg });
      return {
        success: true,
        outputFiles,
        subtitleFailures,
        storiesDetected: normalizedStories.length
      };
    } catch (err) {
      if (isAbortError(err) || signal.aborted) {
        send({ step: 'Cancelled', percent: 0, message: 'Generation cancelled.' });
        return { success: false, cancelled: true, error: 'Cancelled' };
      }
      const msg = err.message || 'Unknown error';
      send({ step: 'Error', percent: 0, message: msg });
      return { success: false, error: msg };
    } finally {
      processor = null;
      activeAbortController = null;
      isRunning = false;
      for (const file of tempFiles) {
        try { if (file) fs.unlinkSync(file); } catch {}
      }
    }
  });

  ipcMain.on('process:cancel', () => {
    if (activeAbortController && !activeAbortController.signal.aborted) {
      activeAbortController.abort();
    }
    if (processor) processor.cancel();
  });
}

module.exports = { register };
