const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../app/services/cinema-bg-utils');

const HALF = { x: 0, y: 0, width: 1080, height: 960 };
const HALF_BOTTOM = { x: 0, y: 960, width: 1080, height: 960 };

// ---------- normalize helpers ----------

test('normalizeCinemaBgCanvasFill whitelists values', () => {
  assert.equal(normalizeCinemaBgCanvasFill('blurMovie'), 'blurMovie');
  assert.equal(normalizeCinemaBgCanvasFill('blurBg'), 'blurBg');
  assert.equal(normalizeCinemaBgCanvasFill('black'), 'black');
  assert.equal(normalizeCinemaBgCanvasFill('nonsense'), 'black');
  assert.equal(normalizeCinemaBgCanvasFill(undefined), 'black');
});

test('normalizeCinemaBgLayerOrder whitelists values', () => {
  assert.equal(normalizeCinemaBgLayerOrder('bgTop'), 'bgTop');
  assert.equal(normalizeCinemaBgLayerOrder('movieTop'), 'movieTop');
  assert.equal(normalizeCinemaBgLayerOrder('nope'), 'movieTop');
  assert.equal(normalizeCinemaBgLayerOrder(null), 'movieTop');
});

// ---------- layout clamps ----------

test('computeCinemaClipLayout defaults to the top half', () => {
  assert.deepEqual(computeCinemaClipLayout({}), HALF);
  assert.deepEqual(computeCinemaClipLayout(), HALF);
});

test('computeCinemaBgRectLayout defaults to the bottom half', () => {
  assert.deepEqual(computeCinemaBgRectLayout({}), HALF_BOTTOM);
});

test('computeCinemaRectLayout keeps a valid rectangle untouched', () => {
  const rect = { x: 12, y: 345, width: 400, height: 200 };
  assert.deepEqual(computeCinemaRectLayout(rect, HALF), rect);
});

test('computeCinemaRectLayout clamps size to the banner bounds and even height', () => {
  const out = computeCinemaRectLayout({ x: 0, y: 0, width: 9999, height: 961 }, HALF);
  assert.equal(out.width, 2160);
  assert.equal(out.height, 962); // rounded up to even
});

test('computeCinemaRectLayout enforces min size and min visibility', () => {
  const out = computeCinemaRectLayout({ x: 5000, y: -5000, width: 1, height: 1 }, HALF);
  assert.equal(out.width, 20);   // BANNER_MIN_SIZE
  assert.equal(out.height, 20);
  assert.equal(out.x, 1070);     // 1080 - BANNER_MIN_VISIBLE
  assert.equal(out.y, -10);      // -height + BANNER_MIN_VISIBLE
});

test('computeCinemaRectLayout falls back per-rectangle on partial input', () => {
  const out = computeCinemaRectLayout({ width: 500 }, HALF_BOTTOM);
  assert.deepEqual(out, { x: 0, y: 960, width: 500, height: 960 });
});

test('computeCinemaClipLayout / computeCinemaBgRectLayout read flat settings keys', () => {
  assert.deepEqual(
    computeCinemaClipLayout({ cinemaClipX: 5, cinemaClipY: 6, cinemaClipWidth: 700, cinemaClipHeight: 480 }),
    { x: 5, y: 6, width: 700, height: 480 }
  );
  assert.deepEqual(
    computeCinemaBgRectLayout({ cinemaBgX: 7, cinemaBgY: 8, cinemaBgWidth: 700, cinemaBgHeight: 481 }),
    { x: 7, y: 8, width: 700, height: 482 }
  );
});

// ---------- filter graph ----------

test('graph: black canvas + crop fill + single bg + movieTop', () => {
  const { filters, baseLabel } = buildCinemaBgFilterGraph({
    fillMode: 'crop',
    canvasFill: 'black',
    layerOrder: 'movieTop',
    clipLayout: HALF,
    bgLayout: HALF_BOTTOM,
    bgCount: 1,
    bgIndexBase: 2,
    durationSec: 45
  });
  assert.equal(baseLabel, 'mvbase');
  const joined = filters.join('\n');
  // Single bg: no concat, rect drawn from the single chain label.
  assert.ok(!joined.includes('concat'));
  assert.ok(joined.includes('[2:v]setpts=PTS-STARTPTS,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1,fps=30,format=yuv420p[cbgv0]'));
  // Black canvas slightly longer than the scene.
  assert.ok(joined.includes('color=c=black:s=1080x1920:r=30:d=46.00,format=yuv420p[ccanvas]'));
  // Movie into its rectangle, single branch (no split needed).
  assert.ok(joined.includes('[0:v]setpts=PTS-STARTPTS,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1,fps=30,format=yuv420p[cmovi]'));
  // movieTop: ADHD first, movie on top, final overlay produces [mvbase].
  assert.ok(joined.includes('[ccanvas][cbgv0]overlay=0:960:eof_action=repeat[cbgplaced]'));
  assert.ok(joined.includes('[cbgplaced][cmovi]overlay=0:0:eof_action=repeat,format=yuv420p[mvbase]'));
});

test('graph: multiple bg clips chain through concat', () => {
  const { filters } = buildCinemaBgFilterGraph({
    fillMode: 'crop',
    canvasFill: 'black',
    layerOrder: 'movieTop',
    clipLayout: HALF,
    bgLayout: HALF_BOTTOM,
    bgCount: 3,
    bgIndexBase: 2
  });
  const joined = filters.join('\n');
  assert.ok(joined.includes('[2:v]'));
  assert.ok(joined.includes('[3:v]'));
  assert.ok(joined.includes('[4:v]'));
  assert.ok(joined.includes('[cbgv0][cbgv1][cbgv2]concat=n=3:v=1:a=0[cbgcat]'));
  assert.ok(joined.includes('[ccanvas][cbgcat]overlay=0:960:eof_action=repeat[cbgplaced]'));
});

test('graph: blur fill splits the movie source in two', () => {
  const { filters } = buildCinemaBgFilterGraph({
    fillMode: 'blur',
    canvasFill: 'black',
    layerOrder: 'movieTop',
    clipLayout: HALF,
    bgLayout: HALF_BOTTOM,
    bgCount: 1,
    bgIndexBase: 2
  });
  const joined = filters.join('\n');
  assert.ok(joined.includes('[0:v]setpts=PTS-STARTPTS,split=2[cmv0][cmv1]'));
  // Rect-sized blurred backdrop + decrease-fitted layer centered in the rect.
  assert.ok(joined.includes('[cmv0]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,gblur=sigma=30,eq=brightness=-0.06[cmvbgb]'));
  assert.ok(joined.includes('[cmv1]scale=1080:960:force_original_aspect_ratio=decrease[cmvfgs]'));
  assert.ok(joined.includes('[cmvbgb][cmvfgs]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[cmovi]'));
});

test('graph: blurMovie canvas adds a third movie branch', () => {
  const { filters } = buildCinemaBgFilterGraph({
    fillMode: 'blur',
    canvasFill: 'blurMovie',
    layerOrder: 'movieTop',
    clipLayout: HALF,
    bgLayout: HALF_BOTTOM,
    bgCount: 1,
    bgIndexBase: 2
  });
  const joined = filters.join('\n');
  assert.ok(joined.includes('split=3[cmv0][cmv1][cmv2]'));
  // First branch feeds the fullscreen blurred canvas.
  assert.ok(joined.includes('[cmv0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=30,eq=brightness=-0.06,fps=30,format=yuv420p[ccanvas]'));
  assert.ok(joined.includes('[cmv2]scale=1080:960:force_original_aspect_ratio=decrease[cmvfgs]'));
  // No color source needed.
  assert.ok(!joined.includes('color=c=black'));
});

test('graph: blurBg canvas splits the bg concat chain', () => {
  const { filters } = buildCinemaBgFilterGraph({
    fillMode: 'crop',
    canvasFill: 'blurBg',
    layerOrder: 'movieTop',
    clipLayout: HALF,
    bgLayout: HALF_BOTTOM,
    bgCount: 2,
    bgIndexBase: 2
  });
  const joined = filters.join('\n');
  assert.ok(joined.includes('[cbgcat]split=2[cbgrect][cbgfull]'));
  assert.ok(joined.includes('[cbgfull]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=30,eq=brightness=-0.06,fps=30,format=yuv420p[ccanvas]'));
  // The rectangle overlay must consume the rect branch, not the raw label.
  assert.ok(joined.includes('[ccanvas][cbgrect]overlay=0:960:eof_action=repeat[cbgplaced]'));
  // With a single movie consumer there is no movie split.
  assert.ok(!joined.includes('split=2[cmv'));
  assert.ok(!joined.includes('split=3'));
});

test('graph: bgTop draws the ADHD rectangle last', () => {
  const { filters } = buildCinemaBgFilterGraph({
    fillMode: 'crop',
    canvasFill: 'black',
    layerOrder: 'bgTop',
    clipLayout: HALF,
    bgLayout: HALF_BOTTOM,
    bgCount: 1,
    bgIndexBase: 2
  });
  const joined = filters.join('\n');
  assert.ok(joined.includes('[ccanvas][cmovi]overlay=0:0:eof_action=repeat[cmovieplaced]'));
  assert.ok(joined.includes('[cmovieplaced][cbgv0]overlay=0:960:eof_action=repeat,format=yuv420p[mvbase]'));
  assert.ok(!joined.includes('cbgplaced'));
});

test('graph: every pad label is produced exactly once and ends at mvbase', () => {
  for (const canvasFill of CINEMA_BG_CANVAS_FILL_MODES) {
    for (const layerOrder of CINEMA_BG_LAYER_ORDERS) {
      for (const fillMode of ['crop', 'blur']) {
        const { filters, baseLabel } = buildCinemaBgFilterGraph({
          fillMode,
          canvasFill,
          layerOrder,
          clipLayout: HALF,
          bgLayout: HALF_BOTTOM,
          bgCount: 2,
          bgIndexBase: 2,
          durationSec: 30
        });
        assert.equal(baseLabel, 'mvbase');
        const produced = new Map();
        filters.forEach((f) => {
          const m = f.match(/\[([a-z0-9_]+)\]$/);
          assert.ok(m, `missing output pad: ${f}`);
          const label = m[1];
          assert.ok(!produced.has(label), `duplicate pad label ${label} (${canvasFill}/${layerOrder}/${fillMode})`);
          produced.set(label, f);
        });
        assert.equal(filters[filters.length - 1], filters[filters.length - 1].replace(/\[mvbase\]$/, '[mvbase]'));
        assert.ok(produced.has('mvbase'));
        assert.ok(produced.has('ccanvas'));
        assert.ok(produced.has('cmovi'));
      }
    }
  }
});

test('graph: non-finite inputs fall back to safe defaults', () => {
  const { filters } = buildCinemaBgFilterGraph({
    fillMode: 'weird',
    canvasFill: 'weird',
    layerOrder: 'weird',
    clipLayout: { x: NaN, y: NaN, width: NaN, height: NaN },
    bgLayout: null,
    bgCount: 'x',
    bgIndexBase: '2',
    movieIndex: null,
    durationSec: undefined
  });
  const joined = filters.join('\n');
  // Defaults: top/bottom halves, black canvas, movieTop, one bg input.
  assert.ok(joined.includes('[0:v]setpts=PTS-STARTPTS,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1,fps=30,format=yuv420p[cmovi]'));
  assert.ok(joined.includes('color=c=black:s=1080x1920:r=30:d=11.00,format=yuv420p[ccanvas]'));
  assert.ok(joined.includes('[ccanvas][cbgv0]overlay=0:960:eof_action=repeat[cbgplaced]'));
});

test('module exports the whitelists and default layouts', () => {
  assert.deepEqual(CINEMA_BG_CANVAS_FILL_MODES, ['black', 'blurMovie', 'blurBg']);
  assert.deepEqual(CINEMA_BG_LAYER_ORDERS, ['movieTop', 'bgTop']);
  assert.deepEqual(DEFAULT_CINEMA_CLIP_LAYOUT, HALF);
  assert.deepEqual(DEFAULT_CINEMA_BG_LAYOUT, HALF_BOTTOM);
});
