const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { runFfmpegCommand } = require('./cancellation');

// --- Tunable defaults -------------------------------------------------------
const SCENE_WINDOW_SEC = 15;          // candidate action window length
const SPEECH_COVERAGE_MAX = 0.12;     // window counts as quiet if less than this fraction is spoken
const CUTS_PER_MIN_BASELINE = 12;     // below this the montage is considered calm
const MIN_LUFS_DELTA = 4;             // how much louder than movie average a window must be
const MIN_CANDIDATE_GAP_SEC = 20;     // action candidates must not overlap each other
const SNAP_CUT_TOLERANCE_SEC = 1.5;   // snap scene start to a nearby cut point
const EDGE_TRIM_SEC = 0.25;           // generic safety trim
const CANDIDATE_POOL_FACTOR = 3;      // ranking pool = factor * requested scenes
const SCENE_CUT_SCORE_MIN = 0.4;      // scdet score above this counts as a hard cut
const SCDET_FPS = 8;                  // scene detection sampling rate

// --- Cinema clip duration limits (user-configurable) ------------------------
const CINEMA_TARGET_MIN_SEC = 10;
const CINEMA_TARGET_MAX_SEC = 300;
const CINEMA_TARGET_DEFAULT_SEC = 45;
const CINEMA_MAX_MIN_SEC = 15;
const CINEMA_MAX_MAX_SEC = 600;
const CINEMA_MAX_DEFAULT_SEC = 90;
const CINEMA_MIN_MIN_SEC = 5;
const CINEMA_MIN_MAX_SEC = 300;
const CINEMA_MIN_DEFAULT_SEC = 20;

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

/**
 * Normalize the cinema length guidance settings: target / min scene length
 * and the optional soft max (null when the limit is disabled). Pure function.
 */
function normalizeCinemaLengthConfig(config = {}) {
  const target = clampNumber(config?.cinemaTargetSec, CINEMA_TARGET_MIN_SEC, CINEMA_TARGET_MAX_SEC, CINEMA_TARGET_DEFAULT_SEC);
  const min = clampNumber(config?.cinemaMinSec, CINEMA_MIN_MIN_SEC, CINEMA_MIN_MAX_SEC, CINEMA_MIN_DEFAULT_SEC);
  const maxEnabled = config?.cinemaMaxSecEnabled !== false;
  const maxRaw = clampNumber(config?.cinemaMaxSec, CINEMA_MAX_MIN_SEC, CINEMA_MAX_MAX_SEC, CINEMA_MAX_DEFAULT_SEC);
  const max = Math.max(target, maxRaw);
  return { targetSec: target, minSec: min, maxSec: maxEnabled ? max : null };
}

/**
 * Build the cinema chunker profile. Cinema scenes are NEVER cut or merged by
 * the pipeline: scene length is a creative decision owned by the AI (guided
 * through the prompt), so the chunker profile disables every length action.
 * Pure function.
 */
function buildCinemaChunkProfile() {
  return {
    targetMinSec: 0,
    targetMaxSec: Infinity,
    hardMinSec: 0,
    hardMaxSec: Infinity,
    targetChunkDurationSec: 0,
    minChunkDurationSec: 0,
    maxChunkDurationSec: Infinity,
    maxCombinedDurationSec: Infinity,
    mergeShortChunks: false
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Parse ffmpeg ebur128 log lines ("t: 12.5 ... M: -18.4 S: -19.1 ...") into
 * per-interval momentary loudness readings: [{ start, end, lufs }].
 * Pure function.
 */
function parseEbur128(log) {
  const points = [];
  if (!log) return points;
  const re = /\bt:\s*([0-9]+\.?[0-9]*)\s+TARGET:.*?\bS:\s*(-?(?:[0-9]+\.?[0-9]*)|inf|-inf)/;
  for (const line of String(log).split(/\r?\n/)) {
    const match = re.exec(line);
    if (!match) continue;
    const t = Number(match[1]);
    if (!Number.isFinite(t)) continue;
    let lufs;
    if (/inf/i.test(match[2])) lufs = match[2].startsWith('-') ? -70 : 0;
    else lufs = Number(match[2]);
    if (!Number.isFinite(lufs)) continue;
    points.push({ t, lufs });
  }
  const intervals = [];
  const step = points.length >= 2 ? Math.max(0.01, points[1].t - points[0].t) : 0.1;
  for (let i = 0; i < points.length; i++) {
    intervals.push({
      start: Math.max(0, Number((points[i].t - step / 2).toFixed(3))),
      end: Number((points[i].t + step / 2).toFixed(3)),
      lufs: points[i].lufs
    });
  }
  return intervals;
}

/**
 * Parse ffmpeg metadata=print output (frame + lavfi.scene_score pairs) into
 * cut timestamps: [{ time, score }]. Pure function.
 */
function parseSceneCuts(log) {
  const cuts = [];
  if (!log) return cuts;
  const timeRe = /frame:[0-9]+\s+pts:[0-9]+\s+pts_time:([0-9]+\.?[0-9]*)/;
  const scoreRe = /lavfi\.(?:scene_score|scd\.score)=([0-9]+\.?[0-9]*)/;
  let pending = null;
  for (const line of String(log).split(/\r?\n/)) {
    const tMatch = timeRe.exec(line);
    if (tMatch) {
      if (pending) cuts.push(pending);
      pending = { time: Number(tMatch[1]), score: 0 };
      continue;
    }
    const sMatch = scoreRe.exec(line);
    if (sMatch && pending) {
      pending.score = Number(sMatch[1]);
    }
  }
  if (pending) cuts.push(pending);
  return cuts;
}

/**
 * Score sliding windows for action energy and pick non-overlapping top ones.
 * Pure function. A window scores high when it is much louder than the movie
 * average, cut-heavy (fast montage) and mostly speechless.
 *
 * @returns {Array<{start:number,end:number,score:number}>}
 */
function scoreActionWindows(loudnessIntervals, sceneCuts, speechSegments, totalDuration, requested) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0 || requested <= 0) return [];
  const speech = (Array.isArray(speechSegments) ? speechSegments : [])
    .map((s) => ({ start: Math.max(0, Number(s?.start) || 0), end: Number(s?.end) || 0 }))
    .filter((s) => s.end > s.start);

  const values = loudnessIntervals.map((i) => i.lufs).filter((v) => Number.isFinite(v));
  const avgLufs = values.length ? values.reduce((a, b) => a + b, 0) / values.length : -70;

  const windows = [];
  const step = SCENE_WINDOW_SEC / 2;
  for (let start = 0; start + SCENE_WINDOW_SEC <= totalDuration; start += step) {
    const end = start + SCENE_WINDOW_SEC;

    const inside = loudnessIntervals.filter((i) => i.start >= start && i.end <= end);
    const lufs = inside.length
      ? inside.reduce((acc, i) => acc + i.lufs, 0) / inside.length
      : avgLufs;

    const cuts = sceneCuts.filter((c) => c.time >= start && c.time < end);
    const cutsPerMin = (cuts.length / SCENE_WINDOW_SEC) * 60;

    const speechSeconds = speech.reduce((acc, s) => {
      const overlap = Math.min(end, s.end) - Math.max(start, s.start);
      return acc + Math.max(0, overlap);
    }, 0);
    const speechCoverage = speechSeconds / SCENE_WINDOW_SEC;

    const loudnessBoost = Math.max(0, lufs - (avgLufs + MIN_LUFS_DELTA));
    const cutBoost = Math.max(0, cutsPerMin - CUTS_PER_MIN_BASELINE);
    // The quiet bonus only applies when speech timing is known; without a
    // transcript every window would otherwise score a constant 8.
    const quietBonus = speech.length
      ? Math.max(0, 1 - speechCoverage / SPEECH_COVERAGE_MAX)
      : 0;

    const score = loudnessBoost * 6 + cutBoost * 1.2 + quietBonus * 8;
    windows.push({ start, end, score });
  }

  const ranked = windows
    .filter((w) => w.score > 0)
    .sort((a, b) => b.score - a.score || a.start - b.start);

  const picked = [];
  for (const candidate of ranked) {
    if (picked.length >= requested) break;
    const overlaps = picked.some((p) => candidate.start < p.end + MIN_CANDIDATE_GAP_SEC && candidate.end + MIN_CANDIDATE_GAP_SEC > p.start);
    if (overlaps) continue;
    picked.push(candidate);
  }

  return picked
    .sort((a, b) => a.start - b.start)
    .map((w) => ({ start: w.start, end: w.end, score: Number(w.score.toFixed(2)) }));
}

/**
 * Snap the scene start to a nearby detected cut (visual scene change) so the
 * clip does not begin mid-shot. Prefers a cut slightly before the start.
 * Pure function.
 */
function snapSceneToCuts(scene, sceneCuts, totalDuration) {
  const start = Math.max(0, Number(scene?.start) || 0);
  const end = Number(scene?.end) || start;
  const duration = Math.max(0, end - start);
  if (!duration || !Array.isArray(sceneCuts) || !sceneCuts.length) return { ...scene, start, end };

  const before = sceneCuts
    .filter((c) => c.time <= start && c.time >= start - SNAP_CUT_TOLERANCE_SEC * 3)
    .sort((a, b) => b.time - a.time)[0];
  const after = sceneCuts
    .filter((c) => c.time > start && c.time <= start + SNAP_CUT_TOLERANCE_SEC)
    .sort((a, b) => a.time - b.time)[0];

  let newStart = start;
  if (before && after) {
    newStart = before.time <= start - 0.05 ? before.time : after.time;
  } else if (before) {
    newStart = before.time;
  } else if (after) {
    newStart = after.time;
  }

  newStart = clamp(newStart, 0, Math.max(0, totalDuration - duration));
  return { ...scene, start: Number(newStart.toFixed(3)), end: Number((newStart + duration).toFixed(3)) };
}

/**
 * Build action scenes for cinema mode: score windows, snap to cuts, clamp to
 * safe edges and drop overlaps. Pure function.
 */
function buildActionScenes(energy, speechSegments, totalDuration, requested) {
  const windows = scoreActionWindows(
    energy.loudnessIntervals,
    energy.sceneCuts,
    speechSegments,
    totalDuration,
    Math.max(1, Math.ceil(requested * CANDIDATE_POOL_FACTOR))
  );

  const scenes = windows
    .map((w) => snapSceneToCuts(w, energy.sceneCuts, totalDuration))
    .map((s) => ({
      ...s,
      start: clamp(s.start, EDGE_TRIM_SEC, Math.max(0, totalDuration - EDGE_TRIM_SEC)),
      end: clamp(s.end, 0, totalDuration)
    }))
    .filter((s) => s.end - s.start >= Math.min(SCENE_WINDOW_SEC / 2, 7.5))
    .sort((a, b) => a.start - b.start);

  const dedup = [];
  for (const scene of scenes) {
    const prev = dedup[dedup.length - 1];
    if (prev && scene.start < prev.end + MIN_CANDIDATE_GAP_SEC) continue;
    dedup.push(scene);
  }
  return dedup.slice(0, Math.max(0, requested));
}

/**
 * ffmpeg passes over the source movie: loudness (ebur128) and visual cuts
 * (scene detection at reduced resolution). Cheap: video pass runs on 320x180.
 */
async function analyzeMovieEnergy(sourceVideo, onProgress, signal) {
  const say = (msg) => { try { onProgress?.(msg); } catch {} };

  say('Detecting action energy: loudness pass…');
  const loudnessIntervals = await runEbur128(sourceVideo, signal);

  say('Detecting action energy: scene-cut pass…');
  const sceneCuts = await runSceneDetection(sourceVideo, signal);

  return { loudnessIntervals, sceneCuts };
}

/**
 * Run an ffmpeg command capturing its combined stdout+stderr (filter tables
 * may print to either stream), then parse it with the supplied parser.
 * Reuses the shared runFfmpegCommand wrapper (abort + error formatting).
 */
async function runFfmpegCapturingOutput(buildCommand, parser, signal, label) {
  const chunks = [];
  const cmd = buildCommand()
    .on('stdout', (line) => chunks.push(line + '\n'))
    .on('stderr', (line) => chunks.push(line + '\n'));

  try {
    await runFfmpegCommand(cmd, { signal });
  } catch (err) {
    throw new Error(`${label} pass failed: ${err.message}`);
  }
  return parser(chunks.join(''));
}

function runEbur128(sourceVideo, signal) {
  return runFfmpegCapturingOutput(
    () => ffmpeg(sourceVideo)
      .noVideo()
      .audioFilters(['ebur128=peak=true'])
      .outputOptions(['-f', 'null'])
      .output('-'),
    parseEbur128,
    signal,
    'Loudness'
  );
}

function runSceneDetection(sourceVideo, signal) {
  // scdet (not select) prints a score for every frame; metadata=print:file=-
  // dumps it to stdout. Low fps + small resolution keep the pass fast.
  return runFfmpegCapturingOutput(
    () => ffmpeg(sourceVideo)
      .videoFilters([`fps=${SCDET_FPS},scale=320:180,scdet=threshold=8,metadata=print:file=-`])
      .outputOptions(['-an', '-f', 'null'])
      .output('-'),
    (log) => parseSceneCuts(log).filter((cut) => cut.score >= SCENE_CUT_SCORE_MIN),
    signal,
    'Scene detection'
  );
}

module.exports = {
  SCENE_WINDOW_SEC,
  SPEECH_COVERAGE_MAX,
  CUTS_PER_MIN_BASELINE,
  MIN_LUFS_DELTA,
  MIN_CANDIDATE_GAP_SEC,
  SNAP_CUT_TOLERANCE_SEC,
  EDGE_TRIM_SEC,
  CANDIDATE_POOL_FACTOR,
  SCENE_CUT_SCORE_MIN,
  SCDET_FPS,
  parseEbur128,
  parseSceneCuts,
  scoreActionWindows,
  snapSceneToCuts,
  buildActionScenes,
  analyzeMovieEnergy,
  buildCinemaChunkProfile,
  normalizeCinemaLengthConfig,
  normalizeCinemaSceneCount,
  normalizeActionScenes,
  scenesOverlap,
  buildCinemaSceneList,
  writeSceneMetaFile
};

// --- Pure cinema scene-list helpers (shared with process-handler) ----------

function normalizeCinemaSceneCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 10;
  return Math.max(5, Math.min(20, Math.round(numeric)));
}

function normalizeActionScenes(actionScenes, totalDuration, startOffset) {
  return (Array.isArray(actionScenes) ? actionScenes : [])
    .map((scene, i) => ({
      index: startOffset + i,
      title: `Action ${startOffset + i}`,
      hook: '',
      intensity: Number(scene?.score) || 0,
      start: Math.max(0, Number(scene?.start) || 0),
      end: Math.min(totalDuration, Number(scene?.end) || 0),
      source: 'action'
    }))
    .filter((scene) => scene.end - scene.start >= 5);
}

function scenesOverlap(a, b, minGapSec = 0) {
  return a.start < b.end + minGapSec && b.start < a.end + minGapSec;
}

/**
 * Merge LLM dialogue scenes with action candidates. Dialogue scenes always
 * win overlapping time ranges; action fills the remaining slots sorted by
 * detected energy.
 */
function buildCinemaSceneList(llmScenes, actionCandidates, totalDuration) {
  const llm = (Array.isArray(llmScenes) ? llmScenes : [])
    .map((scene, i) => ({
      index: i + 1,
      title: String(scene?.title || `Scene ${i + 1}`).trim() || `Scene ${i + 1}`,
      hook: String(scene?.hook || '').trim(),
      intensity: Number(scene?.intensity) || 0.5,
      start: Math.max(0, Number(scene?.start) || 0),
      end: Math.min(totalDuration, Number(scene?.end) || 0),
      source: 'llm'
    }))
    .filter((scene) => scene.end - scene.start >= 1)
    .sort((a, b) => a.start - b.start);

  const action = (Array.isArray(actionCandidates) ? actionCandidates : [])
    .filter((scene) => !llm.some((l) => scenesOverlap(l, scene, 1)));

  return [...llm, ...action].sort((a, b) => a.start - b.start);
}

/**
 * Write a TikTok upload note (title + hook + timestamps) next to the clip.
 */
function writeSceneMetaFile(outputFile, scene) {
  try {
    const metaPath = String(outputFile).replace(/\.mp4$/i, '') + '.txt';
    const mmss = (sec) => {
      const total = Math.max(0, Math.round(sec));
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };
    const lines = [
      `TITLE: ${scene?.title || ''}`,
      `HOOK: ${scene?.hook || '(action scene — add your own hook)'}`,
      `SOURCE: ${scene?.source === 'action' ? 'action energy' : 'dialogue'}`,
      `MOVIE TIME: ${mmss(Number(scene?.start) || 0)} - ${mmss(Number(scene?.end) || 0)}`
    ];
    fs.writeFileSync(metaPath, lines.join('\n') + '\n', 'utf8');
    return metaPath;
  } catch {
    return null;
  }
}
