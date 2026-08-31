const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BANNER_CANVAS_WIDTH,
  BANNER_CANVAS_HEIGHT,
  BANNER_MIN_SIZE,
  BANNER_MAX_WIDTH,
  BANNER_MAX_HEIGHT,
  BANNER_MIN_VISIBLE,
  BANNER_SNAP_THRESHOLD,
  isImageBanner,
  isSupportedBanner,
  hasAlphaPixFmt,
  resolveDisplayDimensions,
  computeBannerLayout,
  snapBannerCoord,
  buildBannerFilterStrings
} = require('../app/services/banner-utils');

test('isImageBanner detects still images only', () => {
  assert.equal(isImageBanner('C:\\banners\\ad.png'), true);
  assert.equal(isImageBanner('ad.JPG'), true);
  assert.equal(isImageBanner('ad.webp'), true);
  assert.equal(isImageBanner('ad.gif'), false);
  assert.equal(isImageBanner('ad.mp4'), false);
  assert.equal(isImageBanner(''), false);
});

test('isSupportedBanner accepts images and videos', () => {
  assert.equal(isSupportedBanner('ad.png'), true);
  assert.equal(isSupportedBanner('ad.gif'), true);
  assert.equal(isSupportedBanner('ad.mp4'), true);
  assert.equal(isSupportedBanner('ad.MOV'), true);
  assert.equal(isSupportedBanner('ad.webm'), true);
  assert.equal(isSupportedBanner('ad.wmv'), true);
  assert.equal(isSupportedBanner('ad.flv'), true);
  assert.equal(isSupportedBanner('ad.ts'), true);
  assert.equal(isSupportedBanner('ad.3gp'), true);
  assert.equal(isSupportedBanner('ad.txt'), false);
  assert.equal(isSupportedBanner(null), false);
});

test('hasAlphaPixFmt detects alpha-capable pixel formats', () => {
  assert.equal(hasAlphaPixFmt('yuva420p'), true);
  assert.equal(hasAlphaPixFmt('YUVA444P10LE'), true);
  assert.equal(hasAlphaPixFmt('bgra'), true);
  assert.equal(hasAlphaPixFmt('gbrap12le'), true);
  assert.equal(hasAlphaPixFmt('yuv420p'), false);
  assert.equal(hasAlphaPixFmt('pal8'), false); // gif palette — treated as opaque
  assert.equal(hasAlphaPixFmt(''), false);
});

test('resolveDisplayDimensions keeps plain streams as-is', () => {
  assert.deepEqual(resolveDisplayDimensions({ width: 800, height: 400 }), { width: 800, height: 400 });
});

test('resolveDisplayDimensions swaps for 90/270 display matrix rotation', () => {
  const stream = {
    width: 1920,
    height: 1080,
    side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }]
  };
  assert.deepEqual(resolveDisplayDimensions(stream), { width: 1080, height: 1920 });

  const stream270 = {
    width: 1920,
    height: 1080,
    side_data_list: [{ side_data_type: 'Display Matrix', rotation: 270 }]
  };
  assert.deepEqual(resolveDisplayDimensions(stream270), { width: 1080, height: 1920 });
});

test('resolveDisplayDimensions does not swap for 0/180 rotation', () => {
  const stream = {
    width: 1920,
    height: 1080,
    side_data_list: [{ side_data_type: 'Display Matrix', rotation: 180 }]
  };
  assert.deepEqual(resolveDisplayDimensions(stream), { width: 1920, height: 1080 });
});

test('resolveDisplayDimensions honors legacy rotate tag', () => {
  const stream = { width: 1280, height: 720, tags: { rotate: '90' } };
  assert.deepEqual(resolveDisplayDimensions(stream), { width: 720, height: 1280 });
});

test('computeBannerLayout uses explicit height when provided (free stretch)', () => {
  const layout = computeBannerLayout({ x: 0, y: 0, width: 300, height: 500 }, 1920, 1080);
  assert.equal(layout.width, 300);
  assert.equal(layout.height, 500);
});

test('computeBannerLayout derives even height from aspect ratio when height is missing', () => {
  const layout = computeBannerLayout({ x: 0, y: 0, width: 300 }, 1920, 1080);
  assert.equal(layout.width, 300);
  // 300 * 1080/1920 = 168.75 -> 169 -> rounded up to even 170
  assert.equal(layout.height, 170);
});

test('computeBannerLayout rounds odd explicit height to even', () => {
  const layout = computeBannerLayout({ x: 0, y: 0, width: 100, height: 101 }, 100, 100);
  assert.equal(layout.height % 2, 0);
});

test('computeBannerLayout allows pushing the banner partially outside the frame', () => {
  const layout = computeBannerLayout({ x: -200, y: 1800, width: 300, height: 300 }, 300, 300);
  assert.equal(layout.x, -200); // hangs off the left edge
  assert.equal(layout.y, 1800); // hangs off the bottom edge (1800 + 300 > 1920)

  // A moderate overflow inside the allowed range is kept untouched
  const moderate = computeBannerLayout({ x: -250, y: 0, width: 300, height: 300 }, 300, 300);
  assert.equal(moderate.x, -250);
});

test('computeBannerLayout keeps at least a visible strip inside the frame', () => {
  const layout = computeBannerLayout({ x: -99999, y: 99999, width: 300, height: 300 }, 300, 300);
  assert.equal(layout.x, -300 + BANNER_MIN_VISIBLE);
  assert.equal(layout.y, BANNER_CANVAS_HEIGHT - BANNER_MIN_VISIBLE);

  const far = computeBannerLayout({ x: 99999, y: -99999, width: 300, height: 300 }, 300, 300);
  assert.equal(far.x, BANNER_CANVAS_WIDTH - BANNER_MIN_VISIBLE);
  assert.equal(far.y, -300 + BANNER_MIN_VISIBLE);
});

test('computeBannerLayout clamps width and height to the allowed range', () => {
  const small = computeBannerLayout({ x: 0, y: 0, width: 1, height: 1 }, 100, 100);
  assert.equal(small.width, BANNER_MIN_SIZE);
  assert.equal(small.height, BANNER_MIN_SIZE);

  const big = computeBannerLayout({ x: 0, y: 0, width: 99999, height: 99999 }, 100, 100);
  assert.equal(big.width, BANNER_MAX_WIDTH);
  assert.equal(big.height, BANNER_MAX_HEIGHT);
});

test('computeBannerLayout falls back to square aspect on bad media dimensions', () => {
  const layout = computeBannerLayout({ x: 10, y: 20, width: 200 }, 0, 0);
  assert.equal(layout.width, 200);
  assert.equal(layout.height, 200);
  assert.equal(layout.x, 10);
  assert.equal(layout.y, 20);
});

test('buildBannerFilterStrings produces scale and overlay filters', () => {
  const layout = computeBannerLayout({ x: 740, y: 60, width: 300, height: 150 }, 300, 150);
  const filters = buildBannerFilterStrings(3, layout, 'vsub', 'vout');
  assert.equal(filters.length, 2);
  assert.equal(filters[0], `[3:v]fps=30,scale=${layout.width}:${layout.height}:flags=lanczos,setsar=1[ban]`);
  assert.equal(filters[1], `[vsub][ban]overlay=${layout.x}:${layout.y}:eof_action=repeat[vout]`);
});

test('buildBannerFilterStrings supports negative overlay positions', () => {
  const layout = { x: -100, y: 50, width: 400, height: 200 };
  const filters = buildBannerFilterStrings(2, layout);
  assert.equal(filters[0], '[2:v]fps=30,scale=400:200:flags=lanczos,setsar=1[ban]');
  assert.equal(filters[1], '[vsub][ban]overlay=-100:50:eof_action=repeat[vout]');
});

test('buildBannerFilterStrings fades the banner when opacity < 1', () => {
  const layout = { x: 10, y: 20, width: 300, height: 150 };
  const filters = buildBannerFilterStrings(3, layout, 'vsub', 'vout', 0.5);
  assert.equal(filters[0], '[3:v]fps=30,scale=300:150:flags=lanczos,setsar=1,format=rgba,colorchannelmixer=aa=0.5[ban]');
  assert.equal(filters[1], '[vsub][ban]overlay=10:20:eof_action=repeat[vout]');
});

test('buildBannerFilterStrings keeps plain chain at full opacity', () => {
  const layout = { x: 10, y: 20, width: 300, height: 150 };
  assert.ok(!buildBannerFilterStrings(3, layout, 'vsub', 'vout', 1)[0].includes('colorchannelmixer'));
  assert.ok(!buildBannerFilterStrings(3, layout, 'vsub', 'vout', undefined)[0].includes('colorchannelmixer'));
});

test('snapBannerCoord sticks to canvas edges and center', () => {
  // Left edge snap (within threshold)
  assert.equal(snapBannerCoord(15, 300, 1080), 0);
  // Center snap: banner center to canvas center
  assert.equal(snapBannerCoord(380, 300, 1080), 1080 / 2 - 300 / 2);
  // Right edge snap: banner right edge to canvas right edge
  assert.equal(snapBannerCoord(790, 300, 1080), 1080 - 300);
  // Vertical axis works the same way (center of 1920 is 960)
  assert.equal(snapBannerCoord(815, 300, 1920), 1920 / 2 - 300 / 2);
});

test('snapBannerCoord leaves free positions untouched', () => {
  assert.equal(snapBannerCoord(200, 300, 1080), 200);
  assert.equal(snapBannerCoord(-500, 300, 1080), -500);
});

test('snapBannerCoord threshold is symmetric and bounded', () => {
  assert.equal(snapBannerCoord(BANNER_SNAP_THRESHOLD, 300, 1080), 0);
  assert.equal(snapBannerCoord(BANNER_SNAP_THRESHOLD + 1, 300, 1080), BANNER_SNAP_THRESHOLD + 1);
});
