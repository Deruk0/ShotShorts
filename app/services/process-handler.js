const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { MediaProcessor } = require('./media-processor');
const { WhisperService } = require('./whisper-service');
const { GroqStoryAnalyzer } = require('./groq-story-analyzer');
const { FontManager } = require('./font-manager');
const { getProxy } = require('./store');
const { isAbortError, runFfmpegCommand, throwIfAborted } = require('./cancellation');
const { alignStoriesToTranscript } = require('./story-padding');
const { buildStoryChunks, buildChunkProfile, fillTimelineGaps } = require('./story-chunker');
const {
  buildActionScenes,
  analyzeMovieEnergy,
  buildCinemaChunkProfile,
  normalizeCinemaLengthConfig,
  normalizeCinemaSceneCount,
  normalizeActionScenes,
  buildCinemaSceneList,
  applySceneEdits,
  snapDialogueSceneStart,
  writeSceneMetaFile
} = require('./cinema-scene-detector');
const { computeBannerLayout, isImageBanner, hasAlphaPixFmt } = require('./banner-utils');
const {
  normalizeCinemaBgCanvasFill,
  normalizeCinemaBgLayerOrder,
  computeCinemaClipLayout,
  computeCinemaBgRectLayout
} = require('./cinema-bg-utils');
const { resolveModelChain } = require('./model-registry');

let processor = null;
let isRunning = false;
let activeAbortController = null;
let activeReview = null; // pending cinema review: { resolve } or null

// Resolve the pending review (decision payload from the renderer or null
// when cancelled/aborted). No-op when no review is pending.
function resolveReview(payload) {
  const review = activeReview;
  activeReview = null;
  if (!review) return;
  try { review.resolve(payload || null); } catch {}
}

/**
 * Grab a single still frame from the source movie as a PNG data URL.
 * Input-side seek (-ss before -i) keeps it fast even deep into the movie.
 * Resolves null on any failure — a missing preview never blocks review.
 */
function captureStillFrame(sourceVideoPath, seekTo, widthPx) {
  const out = path.join(os.tmpdir(), `ss_cinema_review_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
  return new Promise((resolve) => {
    ffmpeg(sourceVideoPath)
      .setStartTime(Math.max(0, seekTo))
      .outputOptions(['-frames:v', '1', '-vf', `scale=${widthPx}:-2`])
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

async function captureScenePreviews(scenes, sourceVideoPath, onProgress, signal) {
  const previews = [];
  for (let i = 0; i < scenes.length; i++) {
    throwIfAborted(signal);
    const scene = scenes[i];
    const duration = Math.max(0, (Number(scene.end) || 0) - (Number(scene.start) || 0));
    const seekTo = (Number(scene.start) || 0) + Math.min(0.5, duration / 4);
    previews.push(await captureStillFrame(sourceVideoPath, seekTo, 180));
    onProgress?.(`Preparing scene previews: ${i + 1}/${scenes.length}`);
  }
  return previews;
}

/**
 * Cinema review pause: render one preview frame per scene, push the full
 * scene list to the renderer, and wait for its decision. Resolves with
 * { scenes } (edits applied) or null when declined/aborted/cancelled.
 */
async function requestSceneReview(scenes, config, ctx) {
  const { send, signal, sourceAudioDuration } = ctx;

  const previews = await captureScenePreviews(
    scenes,
    config.sourceVideo,
    (msg) => send({ step: 'Review Scenes', percent: 47, stage: 'render', stagePercent: 0, message: msg }),
    signal
  );
  throwIfAborted(signal);

  const reviewScenes = scenes.map((scene, i) => ({
    index: Number(scene.index) || i + 1,
    title: String(scene.title || ''),
    hook: String(scene.hook || ''),
    source: scene.source === 'action' ? 'action' : 'llm',
    start: Number((Number(scene.start) || 0).toFixed(2)),
    end: Number((Number(scene.end) || 0).toFixed(2)),
    durationSec: Number(Math.max(0, ((Number(scene.end) || 0) - (Number(scene.start) || 0))).toFixed(2)),
    intensity: Number(scene.intensity) || 0,
    preview: previews[i] || null
  }));

  // The review wait is billed to the render stage on purpose: it replaces
  // nothing, and the renderer's ETA simply holds its last estimate while
  // the user decides.
  send({
    step: 'Review Scenes',
    percent: 48,
    stage: 'render',
    stagePercent: 0,
    message: 'Waiting for scene review…',
    reviewScenes
  });

  const decision = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      activeReview = null;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    activeReview = { resolve: finish };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });

  if (!decision || decision.accept !== true) return null;

  const editMap = {};
  for (const edit of (Array.isArray(decision.scenes) ? decision.scenes : [])) {
    if (!edit || typeof edit !== 'object') continue;
    const idx = Number(edit.index);
    if (!Number.isFinite(idx)) continue;
    editMap[idx] = {
      include: edit.include !== false,
      start: Number(edit.start),
      end: Number(edit.end)
    };
  }

  return { scenes: applySceneEdits(scenes, editMap, sourceAudioDuration) };
}

// Fallback stage tagging for progress events that don't carry an explicit
// stage field (renderer builds its smooth ETA from these stage ids).
function inferStageFromStep(step) {
  const s = String(step || '').toLowerCase();
  if (/complete|done/.test(s)) return 'finalize';
  if (/extract/.test(s)) return 'extract';
  if (/compress|transcript audio/.test(s)) return 'compress';
  if (/transcrib/.test(s)) return 'transcribe';
  if (/analyzing scenes|detecting action|cinema mode|scenes selected/.test(s)) return 'scenes';
  if (/analyz/.test(s)) return 'analyze';
  if (/font|banner/.test(s)) return 'prepare';
  if (/render|story|scene|preparing/.test(s)) return 'render';
  return null;
}

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
    caseName: config.subtitleCase || 'sentence',
    customPos: !!config.subtitleCustomPos,
    customX: Number(config.subtitleX ?? 540),
    customY: Number(config.subtitleY ?? 1850)
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

  return runFfmpegCommand(cmd, { signal }).then(() => outPath).catch((err) => {
    try { fs.unlinkSync(outPath); } catch {}
    throw err;
  });
}

/**
 * Cinema mode pipeline: movie in → 5-20 viral scene clips out.
 * Reuses extractAudio/Whisper/subtitle/banner/render infrastructure, but
 * scene selection combines LLM (dialogue impact) with an ffmpeg energy
 * detector (loud, cut-heavy, speechless action), and the render uses the
 * movie's own frames instead of background videos.
 */
async function runCinemaPipeline(ctx) {
  const {
    config, send, signal, tempFiles, mp, whisper, whisperAudioPath,
    transcriptSegments, sourceAudioDuration, proxy, analysisModels,
    subtitlesEnabled, subtitleOffsetSec, subtitleOptions
  } = ctx;

  const sceneCount = normalizeCinemaSceneCount(config.cinemaSceneCount);
  const fillMode = config.cinemaFillMode === 'blur' ? 'blur' : 'crop';
  // Cinema scenes are never cut or merged by the pipeline: length is owned
  // by the AI, guided through the prompt via the normalized settings.
  const chunkProfile = buildCinemaChunkProfile();
  const lengthConfig = normalizeCinemaLengthConfig(config);

  send({ step: 'Cinema Mode', percent: 30, stage: 'scenes', stagePercent: null, message: `Selecting the top ${sceneCount} scenes…` });

  // LLM scene search over dialogue. A movie with no usable speech still
  // produces action-only output instead of failing.
  let llmScenes = [];
  if (transcriptSegments.length) {
    try {
      const analyzer = new GroqStoryAnalyzer([], proxy, null);
      analyzer.setModelChain(analysisModels);
      const analysis = await analyzer.analyzeScenes(
        transcriptSegments,
        sourceAudioDuration,
        sceneCount,
        (msg) => send({ step: 'Analyzing Scenes', percent: 34, stage: 'scenes', stagePercent: null, message: msg }),
        { signal, lengthConfig }
      );
      throwIfAborted(signal);
      llmScenes = alignStoriesToTranscript(analysis.scenes, transcriptSegments, sourceAudioDuration)
        .map((scene) => ({ ...scene, hook: scene.hook || '' }));
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      send({ step: 'Analyzing Scenes', percent: 36, stage: 'scenes', stagePercent: null, message: `Dialogue scene search failed (${err.message}). Falling back to action detection only.` });
    }
  }

  // Energy pass (loudness + visual cuts) runs for EVERY cinema job: the
  // detected cuts snap dialogue scene starts to real shot boundaries, and
  // action windows are built only when the LLM did not fill the quota.
  let energy = { loudnessIntervals: [], sceneCuts: [] };
  try {
    energy = await analyzeMovieEnergy(
      config.sourceVideo,
      (msg) => send({ step: 'Detecting Action', percent: 40, stage: 'scenes', stagePercent: null, message: msg }),
      signal
    );
  } catch (err) {
    if (isAbortError(err) || signal.aborted) throw err;
    send({ step: 'Detecting Action', percent: 44, stage: 'scenes', stagePercent: null, message: `Action detection failed (${err.message}). Continuing without energy data.` });
  }

  // Action candidates: loud + cut-heavy + speechless windows sized by the
  // user's target scene length.
  let actionScenes = [];
  const remaining = Math.max(0, sceneCount - llmScenes.length);
  if (remaining > 0 && energy.loudnessIntervals.length) {
    actionScenes = buildActionScenes(energy, transcriptSegments, sourceAudioDuration, remaining, lengthConfig);
  }

  let scenes = buildCinemaSceneList(
    llmScenes,
    normalizeActionScenes(actionScenes, sourceAudioDuration, llmScenes.length),
    sourceAudioDuration
  );

  // Dialogue scene starts snap to a nearby visual cut so no clip opens
  // mid-shot; the previous scene's end guards against overlaps.
  if (energy.sceneCuts.length) {
    let prevEnd = 0;
    scenes = scenes.map((scene) => {
      if (scene.source !== 'llm') {
        prevEnd = Math.max(prevEnd, scene.end);
        return scene;
      }
      const snapped = snapDialogueSceneStart(scene, energy.sceneCuts, sourceAudioDuration, prevEnd);
      prevEnd = Math.max(prevEnd, snapped.end);
      return snapped;
    });
  }

  if (!scenes.length) {
    return { success: false, error: 'No scenes could be selected from this movie.' };
  }

  // Action scenes get a human title + hook when the transcript inside their
  // window gives the model something to anchor on.
  if (scenes.some((scene) => scene.source === 'action') && transcriptSegments.length) {
    try {
      const titler = new GroqStoryAnalyzer([], proxy, null);
      titler.setModelChain(analysisModels);
      await titler.titleActionScenes(
        scenes,
        transcriptSegments,
        (msg) => send({ step: 'Naming Scenes', percent: 44, stage: 'scenes', stagePercent: null, message: msg }),
        { signal }
      );
      throwIfAborted(signal);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      send({ step: 'Naming Scenes', percent: 44, stage: 'scenes', stagePercent: null, message: `Action scene naming failed (${err.message}). Keeping fallback titles.` });
    }
  }

  // Optional review screen: pause before rendering and let the user exclude
  // scenes or move boundaries. Resolved by the cinema:reviewDecision IPC.
  if (config.cinemaReview) {
    const decision = await requestSceneReview(scenes, config, ctx);
    if (!decision) {
      return { success: false, cancelled: true, error: 'Cancelled at review' };
    }
    scenes = decision.scenes;
    if (!scenes.length) {
      send({ step: 'Complete!', percent: 100, stage: 'finalize', stagePercent: 100, message: 'No scenes left after review — nothing rendered.' });
      return { success: true, outputFiles: [], subtitleFailures: [], storiesDetected: 0, chunksProduced: 0, reviewDeclinedAll: true };
    }
  }

  send({
    step: 'Scenes Selected',
    percent: 46,
    stage: 'scenes',
    stagePercent: 100,
    message: `${scenes.filter((s) => s.source === 'llm').length} dialogue + ${scenes.filter((s) => s.source === 'action').length} action scene(s) selected`
  });

  const chunks = buildStoryChunks(scenes, transcriptSegments, chunkProfile);
  if (!chunks.length) {
    return { success: false, error: 'No valid scene chunks were produced.' };
  }

  // Fonts for subtitle burn-in.
  if (subtitlesEnabled) {
    try {
      throwIfAborted(signal);
      const fm = new FontManager();
      await fm.ensureTtfFonts((msg) => send({ step: 'Preparing Fonts', percent: 48, stage: 'prepare', stagePercent: null, message: msg }), signal);
      throwIfAborted(signal);
      if (fm.hasAnyTtf()) {
        subtitleOptions.fontsDir = fm.getTtfDir();
      } else {
        subtitleOptions.fontFamily = 'Arial';
      }
    } catch (fontErr) {
      if (isAbortError(fontErr) || signal.aborted) throw fontErr;
      subtitleOptions.fontFamily = 'Arial';
    }
  }

  // Banner (same overlay logic as story mode).
  let bannerOptions = null;
  if (config.bannerEnabled && config.bannerPath) {
    try {
      throwIfAborted(signal);
      if (!fs.existsSync(config.bannerPath)) throw new Error('banner file not found');
      const dims = await mp.getMediaDimensions(config.bannerPath);
      const layout = computeBannerLayout(
        { x: config.bannerX, y: config.bannerY, width: config.bannerWidth, height: config.bannerHeight },
        dims.width,
        dims.height
      );
      // Interstitial pauses are not supported in cinema mode yet: render
      // the banner as a plain overlay instead.
      bannerOptions = {
        path: config.bannerPath,
        isImage: isImageBanner(config.bannerPath),
        chromaKey: config.bannerChromaKey === true,
        layout,
        opacity: Math.max(0, Math.min(100, Number(config.bannerOpacity === undefined ? 100 : config.bannerOpacity))) / 100,
        bannerHasAudio: !!dims.hasAudio,
        interstitial: null
      };
    } catch (bannerErr) {
      if (isAbortError(bannerErr) || signal.aborted) throw bannerErr;
      send({ step: 'Banner Skipped', percent: 50, stage: 'prepare', stagePercent: null, message: `Banner disabled: ${bannerErr.message}.` });
      bannerOptions = null;
    }
  }

  // Parallel ADHD layer (cinema+bg): folder clips play muted and chained in
  // their own rectangle while the movie excerpt plays in the other one. The
  // selection context is shared across chunks so consecutive clips never
  // reuse the same background video (stories-mode semantics).
  let cinemaBgLayer = null;
  if (config.cinemaBgEnabled) {
    throwIfAborted(signal);
    const allBgs = mp.getBackgroundVideos(config.backgroundFolder);
    if (!allBgs.length) {
      return { success: false, error: 'No video files in background folder' };
    }
    cinemaBgLayer = {
      all: allBgs,
      unused: [...allBgs].sort(() => Math.random() - 0.5),
      durations: {},
      canvasFill: normalizeCinemaBgCanvasFill(config.cinemaBgCanvasFill),
      layerOrder: normalizeCinemaBgLayerOrder(config.cinemaBgLayerOrder),
      clipLayout: computeCinemaClipLayout(config),
      bgLayout: computeCinemaBgRectLayout(config)
    };
    send({ step: 'Cinema ADHD Layer', percent: 49, stage: 'prepare', stagePercent: null, message: `Parallel ADHD layer on: ${allBgs.length} clip(s) in the folder · canvas ${cinemaBgLayer.canvasFill}` });
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
      stage: 'render',
      stagePercent: data.percent,
      chunkIndex: i + 1,
      chunkCount: chunks.length,
      meta: { sourceDurationSec: sourceAudioDuration, chunkCount: chunks.length },
      message: data.message
    });

    let subtitlePath = null;
    if (subtitlesEnabled) {
      try {
        const localSegments = whisper.sliceSegments(transcriptSegments, chunk.start, chunk.end);
        if (localSegments.length > 0) {
          sp({ step: `Preparing Scene ${chunk.index}`, percent: 15, message: 'Preparing subtitles…' });
          const assContent = whisper.toASS(
            localSegments,
            subtitleOptions.stylePreset,
            subtitleOffsetSec,
            subtitleOptions,
            subtitleOptions.caseName
          );
          const assFile = path.join(os.tmpdir(), `ss_cinema_sub_${i}_${Date.now()}.ass`);
          fs.writeFileSync(assFile, assContent, 'utf8');
          tempFiles.push(assFile);
          subtitlePath = assFile;
        }
      } catch (subtitleErr) {
        if (isAbortError(subtitleErr) || signal.aborted) throw subtitleErr;
        subtitleFailures.push(chunk.index);
        subtitlePath = null;
      }
    }

    // Per-chunk ADHD selection: enough random folder clips to cover the
    // scene duration (+5s concat safety, same as stories backgrounds).
    let cinemaBg = null;
    if (cinemaBgLayer) {
      throwIfAborted(signal);
      const selection = await mp.selectBackgroundVideos(cinemaBgLayer, (chunk.end - chunk.start) + 5);
      cinemaBg = {
        files: selection.files,
        totalDur: selection.totalDur,
        canvasFill: cinemaBgLayer.canvasFill,
        layerOrder: cinemaBgLayer.layerOrder,
        clipLayout: cinemaBgLayer.clipLayout,
        bgLayout: cinemaBgLayer.bgLayout
      };
    }

    const out = await mp.assembleCinemaClip(
      chunk,
      config.sourceVideo,
      config.outputFolder,
      { fillMode, cinemaBg },
      sp,
      subtitlePath,
      subtitleOptions,
      bannerOptions
    );
    outputFiles.push(out);
    await ctx.onGenerated?.(out);
    throwIfAborted(signal);
    writeSceneMetaFile(out, chunk);
  }

  const doneMsg = `Created ${outputFiles.length} scene clip(s)`;
  send({ step: 'Complete!', percent: 100, stage: 'finalize', stagePercent: 100, message: doneMsg });
  return {
    success: true,
    outputFiles,
    subtitleFailures,
    storiesDetected: chunks.length,
    chunksProduced: chunks.length
  };
}

function register({ onGenerated = async () => {} } = {}) {
  const mp = new MediaProcessor();
  ipcMain.handle('process:start', async (event, config) => {
    if (isRunning) return { success: false, error: 'Process already running' };

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false, error: 'No window' };

    const isCinemaMode = !!config && config.mode === 'cinema';
    // The background folder is required for stories mode AND for cinema mode
    // with the parallel ADHD layer enabled.
    const cinemaBgActive = !!(config && isCinemaMode && config.cinemaBgEnabled);
    const needsBgFolder = !isCinemaMode || cinemaBgActive;
    if (!config || !config.sourceVideo || !config.outputFolder || (needsBgFolder && !config.backgroundFolder)) {
      return { success: false, error: 'Missing required configuration' };
    }

    isRunning = true;
    processor = mp;
    mp.reset();
    const abortController = new AbortController();
    activeAbortController = abortController;
    const { signal } = abortController;

    const send = (data) => {
      const payload = { ...data };
      const stage = data?.stage || inferStageFromStep(data?.step);
      if (stage) payload.stage = stage;
      try { win.webContents.send('process:progress', payload); } catch {}
    };
    const tempFiles = [];
    const generatedFiles = [];
    const deliveredFiles = new Set();
    const saveGenerated = async (result) => {
      const pending = generatedFiles.filter(file => !deliveredFiles.has(file));
      if (pending.length) {
        try {
          await onGenerated(pending);
          pending.forEach(file => deliveredFiles.add(file));
        } catch { result.tiktokQueueError = 'queue_storage_error'; }
      }
      return result;
    };
    const reportGenerated = async (file) => {
      generatedFiles.push(file);
      await saveGenerated({});
    };

    try {
      throwIfAborted(signal);
      if (!fs.existsSync(config.sourceVideo)) return { success: false, error: 'Source media not found' };
      if (needsBgFolder && !fs.existsSync(config.backgroundFolder)) return { success: false, error: 'Background folder not found' };
      if (!fs.existsSync(config.outputFolder)) fs.mkdirSync(config.outputFolder, { recursive: true });

      const proxy = await getProxy();
      const customModelList = Array.isArray(config.customModels) ? config.customModels : [];
      const customProviderList = Array.isArray(config.customProviders) ? config.customProviders : [];
      // Fallback chains: ordered model lists; when one model hits limits the
      // pipeline switches to the next entry automatically.
      const transcriptionModels = resolveModelChain(customModelList, customProviderList, config.transcriptionChain || []);
      const analysisModels = resolveModelChain(customModelList, customProviderList, config.analysisChain || []);
      if (!transcriptionModels.length || !analysisModels.length) {
        return { success: false, error: 'No AI model selected. Build the transcription and analysis chains in Settings → Custom AI Models.' };
      }

      send({ step: 'Extracting Audio', percent: 2, stage: 'extract', stagePercent: 0, message: 'Preparing source media…' });
      const audioPath = await mp.extractAudio(config.sourceVideo, (d) => send({
        step: d.step,
        percent: d.percent,
        stage: 'extract',
        stagePercent: d.stagePercent,
        message: d.message
      }));
      throwIfAborted(signal);
      if (audioPath) tempFiles.push(audioPath);
      const sourceAudioDuration = await mp.getVideoDuration(audioPath);
      throwIfAborted(signal);
      const whisperAudioPath = await prepareAudioForWhisper(audioPath, (data) => send({
        step: data.step,
        percent: 5 + Math.round((data.percent || 0) * 0.08),
        stage: 'compress',
        stagePercent: data.percent,
        message: data.message
      }), signal);
      throwIfAborted(signal);
      if (whisperAudioPath) tempFiles.push(whisperAudioPath);
      let whisperAudioBytes = 0;
      try { whisperAudioBytes = fs.statSync(whisperAudioPath).size; } catch {}

      const subtitlesEnabled = !!config.subtitlesEnabled;
      const subtitleLanguage = config.subtitleLanguage || 'ru';
      const subtitleOffsetSec = Number(config.subtitleOffsetMs || 0) / 1000;
      const subtitleOptions = buildSubtitleOptions(config);

      const whisper = new WhisperService();
      whisper.setProxy(proxy);

      const transcriptionLabel = transcriptionModels.map((entry) => `${entry.name} (${entry.modelId})`).join(' → ');

      // Structured transcription progress: message + optional info payload
      // { chunkIndex, chunkCount } / { upload: { loaded, total, bps, ts } }.
      const tx = { chunkIndex: 0, chunkCount: 0, upload: null, lastMsg: '' };
      const transcriptionProgress = (msg, info) => {
        if (msg) tx.lastMsg = msg;
        if (info) {
          if (Number(info.chunkIndex) > 0) {
            tx.chunkIndex = Number(info.chunkIndex);
            tx.chunkCount = Math.max(Number(info.chunkCount) || 0, tx.chunkIndex);
            tx.upload = null;
          }
          if (info.upload && Number(info.upload.total) > 0) tx.upload = info.upload;
        }
        let stagePercent = null;
        if (tx.chunkCount > 0) {
          const base = Math.max(0, tx.chunkIndex - 1) / tx.chunkCount;
          const within = (tx.upload && tx.upload.total > 0)
            ? Math.min(1, tx.upload.loaded / tx.upload.total) / tx.chunkCount
            : 0.5 / tx.chunkCount;
          stagePercent = Math.min(99, (base + within) * 100);
        } else if (tx.upload && tx.upload.total > 0) {
          stagePercent = Math.min(85, (tx.upload.loaded / tx.upload.total) * 85);
        }
        const bps = Number(tx.upload?.bps) || 0;
        const freshUpload = tx.upload && (Date.now() - Number(tx.upload.ts || 0)) < 5000;
        const speedText = freshUpload && bps > 0 ? `${(bps / 1048576).toFixed(1)} MB/s` : null;
        send({
          step: 'Transcribing Audio',
          percent: stagePercent == null ? 12 : 12 + Math.round((stagePercent / 100) * 18),
          stage: 'transcribe',
          stagePercent,
          chunkIndex: tx.chunkCount > 0 ? tx.chunkIndex : undefined,
          chunkCount: tx.chunkCount > 0 ? tx.chunkCount : undefined,
          upload: freshUpload ? { loaded: tx.upload.loaded, total: tx.upload.total, bps, ts: tx.upload.ts } : undefined,
          message: msg || (speedText ? `Uploading audio… ${speedText}` : (tx.lastMsg || 'Working…')),
          meta: { sourceDurationSec: sourceAudioDuration, audioBytes: whisperAudioBytes }
        });
      };

      send({
        step: 'Transcribing Audio',
        percent: 12,
        stage: 'transcribe',
        stagePercent: 0,
        message: `Sending audio to ${transcriptionLabel}…`,
        meta: { sourceDurationSec: sourceAudioDuration, audioBytes: whisperAudioBytes }
      });
      const transcriptSegments = await whisper.transcribe(
        whisperAudioPath,
        { language: subtitleLanguage, proxy, signal, models: transcriptionModels },
        transcriptionProgress
      );
      throwIfAborted(signal);

      if (isCinemaMode) {
        return await saveGenerated(await runCinemaPipeline({
          config, win, send, signal, tempFiles, mp, whisper, whisperAudioPath,
          transcriptSegments, sourceAudioDuration, proxy, analysisModels,
          subtitlesEnabled, subtitleLanguage, subtitleOffsetSec, subtitleOptions, onGenerated: reportGenerated
        }));
      }

      if (!transcriptSegments.length) {
        return { success: false, error: 'Whisper returned no transcript.' };
      }

      send({ step: 'Analyzing Stories', percent: 30, stage: 'analyze', stagePercent: null, message: 'Compressing transcript for analysis…' });
      const analyzer = new GroqStoryAnalyzer([], proxy, null);
      analyzer.setModelChain(analysisModels);
      const analysis = await analyzer.analyzeTranscript(
        transcriptSegments,
        sourceAudioDuration,
        (msg) => send({ step: 'Analyzing Stories', percent: 36, stage: 'analyze', stagePercent: null, message: msg }),
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
        stage: 'analyze',
        stagePercent: 100,
        message: `Found ${normalizedStories.length} stories from ${analysis.blocks.length} transcript blocks`
      });

      const allBgs = mp.getBackgroundVideos(config.backgroundFolder);
      if (!allBgs.length) return { success: false, error: 'No video files in background folder' };
      const bgContext = {
        all: allBgs,
        unused: [...allBgs].sort(() => Math.random() - 0.5),
        durations: {}
      };

      // Clip-length profile from user settings: soft target range drives
      // merging/splitting, hard bounds force the extreme cases. Gap-fill
      // clips reuse the same profile.
      const storiesProfile = buildChunkProfile({
        targetMinSec: Number(config.storiesTargetMinSec) || undefined,
        targetMaxSec: Number(config.storiesTargetMaxSec) || undefined,
        hardMinSec: Number(config.storiesHardMinSec) || undefined,
        hardMaxSec: Number(config.storiesHardMaxSec) || undefined
      });
      const storyChunks = buildStoryChunks(normalizedStories, transcriptSegments, storiesProfile);
      // Stories mode covers the WHOLE footage: the gaps between final clips
      // (intro, outros, unrelated talk) become standalone fill clips so
      // nothing from the source is lost. Gaps are computed AFTER chunking —
      // merged story clips change the boundaries.
      const gapSpans = fillTimelineGaps(storyChunks, sourceAudioDuration, { minGapSec: 30 });
      const gapChunks = buildStoryChunks(gapSpans, transcriptSegments, storiesProfile);
      const chunks = [...storyChunks, ...gapChunks]
        .sort((a, b) => a.start - b.start)
        .map((chunk, index) => ({ ...chunk, index: index + 1 }));
      if (gapChunks.length > 0) {
        send({
          step: 'Stories Detected',
          percent: 45,
          stage: 'analyze',
          stagePercent: 100,
          message: `Whole-footage mode: +${gapChunks.length} fill clip(s) for the uncovered parts`
        });
      }
      if (!chunks.length) {
        return { success: false, error: 'No valid story chunks were produced from Qwen output.' };
      }

      if (subtitlesEnabled) {
        try {
          throwIfAborted(signal);
          const fm = new FontManager();
          await fm.ensureTtfFonts((msg) => send({ step: 'Preparing Fonts', percent: 48, stage: 'prepare', stagePercent: null, message: msg }), signal);
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
      let bannerOptions = null;
      if (config.bannerEnabled && config.bannerPath) {
        const bannerOpacityPct = Math.max(0, Math.min(100, Number(config.bannerOpacity === undefined ? 100 : config.bannerOpacity)));
        if (bannerOpacityPct <= 0) {
          send({ step: 'Banner Hidden', percent: 50, stage: 'prepare', stagePercent: null, message: 'Banner visibility is 0% — rendering without banner.' });
        } else {
          try {
            throwIfAborted(signal);
            if (!fs.existsSync(config.bannerPath)) throw new Error('banner file not found');
            const dims = await mp.getMediaDimensions(config.bannerPath);
            const layout = computeBannerLayout(
              { x: config.bannerX, y: config.bannerY, width: config.bannerWidth, height: config.bannerHeight },
              dims.width,
              dims.height
            );
            // Interstitial pauses only work with video banners: an image has
            // neither motion nor sound to fill the pause. The pause lasts
            // exactly as long as the banner video itself.
            const interstitialDuration = Number(dims.durationSec);
            const interstitialVideo = config.bannerMode === 'interstitial' && !isImageBanner(config.bannerPath);
            if (interstitialVideo && !(interstitialDuration > 0)) {
              send({ step: 'Banner', percent: 50, stage: 'prepare', stagePercent: null, message: 'Banner video duration is unknown — falling back to overlay mode.' });
            }
            const interstitial = interstitialVideo && interstitialDuration > 0
              ? {
                intervalSec: Math.max(1, Number(config.bannerIntervalSec) || 60),
                durationSec: interstitialDuration
              }
              : null;
            bannerOptions = {
              path: config.bannerPath,
              isImage: isImageBanner(config.bannerPath),
              chromaKey: config.bannerChromaKey === true,
              layout,
              opacity: bannerOpacityPct / 100,
              bannerHasAudio: !!dims.hasAudio,
              interstitial
            };
            if (interstitial && !dims.hasAudio) {
              send({ step: 'Banner', percent: 50, stage: 'prepare', stagePercent: null, message: 'Banner video has no audio track — the pause will be silent.' });
            }
            // Real-world video banners (edit lists, VFR, rotation, odd sizes,
            // exotic codecs) get normalized once so looping always works.
            // Alpha sources (ProRes 4444, VP9 alpha) are passed through as-is:
            // the webm alpha round-trip loses transparency, while direct
            // overlay keeps it. Normalization also strips audio and caps the
            // length, so it must not run for interstitial banners.
            if (!bannerOptions.isImage && !interstitial && dims.codecName !== 'gif' && !hasAlphaPixFmt(dims.pixFmt)) {
              try {
                throwIfAborted(signal);
                const normalized = await mp.normalizeBannerVideo(bannerOptions.path, dims, (msg) => send({ step: 'Preparing Banner', percent: 50, stage: 'prepare', stagePercent: null, message: msg }));
                if (normalized && fs.existsSync(normalized)) {
                  tempFiles.push(normalized);
                  bannerOptions.path = normalized;
                }
              } catch (normErr) {
                if (isAbortError(normErr) || signal.aborted) throw normErr;
                send({ step: 'Banner', percent: 50, stage: 'prepare', stagePercent: null, message: `Banner normalization failed (${normErr.message}). Using original file.` });
              }
            }
            send({ step: 'Banner Ready', percent: 50, stage: 'prepare', stagePercent: 100, message: `Banner ${layout.width}x${layout.height} at ${layout.x},${layout.y} · ${bannerOpacityPct}%` });
          } catch (bannerErr) {
            if (isAbortError(bannerErr) || signal.aborted) throw bannerErr;
            send({ step: 'Banner Skipped', percent: 50, stage: 'prepare', stagePercent: null, message: `Banner disabled: ${bannerErr.message}. Rendering without banner.` });
            bannerOptions = null;
          }
        }
      }

      // Interstitial windows extend the output timeline: subtitles must skip
      // over the pause windows so they never render on top of the banner.
      // The pause configuration lives on bannerOptions (probed banner
      // duration) — this block must stay after the banner preparation above.
      if (bannerOptions?.interstitial) {
        subtitleOptions.interstitial = bannerOptions.interstitial;
      }

      const basePercent = 50;
      const perChunkPercent = 45 / Math.max(chunks.length, 1);
      for (let i = 0; i < chunks.length; i++) {
        throwIfAborted(signal);
        const chunk = chunks[i];
        const percentBase = basePercent + i * perChunkPercent;
        const sp = (data) => send({
          step: data.step,
          percent: Math.min(percentBase + (data.percent / 100) * perChunkPercent, 96),
          stage: 'render',
          stagePercent: data.percent,
          chunkIndex: i + 1,
          chunkCount: chunks.length,
          meta: { sourceDurationSec: sourceAudioDuration, chunkCount: chunks.length },
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
              stage: 'render',
              stagePercent: 0,
              chunkIndex: i + 1,
              chunkCount: chunks.length,
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
          subtitleOptions,
          bannerOptions
        );
        outputFiles.push(out);
        await reportGenerated(out);
        throwIfAborted(signal);
      }

      let doneMsg = `Created ${outputFiles.length} video(s)`;
      if (subtitleFailures.length > 0) {
        doneMsg += ` - subtitles unavailable for story ${subtitleFailures.join(', ')}`;
      }

      send({ step: 'Complete!', percent: 100, stage: 'finalize', stagePercent: 100, message: doneMsg });
      return await saveGenerated({
        success: true,
        outputFiles,
        subtitleFailures,
        storiesDetected: normalizedStories.length,
        chunksProduced: chunks.length
      });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) {
        send({ step: 'Cancelled', percent: 0, stage: null, message: 'Generation cancelled.' });
        return await saveGenerated({ success: false, cancelled: true, error: 'Cancelled' });
      }
      const msg = err.message || 'Unknown error';
      send({ step: 'Error', percent: 0, stage: null, message: msg });
      return await saveGenerated({ success: false, error: msg });
    } finally {
      processor = null;
      activeAbortController = null;
      activeReview = null;
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
    // A pending cinema review resolves as a cancellation so the waiting
    // pipeline unblocks immediately.
    resolveReview(null);
    if (processor) processor.cancel();
  });

  // Renderer's decision on the cinema review screen. Sent via ipcMain.on —
  // the pipeline result still travels through the process:start response.
  ipcMain.on('cinema:reviewDecision', (_event, payload) => {
    resolveReview(payload);
  });
}

module.exports = { register };
