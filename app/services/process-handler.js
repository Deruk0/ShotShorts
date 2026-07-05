const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { MediaProcessor } = require('./media-processor');
const { WhisperService } = require('./whisper-service');
const { GroqStoryAnalyzer } = require('./groq-story-analyzer');
const { FontManager } = require('./font-manager');
const { SubtitleRenderer } = require('./subtitle-renderer');
const { getProxy, getGroqApiKeys } = require('./store');

let processor = null;
let isRunning = false;

const STORY_PADDING_SEC = 5;
const TARGET_CHUNK_DURATION_SEC = 180;
const MIN_CHUNK_DURATION_SEC = 60;
const MAX_CHUNK_DURATION_SEC = 300;
const CHUNK_OVERLAP_SEC = 5;

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

function splitLongStoryIntoParts(seg, totalDuration) {
  const chunks = [];
  const start = Math.max(0, seg.start - STORY_PADDING_SEC);
  const end = Math.min(totalDuration, seg.end + STORY_PADDING_SEC);
  const duration = end - start;

  let numParts = Math.max(2, Math.round(duration / TARGET_CHUNK_DURATION_SEC));
  while (numParts < 12) {
    const partLength = (duration + (numParts - 1) * CHUNK_OVERLAP_SEC) / numParts;
    if (partLength <= MAX_CHUNK_DURATION_SEC) break;
    numParts++;
  }

  const partLength = (duration + (numParts - 1) * CHUNK_OVERLAP_SEC) / numParts;
  let partStart = start;

  for (let partIndex = 0; partIndex < numParts; partIndex++) {
    const partEnd = partIndex === numParts - 1
      ? end
      : Math.min(end, partStart + partLength);
    chunks.push({
      ...seg,
      start: partStart,
      end: partEnd,
      partIndex: partIndex + 1
    });
    partStart = Math.max(partStart, partEnd - CHUNK_OVERLAP_SEC);
  }

  return chunks;
}

function buildStoryChunks(stories, totalDuration) {
  const chunks = [];
  let i = 0;

  while (i < stories.length) {
    const seg = { ...stories[i] };
    const start = Math.max(0, seg.start - STORY_PADDING_SEC);
    const end = Math.min(totalDuration, seg.end + STORY_PADDING_SEC);
    const duration = end - start;

    if (duration > MAX_CHUNK_DURATION_SEC) {
      chunks.push(...splitLongStoryIntoParts(seg, totalDuration));
      i++;
      continue;
    }

    let bestValid = duration >= MIN_CHUNK_DURATION_SEC
      ? { end, storyIndex: i, duration, distanceToTarget: Math.abs(duration - TARGET_CHUNK_DURATION_SEC) }
      : null;
    let bestFallback = { end, storyIndex: i, duration };
    let j = i;

    while (j + 1 < stories.length) {
      const nextSeg = stories[j + 1];
      const potentialEnd = Math.min(totalDuration, nextSeg.end + STORY_PADDING_SEC);
      const potentialDuration = potentialEnd - start;

      if (potentialDuration > MAX_CHUNK_DURATION_SEC) {
        break;
      }

      j++;
      bestFallback = { end: potentialEnd, storyIndex: j, duration: potentialDuration };

      if (potentialDuration >= MIN_CHUNK_DURATION_SEC) {
        const distanceToTarget = Math.abs(potentialDuration - TARGET_CHUNK_DURATION_SEC);
        if (!bestValid || distanceToTarget <= bestValid.distanceToTarget) {
          bestValid = { end: potentialEnd, storyIndex: j, duration: potentialDuration, distanceToTarget };
        }
      }
    }

    const chosen = bestValid || bestFallback;
    chunks.push({
      ...seg,
      start,
      end: chosen.end,
      partIndex: null
    });

    i = chosen.storyIndex + 1;
  }

  if (chunks.length > 1) {
    const lastChunk = chunks[chunks.length - 1];
    const prevChunk = chunks[chunks.length - 2];
    if (lastChunk.end - lastChunk.start < MIN_CHUNK_DURATION_SEC && lastChunk.end - prevChunk.start <= MAX_CHUNK_DURATION_SEC) {
      prevChunk.end = lastChunk.end;
      chunks.pop();
    }
  }

  return chunks;
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

function prepareAudioForWhisper(inputAudioPath, onProgress) {
  const outPath = path.join(os.tmpdir(), `ss_whisper_full_${Date.now()}.mp3`);
  onProgress?.({ step: 'Preparing Transcript Audio', percent: 0, message: 'Compressing audio for faster Whisper upload…' });

  return new Promise((resolve, reject) => {
    ffmpeg(inputAudioPath)
      .audioCodec('libmp3lame')
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('32k')
      .format('mp3')
      .output(outPath)
      .on('progress', (info) => {
        onProgress?.({
          step: 'Preparing Transcript Audio',
          percent: Math.min(Number(info?.percent) || 0, 100),
          message: `Compressing audio for Whisper… ${Math.round(Number(info?.percent) || 0)}%`
        });
      })
      .on('end', () => resolve(outPath))
      .on('error', (err, stdout, stderr) => reject(new Error(err.message + (stderr ? `\nstderr: ${stderr}` : ''))))
      .run();
  });
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

    const send = (data) => { try { win.webContents.send('process:progress', data); } catch {} };
    const tempFiles = [];
    let subtitleRenderer = null;

    try {
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
      if (audioPath) tempFiles.push(audioPath);
      const sourceAudioDuration = await mp.getVideoDuration(audioPath);
      const whisperAudioPath = await prepareAudioForWhisper(audioPath, (data) => send({
        step: data.step,
        percent: 10,
        message: data.message
      }));
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
        { model: subtitleModel, language: subtitleLanguage, apiKeys: groqApiKeys, proxy },
        (msg) => send({ step: 'Transcribing Audio', percent: 20, message: msg })
      );

      if (!transcriptSegments.length) {
        return { success: false, error: 'Whisper returned no transcript.' };
      }

      send({ step: 'Analyzing Stories', percent: 30, message: 'Compressing transcript for Qwen…' });
      const analyzer = new GroqStoryAnalyzer(groqApiKeys, proxy);
      const analysis = await analyzer.analyzeTranscript(
        transcriptSegments,
        sourceAudioDuration,
        (msg) => send({ step: 'Analyzing Stories', percent: 36, message: msg })
      );

      const normalizedStories = normalizeStories(analysis.stories, sourceAudioDuration);
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

      const chunks = buildStoryChunks(normalizedStories, sourceAudioDuration);
      if (!chunks.length) {
        return { success: false, error: 'No valid story chunks were produced from Qwen output.' };
      }

      if (subtitlesEnabled) {
        try {
          const fm = new FontManager();
          await fm.ensureTtfFonts((msg) => send({ step: 'Preparing Fonts', percent: 48, message: msg }));
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
      subtitleRenderer = subtitlesEnabled ? new SubtitleRenderer() : null;

      for (let i = 0; i < chunks.length; i++) {
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
              try {
                sp({ step: `Preparing Story ${chunk.index}`, percent: 15, message: 'Rendering subtitle overlay to match preview…' });
                const renderedSubtitle = await subtitleRenderer.renderSubtitleTrack(
                  localSegments,
                  {
                    ...subtitleOptions,
                    offsetSec: subtitleOffsetSec,
                    duration: chunk.end - chunk.start
                  },
                  os.tmpdir(),
                  (msg) => sp({ step: `Preparing Story ${chunk.index}`, percent: 25, message: msg })
                );
                tempFiles.push(renderedSubtitle);
                subtitlePath = renderedSubtitle;
              } catch (renderErr) {
                console.log('[ShotShorts] HTML subtitle renderer failed, falling back to ASS:', renderErr.message);
                sp({ step: `Preparing Story ${chunk.index}`, percent: 55, message: 'Preview-matched renderer failed, using ASS fallback…' });
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
              }
              sp({ step: `Preparing Story ${chunk.index}`, percent: 100, message: 'Subtitles ready' });
            } else {
              sp({ step: `Preparing Story ${chunk.index}`, percent: 100, message: 'No subtitle text inside this clip window' });
            }
          } catch (subtitleErr) {
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
      const msg = err.message || 'Unknown error';
      send({ step: 'Error', percent: 0, message: msg });
      return { success: false, error: msg };
    } finally {
      try {
        if (subtitleRenderer) await subtitleRenderer.close();
      } catch {}
      processor = null;
      isRunning = false;
      for (const file of tempFiles) {
        try { if (file) fs.unlinkSync(file); } catch {}
      }
    }
  });

  ipcMain.on('process:cancel', () => {
    if (processor) processor.cancel();
  });
}

module.exports = { register };
