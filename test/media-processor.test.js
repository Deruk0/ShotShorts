const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MediaProcessor } = require('../app/services/media-processor');
const { writeSceneMetaFile } = require('../app/services/cinema-scene-detector');
const { EventEmitter } = require('node:events');
const { isAbortError } = require('../app/services/cancellation');

test('processor cancellation kills a command that has not spawned yet', async () => {
  const processor = new MediaProcessor();
  const cmd = new EventEmitter();
  let spawned = false;
  let killed = false;
  cmd.run = () => {};
  cmd.kill = () => { if (spawned) killed = true; };
  const result = processor._runCommand(cmd);
  processor.cancel();
  spawned = true;
  cmd.emit('start');
  assert.equal(killed, true);
  const rejection = assert.rejects(result, isAbortError);
  cmd.emit('error', new Error('killed'));
  await rejection;
  processor.reset();
  const next = new EventEmitter();
  next.run = () => next.emit('end');
  await processor._runCommand(next);
});

test('failed rendering removes incomplete output for stories and cinema', async t => {
  for (const mode of ['stories', 'cinema']) {
    const { processor, outputDir } = setup(t);
    processor.selectBackgroundVideos = async () => ({ files: ['background.mp4'], totalDur: 10 });
    processor._runCommand = async cmd => {
      const output = cmd._outputs[0].target;
      fs.writeFileSync(output, Buffer.alloc(3000));
      if (path.extname(output) === '.mp4') throw new Error('Render failed');
    };
    const segment = { index: 1, title: 'Clip', start: 0, end: 1 };
    await assert.rejects(mode === 'stories'
      ? processor.assembleVideo(segment, 'audio.wav', {}, outputDir)
      : processor.assembleCinemaClip(segment, 'source.mp4', outputDir, {}), /Render failed/);
    assert.deepEqual(fs.readdirSync(outputDir), []);
  }
});

test('failed fallback extraction removes partial safe audio', async t => {
  const { processor, outputDir } = setup(t);
  processor.selectBackgroundVideos = async () => ({ files: ['background.mp4'], totalDur: 10 });
  let safeAudio;
  processor._runCommand = async cmd => {
    const output = cmd._outputs[0].target;
    fs.writeFileSync(output, 'partial');
    if (path.basename(output).startsWith('ss_seg_safe_')) {
      safeAudio = output;
      throw new Error('Extraction failed');
    }
    if (path.extname(output) === '.mp4') throw new Error('Render failed');
  };
  t.after(() => { if (safeAudio && fs.existsSync(safeAudio)) fs.unlinkSync(safeAudio); });
  await assert.rejects(processor.assembleVideo(
    { index: 1, title: 'Clip', start: 0, end: 1 }, 'audio.wav', {}, outputDir
  ), /Extraction failed/);
  assert.ok(safeAudio);
  assert.equal(fs.existsSync(safeAudio), false);
});

function setup(t) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shotshorts-render-test-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const processor = new MediaProcessor();
  processor._runCommand = async (cmd) => {
    fs.writeFileSync(cmd._outputs[0].target, 'rendered');
  };
  return { processor, outputDir };
}

test('cinema clips with repeated titles preserve earlier output and metadata', async (t) => {
  const { processor, outputDir } = setup(t);
  const segment = { index: 1, title: 'Same title', start: 0, end: 1 };
  const first = await processor.assembleCinemaClip(segment, 'source.mp4', outputDir, {});
  fs.writeFileSync(first, 'first clip');
  const firstMeta = writeSceneMetaFile(first, { ...segment, hook: 'First hook' });
  const second = await processor.assembleCinemaClip({ ...segment, index: 2 }, 'source.mp4', outputDir, {});
  const secondMeta = writeSceneMetaFile(second, { ...segment, hook: 'Second hook' });
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(first, 'utf8'), 'first clip');
  assert.equal(fs.readFileSync(second, 'utf8'), 'rendered');
  assert.notEqual(firstMeta, secondMeta);
  assert.match(fs.readFileSync(firstMeta, 'utf8'), /First hook/);
  assert.match(fs.readFileSync(secondMeta, 'utf8'), /Second hook/);
});

test('long cinema titles retain the mp4 extension, including split parts', async (t) => {
  const { processor, outputDir } = setup(t);
  for (const partIndex of [undefined, 1]) {
    const output = await processor.assembleCinemaClip(
      { index: 1, title: 'x'.repeat(200), partIndex, start: 0, end: 1 },
      'source.mp4', outputDir, {}
    );
    assert.equal(path.extname(output), '.mp4');
    assert.ok(path.basename(output).length <= 180);
  }
});

test('failed cinema audio extraction removes its partial temporary file', async (t) => {
  const { processor, outputDir } = setup(t);
  let audioFile;
  processor._runCommand = async (cmd) => {
    audioFile = cmd._outputs[0].target;
    fs.writeFileSync(audioFile, 'partial audio');
    throw new Error('Audio extraction failed');
  };
  t.after(() => { if (audioFile && fs.existsSync(audioFile)) fs.unlinkSync(audioFile); });
  await assert.rejects(
    processor.assembleCinemaClip({ index: 1, title: 'Scene', start: 0, end: 1 }, 'source.mp4', outputDir, {}),
    /Audio extraction failed/
  );
  assert.equal(fs.existsSync(audioFile), false);
});

test('stories keep long filenames valid and avoid overwriting existing clips', async (t) => {
  const { processor, outputDir } = setup(t);
  processor.selectBackgroundVideos = async () => ({ files: ['background.mp4'], totalDur: 10 });
  const segment = { index: 1, title: 'x'.repeat(200), partIndex: 1, start: 0, end: 1 };
  const first = await processor.assembleVideo(segment, 'source.wav', {}, outputDir);
  fs.writeFileSync(first, 'earlier story');
  const second = await processor.assembleVideo(segment, 'source.wav', {}, outputDir);
  assert.equal(path.extname(first), '.mp4');
  assert.equal(path.extname(second), '.mp4');
  assert.ok(path.basename(second).length <= 180);
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(first, 'utf8'), 'earlier story');
});

test('stories remove temporary audio when extraction or background selection fails', async (t) => {
  for (const failedStage of ['audio', 'background']) {
    const { processor, outputDir } = setup(t);
    let audioFile;
    processor._runCommand = async (cmd) => {
      audioFile = cmd._outputs[0].target;
      fs.writeFileSync(audioFile, 'partial audio');
      if (failedStage === 'audio') throw new Error('Preparation failed');
    };
    processor.selectBackgroundVideos = async () => { throw new Error('Preparation failed'); };
    t.after(() => { if (audioFile && fs.existsSync(audioFile)) fs.unlinkSync(audioFile); });
    await assert.rejects(
      processor.assembleVideo({ index: 1, title: 'Story', start: 0, end: 1 }, 'source.wav', {}, outputDir),
      /Preparation failed/
    );
    assert.equal(fs.existsSync(audioFile), false);
  }
});

test('source extraction and downsampling remove partial audio after failure', async (t) => {
  for (const method of ['extractAudio', 'downsampleAudioForAI']) {
    const { processor } = setup(t);
    let audioFile;
    processor._runCommand = async (cmd) => {
      audioFile = cmd._outputs[0].target;
      fs.writeFileSync(audioFile, 'partial audio');
      throw new Error('FFmpeg failed');
    };
    t.after(() => { if (audioFile && fs.existsSync(audioFile)) fs.unlinkSync(audioFile); });
    await assert.rejects(processor[method]('source.mp4'), /FFmpeg failed/);
    assert.equal(fs.existsSync(audioFile), false);
  }
});
