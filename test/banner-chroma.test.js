const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BANNER_CHROMA_FILTER, buildBannerFilterStrings, buildInterstitialFilterGraph } = require('../app/services/banner-utils');
const layout = { x: 0, y: 0, width: 32, height: 32 };

test('green key is opt-in and precedes scaling and opacity', () => {
  assert.ok(!buildBannerFilterStrings(1, layout).join(';').includes('colorkey'));
  const keyed = buildBannerFilterStrings(1, layout, 'base', 'out', 0.5, true).join(';');
  assert.ok(keyed.indexOf(BANNER_CHROMA_FILTER) < keyed.indexOf('scale='));
  assert.ok(keyed.indexOf('colorkey=') < keyed.indexOf('colorchannelmixer=aa=0.5'));
});

test('pause windows receive the same key filter', () => {
  const options = { bannerIndexBase: 1, audioInputIndex: 2, layout,
    segments: [{ type: 'window', start: 0, duration: 0.2 }] };
  assert.ok(!buildInterstitialFilterGraph(options).filters.join(';').includes('colorkey'));
  assert.ok(buildInterstitialFilterGraph({ ...options, chromaKey: true }).filters.join(';').includes(BANNER_CHROMA_FILTER));
});

const ffmpeg = path.resolve(__dirname, '../app/resources/ffmpeg.exe');
test('real MP4 loses green, preserves red, and reveals the underlying video in both modes', { skip: !fs.existsSync(ffmpeg) }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shotshorts-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = args => {
    const result = spawnSync(ffmpeg, ['-v', 'error', ...args], { maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
    return result.stdout;
  };
  const banner = path.join(dir, 'green.mp4');
  run(['-f', 'lavfi', '-i', 'color=0x00FF00:s=32x32:r=30:d=1', '-vf',
    'drawbox=x=8:y=8:w=16:h=16:color=red:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', banner]);
  for (const mode of ['off', 'overlay', 'pause', 'opacity']) {
    const pause = mode === 'pause';
    const filters = pause ? buildInterstitialFilterGraph({ baseLabel: '0:v', bannerIndexBase: 1,
      audioInputIndex: 2, layout, chromaKey: true,
      segments: [{ type: 'window', start: 0, duration: 0.2 }] }).filters
      : buildBannerFilterStrings(1, layout, '0:v', 'vout', mode === 'opacity' ? 0.5 : 1, mode !== 'off');
    const frame = run(['-f', 'lavfi', '-i', 'color=blue:s=32x32:r=30:d=1', '-i', banner,
      ...(pause ? ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'] : []),
      '-filter_complex', [...filters, ...(pause ? ['[iall]anullsink'] : [])].join(';'), '-map', pause ? '[ivout]' : '[vout]',
      '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    const pixel = (x, y) => [...frame.subarray((y * 32 + x) * 3, (y * 32 + x) * 3 + 3)];
    assert.equal(frame.length, 32 * 32 * 3);
    const corner = pixel(2, 2);
    assert.ok(mode === 'off' ? corner[1] > 200 : corner[2] > 200 && corner[1] < 40, `${mode}: background ${corner}`);
    const center = pixel(16, 16);
    assert.ok(mode === 'opacity' ? center[0] > 90 && center[2] > 90 : center[0] > 200 && center[1] < 40, `${mode}: foreground ${center}`);
  }
});
