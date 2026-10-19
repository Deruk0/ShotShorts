const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const cancellation = require('../app/services/cancellation');

function harness(mode, outcome, failQueue = false) {
  const file = path.join(__dirname, '../app/services/process-handler.js');
  const realRequire = createRequire(file);
  const handlers = new Map();
  const delivered = [];
  let deliveredBeforeSecond;
  const chunks = [1, 2].map(index => ({ index, title: `Clip ${index}`, source: 'llm', start: (index - 1) * 60, end: index * 60 }));
  const render = async chunk => {
    if (chunk.index === 2) {
      deliveredBeforeSecond = delivered.length;
      if (outcome === 'failed') throw new Error('render_failed');
      if (outcome === 'cancelled') {
        handlers.get('process:cancel')();
        throw cancellation.createAbortError();
      }
    }
    return path.resolve(`fixture-clip-${chunk.index}.mp4`);
  };
  const command = {};
  for (const method of ['audioCodec', 'audioChannels', 'audioFrequency', 'audioBitrate', 'format', 'output', 'on']) command[method] = () => command;
  const overrides = {
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
      BrowserWindow: { fromWebContents: () => ({ webContents: { send() {} } }) } },
    fs: { existsSync: () => true, statSync: () => ({ size: 32 }), unlinkSync() {} },
    'fluent-ffmpeg': () => command,
    './cancellation': { ...cancellation, runFfmpegCommand: async () => {} },
    './store': { getProxy: async () => null },
    './media-processor': { MediaProcessor: class {
      reset() {} cancel() {}
      extractAudio() { return Promise.resolve('fixture.wav'); }
      getVideoDuration() { return Promise.resolve(120); }
      getBackgroundVideos() { return ['background.mp4']; }
      assembleVideo(...args) { return render(...args); }
      assembleCinemaClip(...args) { return render(...args); }
    } },
    './whisper-service': { WhisperService: class { setProxy() {} async transcribe() { return chunks; } } },
    './groq-story-analyzer': { GroqStoryAnalyzer: class {
      setModelChain() {} async analyzeTranscript() { return { stories: chunks, blocks: [] }; }
      async analyzeScenes() { return { scenes: chunks }; }
    } },
    './model-registry': { resolveModelChain: () => [{}] },
    './story-padding': { alignStoriesToTranscript: stories => stories },
    './story-chunker': { ...realRequire('./story-chunker'), buildStoryChunks: stories => stories, fillTimelineGaps: () => [] },
    './cinema-scene-detector': { ...realRequire('./cinema-scene-detector'),
      analyzeMovieEnergy: async () => ({ loudnessIntervals: [], sceneCuts: [] }), writeSceneMetaFile() {} }
  };
  const context = vm.createContext({ module: { exports: {} }, AbortController,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name) });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  context.module.exports.register({ onGenerated: async files => {
    if (failQueue) throw new Error('disk_full');
    delivered.push(...files);
  } });
  return { delivered, beforeSecond: () => deliveredBeforeSecond, run: () => handlers.get('process:start')({ sender: {} }, {
    mode, sourceVideo: 'source.mp4', backgroundFolder: 'backgrounds', outputFolder: 'output'
  }) };
}

for (const mode of ['stories', 'cinema']) {
  for (const outcome of ['success', 'failed', 'cancelled']) {
    test(`${mode}: completed clips reach TikTok before the next render (${outcome})`, async () => {
      const h = harness(mode, outcome);
      const result = await h.run();
      assert.equal(h.beforeSecond(), 1);
      assert.deepEqual(h.delivered, (outcome === 'success' ? [1, 2] : [1]).map(index => path.resolve(`fixture-clip-${index}.mp4`)));
      assert.equal(result.success, outcome === 'success');
      if (outcome === 'cancelled') assert.equal(result.cancelled, true);
    });
  }
  test(`${mode}: queue storage errors do not fail rendering`, async () => {
    const result = await harness(mode, 'success', true).run();
    assert.equal(result.success, true);
    assert.equal(result.outputFiles.length, 2);
    assert.equal(result.tiktokQueueError, 'queue_storage_error');
  });
}
