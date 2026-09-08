const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseEbur128,
  parseSceneCuts,
  scoreActionWindows,
  snapSceneToCuts,
  buildActionScenes,
  buildCinemaChunkProfile,
  normalizeCinemaSceneCount,
  normalizeActionScenes,
  scenesOverlap,
  buildCinemaSceneList,
  writeSceneMetaFile
} = require('../app/services/cinema-scene-detector');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeLoudness(points, step = 0.1) {
  return points.map(({ t, lufs }) => ({
    start: Math.max(0, t - step / 2),
    end: t + step / 2,
    lufs
  }));
}

test('parseEbur128 extracts momentary/short-term loudness table', () => {
  const log = [
    '[Parsed_ebur128_0 @ 0000] t: 0.4      TARGET:-23 LUFS    M: -18.5 S: -19.2     I: -20.1 LUFS',
    '[Parsed_ebur128_0 @ 0000] t: 0.5      TARGET:-23 LUFS    M: -17.1 S: -18.8     I: -20.0 LUFS',
    '[Parsed_ebur128_0 @ 0000] t: 0.6      TARGET:-23 LUFS    M: -inf   S: -inf     I: -20.0 LUFS'
  ].join('\n');

  const intervals = parseEbur128(log);
  assert.equal(intervals.length, 3);
  assert.equal(intervals[0].lufs, -19.2);
  assert.equal(intervals[1].lufs, -18.8);
  assert.equal(intervals[2].lufs, -70);
  assert.ok(intervals[1].start > intervals[0].start);
});

test('parseEbur128 returns empty array for empty log', () => {
  assert.deepEqual(parseEbur128(''), []);
  assert.deepEqual(parseEbur128(null), []);
});

test('parseSceneCuts pairs frame times with scene scores', () => {
  const log = [
    'frame:120  pts:4800   pts_time:4.8',
    'lavfi.scene_score=0.620000',
    'frame:340  pts:13600  pts_time:13.6',
    'lavfi.scene_score=0.510000'
  ].join('\n');

  const cuts = parseSceneCuts(log);
  assert.equal(cuts.length, 2);
  assert.deepEqual(cuts[0], { time: 4.8, score: 0.62 });
  assert.deepEqual(cuts[1], { time: 13.6, score: 0.51 });
});

test('scoreActionWindows prefers loud, cut-heavy, speechless windows', () => {
  const total = 120;
  const loudness = makeLoudness(
    Array.from({ length: 1200 }, (_, i) => ({
      t: i * 0.1,
      lufs: i * 0.1 >= 30 && i * 0.1 < 45 ? -8 : -20
    }))
  );
  const cuts = [];
  for (let t = 30; t < 45; t += 1.5) cuts.push({ time: t, score: 0.5 });
  const speech = [{ start: 0, end: 30 }, { start: 45, end: 120 }];

  const windows = scoreActionWindows(loudness, cuts, speech, total, 1);

  assert.equal(windows.length, 1);
  assert.equal(windows[0].start, 30);
  assert.equal(windows[0].end, 45);
  assert.ok(windows[0].score > 0);
});

test('scoreActionWindows returns no windows for a flat quiet movie', () => {
  const total = 120;
  const loudness = makeLoudness(
    Array.from({ length: 1200 }, (_, i) => ({ t: i * 0.1, lufs: -20 }))
  );

  const windows = scoreActionWindows(loudness, [], [], total, 3);
  assert.deepEqual(windows, []);
});

test('scoreActionWindows never returns overlapping windows', () => {
  const total = 300;
  const loudness = makeLoudness(
    Array.from({ length: 3000 }, (_, i) => ({ t: i * 0.1, lufs: -6 }))
  );
  const cuts = [];
  for (let t = 0; t < 300; t += 0.5) cuts.push({ time: t, score: 0.9 });

  const windows = scoreActionWindows(loudness, cuts, [], total, 10);

  for (let i = 1; i < windows.length; i++) {
    assert.ok(windows[i].start >= windows[i - 1].end + 20, `windows ${i - 1} and ${i} overlap`);
  }
});

test('snapSceneToCuts moves the start to a nearby cut', () => {
  const cuts = [{ time: 10.0, score: 0.5 }, { time: 14.2, score: 0.5 }];
  const scene = { start: 10.4, end: 25.4 };

  const snapped = snapSceneToCuts(scene, cuts, 120);

  assert.equal(snapped.start, 10);
  assert.equal(snapped.end, 25);
  assert.equal(snapped.end - snapped.start, 15);
});

test('snapSceneToCuts keeps the scene intact when no cuts are nearby', () => {
  const cuts = [{ time: 100, score: 0.5 }];
  const scene = { start: 5, end: 20 };

  const snapped = snapSceneToCuts(scene, cuts, 120);

  assert.equal(snapped.start, 5);
  assert.equal(snapped.end, 20);
});

test('buildActionScenes clamps, snaps and limits requested count', () => {
  const total = 600;
  const energy = {
    loudnessIntervals: makeLoudness(
      Array.from({ length: 6000 }, (_, i) => ({
        t: i * 0.1,
        lufs: i * 0.1 >= 100 && i * 0.1 < 115 ? -8 : (i * 0.1 >= 300 && i * 0.1 < 315 ? -9 : -20)
      }))
    ),
    sceneCuts: []
  };

  const scenes = buildActionScenes(energy, [], total, 2);

  assert.equal(scenes.length, 2);
  for (const scene of scenes) {
    assert.ok(scene.start >= 0 && scene.end <= total);
    assert.ok(scene.end > scene.start);
  }
  assert.ok(scenes[0].start < 200);
  assert.ok(scenes[1].start > 200);
});

test('buildActionScenes returns empty array for empty energy', () => {
  assert.deepEqual(buildActionScenes({ loudnessIntervals: [], sceneCuts: [] }, [], 600, 5), []);
});

test('buildCinemaChunkProfile respects target and max duration settings', () => {
  const profile = buildCinemaChunkProfile({ cinemaTargetSec: 30, cinemaMaxSec: 60 });
  assert.equal(profile.targetChunkDurationSec, 30);
  assert.equal(profile.maxChunkDurationSec, 60);
  assert.equal(profile.mergeShortChunks, false);
});

test('buildCinemaChunkProfile clamps values to sane ranges and fixes max < target', () => {
  const tooSmall = buildCinemaChunkProfile({ cinemaTargetSec: 1, cinemaMaxSec: 5 });
  assert.equal(tooSmall.targetChunkDurationSec, 10);
  assert.equal(tooSmall.maxChunkDurationSec, 15);

  const inverted = buildCinemaChunkProfile({ cinemaTargetSec: 80, cinemaMaxSec: 30 });
  assert.equal(inverted.targetChunkDurationSec, 80);
  assert.equal(inverted.maxChunkDurationSec, 80);

  const defaults = buildCinemaChunkProfile({});
  assert.equal(defaults.targetChunkDurationSec, 45);
  assert.equal(defaults.maxChunkDurationSec, 90);
});

test('normalizeCinemaSceneCount clamps to the 5-20 range', () => {
  assert.equal(normalizeCinemaSceneCount(3), 5);
  assert.equal(normalizeCinemaSceneCount(25), 20);
  assert.equal(normalizeCinemaSceneCount(7.6), 8);
  assert.equal(normalizeCinemaSceneCount(undefined), 10);
  assert.equal(normalizeCinemaSceneCount('junk'), 10);
});

test('normalizeActionScenes builds action entries and drops tiny windows', () => {
  const scenes = normalizeActionScenes([
    { start: 10, end: 25, score: 42 },
    { start: 30, end: 32, score: 99 }
  ], 120, 3);

  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].title, 'Action 3');
  assert.equal(scenes[0].source, 'action');
  assert.equal(scenes[0].intensity, 42);
  assert.equal(scenes[0].end, 25);
});

test('scenesOverlap respects the gap', () => {
  assert.ok(scenesOverlap({ start: 0, end: 20 }, { start: 15, end: 30 }));
  assert.ok(!scenesOverlap({ start: 0, end: 20 }, { start: 20, end: 30 }));
  assert.ok(scenesOverlap({ start: 0, end: 20 }, { start: 20.5, end: 30 }, 1));
});

test('buildCinemaSceneList drops action scenes overlapping dialogue scenes', () => {
  const llm = [
    { title: 'Признание', hook: 'Хук один', start: 5, end: 20, intensity: 0.9 },
    { title: 'Твист', hook: 'Хук два', start: 30, end: 44, intensity: 0.8 }
  ];
  const action = normalizeActionScenes([
    { start: 21, end: 36, score: 71.9 },
    { start: 50, end: 65, score: 40 }
  ], 60, 3);

  const list = buildCinemaSceneList(llm, action, 60);

  assert.equal(list.length, 3);
  assert.deepEqual(list.map((s) => s.source), ['llm', 'llm', 'action']);
  assert.equal(list[0].hook, 'Хук один');
  assert.ok(list[0].start <= list[1].start && list[1].start <= list[2].start);
});

test('buildCinemaSceneList keeps everything when there is no action', () => {
  const list = buildCinemaSceneList([{ title: 'Сцена', start: 1, end: 9 }], [], 60);
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'llm');
});

test('writeSceneMetaFile writes title, hook and timestamps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss_meta_'));
  const out = path.join(dir, 'clip.mp4');

  const meta = writeSceneMetaFile(out, { title: 'Тест', hook: 'Хук', source: 'llm', start: 75, end: 130 });
  assert.equal(meta, path.join(dir, 'clip.txt'));
  const content = fs.readFileSync(meta, 'utf8');
  assert.match(content, /TITLE: Тест/);
  assert.match(content, /HOOK: Хук/);
  assert.match(content, /MOVIE TIME: 01:15 - 02:10/);

  const actionMeta = writeSceneMetaFile(out, { title: 'Action 1', hook: '', source: 'action', start: 0, end: 15 });
  assert.match(fs.readFileSync(actionMeta, 'utf8'), /HOOK: \(action scene/);
});
