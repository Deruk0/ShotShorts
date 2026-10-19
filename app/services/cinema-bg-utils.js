const { computeBannerLayout } = require('./banner-utils');

// Parallel ADHD layer for cinema mode: the movie excerpt and ADHD folder
// clips play in two independently positioned rectangles on one 1080x1920
// canvas. This module holds the pure layout/filter helpers so they stay
// unit-testable without ffmpeg (mirrors banner-utils.js).

const CINEMA_BG_CANVAS_FILL_MODES = ['black', 'blurMovie', 'blurBg'];
const CINEMA_BG_LAYER_ORDERS = ['movieTop', 'bgTop'];

// Default split: movie on the top half, ADHD clip on the bottom half. Both
// rectangles snap to the canvas center guide at 960px.
const DEFAULT_CINEMA_CLIP_LAYOUT = Object.freeze({ x: 0, y: 0, width: 1080, height: 960 });
const DEFAULT_CINEMA_BG_LAYOUT = Object.freeze({ x: 0, y: 960, width: 1080, height: 960 });

function normalizeCinemaBgCanvasFill(value) {
  return CINEMA_BG_CANVAS_FILL_MODES.includes(value) ? value : 'black';
}

function normalizeCinemaBgLayerOrder(value) {
  return CINEMA_BG_LAYER_ORDERS.includes(value) ? value : 'movieTop';
}

/**
 * Clamp one rectangle (x/y/width/height in 1080x1920 canvas units) through
 * computeBannerLayout semantics: min 20px sides, max 2x canvas, at least
 * 10px visible inside the frame, even height. Missing values fall back to
 * the rectangle-specific default instead of the banner defaults.
 */
function computeCinemaRectLayout(raw, fallback = DEFAULT_CINEMA_CLIP_LAYOUT) {
  const rect = raw || {};
  const num = (value, fb) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fb;
  };
  return computeBannerLayout({
    x: num(rect.x, fallback.x),
    y: num(rect.y, fallback.y),
    width: num(rect.width, fallback.width),
    height: num(rect.height, fallback.height)
  });
}

/** Movie-excerpt rectangle from the flat cinema settings keys. */
function computeCinemaClipLayout(config = {}) {
  return computeCinemaRectLayout({
    x: config.cinemaClipX,
    y: config.cinemaClipY,
    width: config.cinemaClipWidth,
    height: config.cinemaClipHeight
  }, DEFAULT_CINEMA_CLIP_LAYOUT);
}

/** ADHD-clip rectangle from the flat cinema settings keys. */
function computeCinemaBgRectLayout(config = {}) {
  return computeCinemaRectLayout({
    x: config.cinemaBgX,
    y: config.cinemaBgY,
    width: config.cinemaBgWidth,
    height: config.cinemaBgHeight
  }, DEFAULT_CINEMA_BG_LAYOUT);
}

/**
 * Build the ffmpeg filter strings for the parallel-ADHD composite:
 *   canvas base (black / blurred movie / blurred ADHD)
 *   → ADHD folder clips crop-filled into their rectangle (chained via concat)
 *   → movie excerpt crop- or blur-filled into its own rectangle
 * The graph ends at [mvbase]; subtitles and the banner overlay are applied
 * downstream by the caller. Input order (set by the caller):
 *   movieIndex (0), segment audio (1), bgIndexBase..+bgCount-1, then the
 *   subtitle video and the banner. ADHD clips are never mapped to audio.
 *
 * Returns { filters: string[], baseLabel: 'mvbase' }.
 */
function buildCinemaBgFilterGraph({
  fillMode = 'crop',
  canvasFill = 'black',
  layerOrder = 'movieTop',
  clipLayout,
  bgLayout,
  bgCount = 1,
  bgIndexBase = 2,
  movieIndex = 0,
  durationSec = 10
} = {}) {
  const fill = fillMode === 'blur' ? 'blur' : 'crop';
  const canvas = normalizeCinemaBgCanvasFill(canvasFill);
  const order = normalizeCinemaBgLayerOrder(layerOrder);
  const clip = computeCinemaRectLayout(clipLayout, DEFAULT_CINEMA_CLIP_LAYOUT);
  const bg = computeCinemaRectLayout(bgLayout, DEFAULT_CINEMA_BG_LAYOUT);
  const nBg = Math.max(1, Math.round(Number(bgCount) || 1));
  const duration = Math.max(0.1, Number(durationSec) || 10);
  const movieSrc = `[${Math.max(0, Math.round(Number(movieIndex) || 0))}:v]`;

  const filters = [];

  // --- ADHD folder clips → crop-filled into the ADHD rectangle -----------
  const bgPads = [];
  for (let i = 0; i < nBg; i++) {
    const inputIndex = bgIndexBase + i;
    filters.push(`[${inputIndex}:v]setpts=PTS-STARTPTS,scale=${bg.width}:${bg.height}:force_original_aspect_ratio=increase,crop=${bg.width}:${bg.height},setsar=1,fps=30,format=yuv420p[cbgv${i}]`);
    bgPads.push(`[cbgv${i}]`);
  }
  let bgCat = 'cbgv0';
  if (nBg > 1) {
    filters.push(`${bgPads.join('')}concat=n=${nBg}:v=1:a=0[cbgcat]`);
    bgCat = 'cbgcat';
  }

  // The blurred-ADHD canvas branches off the same chain the rectangle uses.
  let bgRect = bgCat;
  if (canvas === 'blurBg') {
    filters.push(`[${bgCat}]split=2[cbgrect][cbgfull]`);
    bgRect = 'cbgrect';
  }

  // --- Movie source fan-out ------------------------------------------------
  // Branches: movie rectangle takes 1 (crop) or 2 (blur fill); the blurred
  // movie canvas takes one more. ffmpeg pads may be linked exactly once,
  // so every extra consumer needs its own split branch.
  const movieBranches = (fill === 'blur' ? 2 : 1) + (canvas === 'blurMovie' ? 1 : 0);
  let nextBranch = 0;
  if (movieBranches > 1) {
    const pads = [];
    for (let i = 0; i < movieBranches; i++) pads.push(`[cmv${i}]`);
    filters.push(`${movieSrc}setpts=PTS-STARTPTS,split=${movieBranches}${pads.join('')}`);
  }
  // Single consumer chains the source directly (trailing comma keeps the
  // following filter valid); split branches are referenced by pad label.
  const takeMovie = () => (movieBranches > 1 ? `[cmv${nextBranch++}]` : `${movieSrc}setpts=PTS-STARTPTS,`);

  // --- Canvas base ----------------------------------------------------------
  if (canvas === 'blurMovie') {
    filters.push(`${takeMovie()}scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=30,eq=brightness=-0.06,fps=30,format=yuv420p[ccanvas]`);
  } else if (canvas === 'blurBg') {
    filters.push(`[cbgfull]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=30,eq=brightness=-0.06,fps=30,format=yuv420p[ccanvas]`);
  } else {
    // Slightly longer than the scene so -t/-shortest always cut the output.
    filters.push(`color=c=black:s=1080x1920:r=30:d=${(duration + 1).toFixed(2)},format=yuv420p[ccanvas]`);
  }

  // --- Movie excerpt into its own rectangle --------------------------------
  // fillMode applies INSIDE the rectangle: crop fills it, blur fits the
  // movie over a blurred backdrop of the same rectangle.
  if (fill === 'blur') {
    filters.push(`${takeMovie()}scale=${clip.width}:${clip.height}:force_original_aspect_ratio=increase,crop=${clip.width}:${clip.height},gblur=sigma=30,eq=brightness=-0.06[cmvbgb]`);
    filters.push(`${takeMovie()}scale=${clip.width}:${clip.height}:force_original_aspect_ratio=decrease[cmvfgs]`);
    filters.push(`[cmvbgb][cmvfgs]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[cmovi]`);
  } else {
    filters.push(`${takeMovie()}scale=${clip.width}:${clip.height}:force_original_aspect_ratio=increase,crop=${clip.width}:${clip.height},setsar=1,fps=30,format=yuv420p[cmovi]`);
  }

  // --- Compose the two rectangles -------------------------------------------
  if (order === 'bgTop') {
    filters.push(`[ccanvas][cmovi]overlay=${clip.x}:${clip.y}:eof_action=repeat[cmovieplaced]`);
    filters.push(`[cmovieplaced][${bgRect}]overlay=${bg.x}:${bg.y}:eof_action=repeat,format=yuv420p[mvbase]`);
  } else {
    filters.push(`[ccanvas][${bgRect}]overlay=${bg.x}:${bg.y}:eof_action=repeat[cbgplaced]`);
    filters.push(`[cbgplaced][cmovi]overlay=${clip.x}:${clip.y}:eof_action=repeat,format=yuv420p[mvbase]`);
  }

  return { filters, baseLabel: 'mvbase' };
}

module.exports = {
  CINEMA_BG_CANVAS_FILL_MODES,
  CINEMA_BG_LAYER_ORDERS,
  DEFAULT_CINEMA_CLIP_LAYOUT,
  DEFAULT_CINEMA_BG_LAYOUT,
  normalizeCinemaBgCanvasFill,
  normalizeCinemaBgLayerOrder,
  computeCinemaRectLayout,
  computeCinemaClipLayout,
  computeCinemaBgRectLayout,
  buildCinemaBgFilterGraph
};
