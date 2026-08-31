const path = require('path');

const BANNER_CANVAS_WIDTH = 1080;
const BANNER_CANVAS_HEIGHT = 1920;
const BANNER_MIN_SIZE = 20;
const BANNER_MAX_WIDTH = BANNER_CANVAS_WIDTH * 2;
const BANNER_MAX_HEIGHT = BANNER_CANVAS_HEIGHT * 2;
const BANNER_DEFAULT_WIDTH = 300;
// The banner may hang outside the frame, but at least this many pixels
// must stay inside the canvas so it cannot be lost completely.
const BANNER_MIN_VISIBLE = 10;
// Invisible snap guides: banner edges/center stick to canvas edges/center
// when they come within this many pixels (in 1080x1920 frame units).
const BANNER_SNAP_THRESHOLD = 28;

const BANNER_IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif'
]);
const BANNER_MEDIA_EXTS = new Set([
  ...BANNER_IMAGE_EXTS,
  '.gif', '.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.wmv', '.flv',
  '.mpg', '.mpeg', '.ts', '.m2ts', '.3gp', '.3gpp', '.ogv', '.vob', '.f4v',
  '.asf', '.divx', '.rm', '.rmvb'
]);

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function isImageBanner(filePath) {
  return BANNER_IMAGE_EXTS.has(path.extname(String(filePath || '')).toLowerCase());
}

function isSupportedBanner(filePath) {
  return BANNER_MEDIA_EXTS.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * Heuristic: does this ffprobe pixel format carry an alpha channel?
 * GIF palettes are intentionally excluded (their 1-bit transparency is rare
 * for banners and they loop fine as-is).
 */
function hasAlphaPixFmt(pixFmt) {
  return /yuva|bgra|rgba|argb|abgr|gbrap|ya8|ya16/.test(String(pixFmt || '').toLowerCase());
}

/**
 * Turn an ffprobe video stream into display dimensions. Phones record
 * portrait videos as landscape-coded frames with a rotation display matrix;
 * ffmpeg's decoder auto-applies that rotation, so the banner layout must use
 * the rotated (display) size or the picture gets stretched sideways.
 */
function resolveDisplayDimensions(stream) {
  let width = Number(stream && stream.width) || 0;
  let height = Number(stream && stream.height) || 0;
  let rotation = 0;
  const sideData = Array.isArray(stream && stream.side_data_list) ? stream.side_data_list : [];
  for (const entry of sideData) {
    if (entry && typeof entry.side_data_type === 'string' && entry.side_data_type.includes('Display Matrix') && Number.isFinite(Number(entry.rotation))) {
      rotation = Number(entry.rotation);
      break;
    }
  }
  if (!rotation && stream && stream.tags && Number.isFinite(Number(stream.tags.rotate))) {
    rotation = Number(stream.tags.rotate);
  }
  const normalized = ((Math.round(rotation) % 360) + 360) % 360;
  if (normalized === 90 || normalized === 270) {
    const swap = width;
    width = height;
    height = swap;
  }
  return { width, height };
}

/**
 * Compute the final banner layout in 1080x1920 canvas coordinates.
 * Width and height are independent (free stretch). When no explicit height
 * is given it is derived from the media aspect ratio. Height is rounded to
 * an even value (required for yuv420 encoding). The banner may be pushed
 * partially outside the frame, but at least BANNER_MIN_VISIBLE pixels always
 * stay inside the canvas.
 */
function computeBannerLayout(options = {}, mediaWidth, mediaHeight) {
  const width = Math.round(clampNumber(options.width, BANNER_MIN_SIZE, BANNER_MAX_WIDTH) || BANNER_DEFAULT_WIDTH);

  let height;
  if (options.height !== undefined && options.height !== null && Number.isFinite(Number(options.height))) {
    height = Math.round(clampNumber(options.height, BANNER_MIN_SIZE, BANNER_MAX_HEIGHT));
  } else {
    const mw = Number(mediaWidth);
    const mh = Number(mediaHeight);
    const aspect = (Number.isFinite(mw) && Number.isFinite(mh) && mw > 0 && mh > 0) ? mh / mw : 1;
    height = Math.round(width * aspect);
  }
  if (height % 2 !== 0) height += 1;
  height = Math.max(2, Math.min(height, BANNER_MAX_HEIGHT));

  const x = Math.round(clampNumber(options.x, -width + BANNER_MIN_VISIBLE, BANNER_CANVAS_WIDTH - BANNER_MIN_VISIBLE));
  const y = Math.round(clampNumber(options.y, -height + BANNER_MIN_VISIBLE, BANNER_CANVAS_HEIGHT - BANNER_MIN_VISIBLE));

  return { x, y, width, height };
}

/**
 * Snap one banner coordinate (left or top) to invisible alignment guides.
 * Guides exist at the canvas start edge, the canvas center and the canvas
 * end edge — the banner edge (start/center/end) sticks to the nearest guide
 * within the threshold. Works for both axes; pass the matching size
 * (width or height) and canvas extent (1080 or 1920).
 */
function snapBannerCoord(pos, size, canvas, threshold = BANNER_SNAP_THRESHOLD) {
  const p = Number(pos) || 0;
  const s = Math.max(1, Number(size) || 1);
  const c = Math.max(1, Number(canvas) || 1);
  if (Math.abs(p) <= threshold) return 0;
  if (Math.abs(p + s / 2 - c / 2) <= threshold) return c / 2 - s / 2;
  if (Math.abs(p + s - c) <= threshold) return c - s;
  return p;
}

/**
 * Build the ffmpeg filter strings that scale the banner input and overlay
 * it on top of the base label. Expects a layout produced by
 * computeBannerLayout. `opacity` is 0..1; below 1 the banner is faded with
 * colorchannelmixer. The banner input must be added to the command
 * separately (with `-stream_loop -1` for video banners).
 */
function buildBannerFilterStrings(inputIndex, layout, baseLabel = 'vsub', outLabel = 'vout', opacity = 1) {
  const op = Math.min(1, Math.max(0, Number.isFinite(Number(opacity)) ? Number(opacity) : 1));
  const scaleChain = op < 1
    ? `fps=30,scale=${layout.width}:${layout.height}:flags=lanczos,setsar=1,format=rgba,colorchannelmixer=aa=${Math.round(op * 1000) / 1000}`
    : `fps=30,scale=${layout.width}:${layout.height}:flags=lanczos,setsar=1`;
  return [
    `[${inputIndex}:v]${scaleChain}[ban]`,
    `[${baseLabel}][ban]overlay=${layout.x}:${layout.y}:eof_action=repeat[${outLabel}]`
  ];
}

const INTERSTITIAL_MAX_WINDOWS = 30;
const INTERSTITIAL_MIN_WINDOW_SEC = 0.5;
// The pause lasts exactly as long as the banner video itself; this is only
// a sanity guard against absurd files (1 hour).
const INTERSTITIAL_MAX_WINDOW_SEC = 3600;

/**
 * Plan the pause/play timeline for interstitial banners. Windows start at
 * `intervalSec`, `2 * intervalSec`, ... (never at t=0 — the first break
 * comes after a full interval of content). Each pause lasts exactly the
 * banner's own duration (`durationSec` — probed from the banner video);
 * pass null to use the raw value. Each entry keeps its timeline order so
 * video and audio segment graphs stay in sync.
 */
function planInterstitialSegments(chunkDuration, intervalSec, durationSec, maxWindows = INTERSTITIAL_MAX_WINDOWS) {
  const total = Math.max(0, Number(chunkDuration) || 0);
  const interval = Number(intervalSec) || 0;
  const windowDur = Math.min(
    Math.max(0.5, Number(durationSec) || 0),
    INTERSTITIAL_MAX_WINDOW_SEC
  );

  const segments = [];
  if (!(total > 0) || !(interval > 0)) return { segments: [], totalWindowSec: 0 };

  // Windows are scheduled on the CONTENT timeline (after every full interval
  // of playback). A pause freezes the content at its current frame — so the
  // content resumes from the same point the next window freezes at, and the
  // OUTPUT timeline grows by the accumulated pause time.
  let prevContent = 0;
  let windowCount = 0;
  for (let start = interval; start < total - INTERSTITIAL_MIN_WINDOW_SEC && windowCount < maxWindows; start += interval) {
    const winDur = Math.min(windowDur, total - start);
    if (winDur < INTERSTITIAL_MIN_WINDOW_SEC) break;
    if (start - prevContent > INTERSTITIAL_MIN_WINDOW_SEC) {
      segments.push({ type: 'play', start: round2(prevContent), end: round2(start) });
    }
    segments.push({ type: 'window', start: round2(start), duration: round2(winDur) });
    prevContent = start;
    windowCount += 1;
  }
  if (windowCount === 0) {
    return { segments: [], totalWindowSec: 0 };
  }
  if (total - prevContent > INTERSTITIAL_MIN_WINDOW_SEC) {
    segments.push({ type: 'play', start: round2(prevContent), end: round2(total) });
  }

  const totalWindowSec = round2(segments
    .filter((s) => s.type === 'window')
    .reduce((sum, s) => sum + s.duration, 0));

  return { segments, totalWindowSec };
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * Build the ffmpeg filter graph that pauses the main video (frozen frame +
 * silence) inside every interstitial window while the banner video plays
 * over it with its own audio. Subtitle burning happens downstream on the
 * produced [ivout] label. Returns the video filter strings ending in
 * `[ivout]` and the audio strings ending in `[iall]`.
 *
 * The caller must feed ONE banner input per window (index bannerIndexBase +
 * windowIdx) — a dedicated demuxer per window is immune to the filter
 * reinitialization that a -stream_loop background triggers, unlike split
 * branches off a single banner input. The base video and the main audio are
 * forked explicitly with split/asplit (a filtergraph output pad may be
 * linked exactly once).
 */
function buildInterstitialFilterGraph({ baseLabel = 'vconcat', bannerIndexBase, audioInputIndex, bannerHasAudio = false, layout, opacity = 1, segments, fps = 30 }) {
  const op = Math.min(1, Math.max(0, Number.isFinite(Number(opacity)) ? Number(opacity) : 1));
  const bannerChain = op < 1
    ? `fps=${fps},scale=${layout.width}:${layout.height}:flags=lanczos,setsar=1,format=rgba,colorchannelmixer=aa=${Math.round(op * 1000) / 1000}`
    : `fps=${fps},scale=${layout.width}:${layout.height}:flags=lanczos,setsar=1`;
  const audioFormat = 'aformat=sample_rates=44100:channel_layouts=stereo';
  const filters = [];
  const videoLabels = [];
  const audioLabels = [];

  const playSegments = segments.map((seg, i) => ({ seg, i })).filter((x) => x.seg.type === 'play');

  // Fork the base video once per segment.
  if (segments.length > 1) {
    filters.push(`[${baseLabel}]split=${segments.length}${segments.map((_, i) => `[vbr${i}]`).join('')}`);
  }
  // Fork the main audio once per play segment.
  if (playSegments.length > 1) {
    filters.push(`[${audioInputIndex}:a]asplit=${playSegments.length}${playSegments.map((_, k) => `[mabr${k}]`).join('')}`);
  }

  let playIdx = 0;
  let winIdx = 0;
  segments.forEach((seg, i) => {
    const vsrc = segments.length > 1 ? `[vbr${i}]` : `[${baseLabel}]`;

    if (seg.type === 'play') {
      const asrc = playSegments.length > 1 ? `[mabr${playIdx}]` : `[${audioInputIndex}:a]`;
      playIdx += 1;
      filters.push(`${vsrc}trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[iseg${i}]`);
      filters.push(`${asrc}atrim=start=${seg.start}:end=${seg.end},asetpts=N/SR/TB,${audioFormat}[isega${i}]`);
      videoLabels.push(`[iseg${i}]`);
      audioLabels.push(`[isega${i}]`);
      return;
    }

    const dur = seg.duration;
    const bannerInput = bannerIndexBase + winIdx;
    winIdx += 1;
    // Frozen frame of the main video: one frame cloned for the window.
    filters.push(`${vsrc}trim=start=${seg.start}:duration=${(1 / fps).toFixed(4)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${dur},trim=end=${dur},setpts=PTS-STARTPTS[ifr${i}]`);
    // Banner video plays from its start (fresh demuxer per window); padded if shorter.
    filters.push(`[${bannerInput}:v]${bannerChain},tpad=stop_mode=clone:stop_duration=${dur},trim=end=${dur},setpts=PTS-STARTPTS[ibn${i}]`);
    filters.push(`[ifr${i}][ibn${i}]overlay=${layout.x}:${layout.y}:eof_action=pass,trim=end=${dur},setpts=PTS-STARTPTS[iseg${i}]`);
    // Main audio is muted during the window; the banner's own audio plays.
    if (bannerHasAudio) {
      filters.push(`[${bannerInput}:a]atrim=end=${dur},asetpts=N/SR/TB,apad=whole_dur=${dur},${audioFormat}[isega${i}]`);
    } else {
      filters.push(`anullsrc=r=44100:cl=stereo,atrim=end=${dur},asetpts=N/SR/TB[isega${i}]`);
    }
    videoLabels.push(`[iseg${i}]`);
    audioLabels.push(`[isega${i}]`);
  });

  if (videoLabels.length) {
    filters.push(`${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[ivout]`);
    filters.push(`${audioLabels.join('')}concat=n=${audioLabels.length}:v=0:a=1[iall]`);
  }

  return { filters, videoLabel: 'ivout', audioLabel: 'iall' };
}

module.exports = {
  BANNER_CANVAS_WIDTH,
  BANNER_CANVAS_HEIGHT,
  BANNER_MIN_SIZE,
  BANNER_MAX_WIDTH,
  BANNER_MAX_HEIGHT,
  BANNER_DEFAULT_WIDTH,
  BANNER_MIN_VISIBLE,
  BANNER_SNAP_THRESHOLD,
  INTERSTITIAL_MAX_WINDOWS,
  clampNumber,
  isImageBanner,
  isSupportedBanner,
  hasAlphaPixFmt,
  resolveDisplayDimensions,
  computeBannerLayout,
  snapBannerCoord,
  buildBannerFilterStrings,
  planInterstitialSegments,
  buildInterstitialFilterGraph
};
