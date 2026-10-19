const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadService(name, globals = {}) {
  const file = path.join(__dirname, '../app/services', name);
  const context = vm.createContext({ module: { exports: {} }, require: createRequire(file), ...globals });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context;
}

test('saving a high hard minimum raises every following duration limit', async () => {
  const values = { storiesHardMinSec: 60, storiesTargetMinSec: 90, storiesTargetMaxSec: 300, storiesHardMaxSec: 390 };
  const testStore = { get: (key) => values[key], set: (key, value) => { values[key] = value; } };
  const context = loadService('store.js', { testStore });
  vm.runInContext('storeInstance = testStore', context);
  await context.module.exports.saveSettings({ storiesHardMinSec: 500 });
  assert.equal(values.storiesHardMinSec, 500);
  assert.equal(values.storiesTargetMinSec, 500);
  assert.equal(values.storiesTargetMaxSec, 500);
  assert.equal(values.storiesHardMaxSec, 500);
});

test('renderer normalizes inverted duration settings in one pass', () => {
  const file = path.join(__dirname, '../app/renderer/app.js');
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('function clampStoriesSec(');
  const end = source.indexOf("$('#cinema-target-sec').addEventListener", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  const result = context.normalizeStoriesLength({ storiesHardMinSec: 500, storiesTargetMinSec: 400, storiesTargetMaxSec: 100, storiesHardMaxSec: 50 });
  assert.equal(result.hardMin, 500);
  assert.equal(result.targetMin, 500);
  assert.equal(result.targetMax, 500);
  assert.equal(result.hardMax, 500);
});

test('pipeline subtitle options preserve zero coordinates', () => {
  const context = loadService('process-handler.js');
  const options = context.buildSubtitleOptions({ subtitleX: 0, subtitleY: 0 });
  assert.equal(options.customX, 0);
  assert.equal(options.customY, 0);
});

test('cinema snapping respects the preceding action scene', async () => {
  const file = path.join(__dirname, '../app/services/process-handler.js');
  const realRequire = createRequire(file);
  let selected;
  const context = loadService('process-handler.js', {
    require: (id) => {
      const original = realRequire(id);
      if (id === './cinema-scene-detector') return {
        ...original,
        analyzeMovieEnergy: async () => ({ loudnessIntervals: [], sceneCuts: [{ time: 9, score: 0.8 }] }),
        buildCinemaSceneList: () => [
          { index: 1, source: 'action', start: 0, end: 10 },
          { index: 2, source: 'llm', start: 12, end: 20 }
        ]
      };
      if (id === './story-chunker') return {
        ...original,
        buildStoryChunks: (scenes) => { selected = scenes; return []; }
      };
      return original;
    }
  });
  await context.runCinemaPipeline({
    config: {}, send: () => {}, signal: new AbortController().signal,
    transcriptSegments: [], sourceAudioDuration: 30
  });
  assert.ok(selected);
  assert.equal(selected[1].start, 12);
  assert.ok(selected[1].start >= selected[0].end);
});
