const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStoryChunks, buildChunkProfile, fillTimelineGaps } = require('../app/services/story-chunker');

test('short neighbouring stories are combined until the clip reaches 90 seconds', () => {
  const chunks = buildStoryChunks([
    { title: 'Первая', start: 0, end: 30 },
    { title: 'Вторая', start: 32, end: 60 },
    { title: 'Третья', start: 62, end: 100 }
  ], []);

  assert.equal(chunks.length, 1);
  assert.deepEqual([chunks[0].start, chunks[0].end], [0, 100]);
  assert.equal(chunks[0].storyCount, 3);
});

test('complete clips longer than 90 seconds stay separate', () => {
  const chunks = buildStoryChunks([
    { title: 'Первая', start: 0, end: 100 },
    { title: 'Вторая', start: 102, end: 205 }
  ], []);

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => [chunk.start, chunk.end]), [[0, 100], [102, 205]]);
});

test('a short final story is attached to the previous clip', () => {
  const chunks = buildStoryChunks([
    { title: 'Основная', start: 0, end: 100 },
    { title: 'Короткий хвост', start: 102, end: 140 }
  ], []);

  assert.equal(chunks.length, 1);
  assert.deepEqual([chunks[0].start, chunks[0].end], [0, 140]);
});

test('a short middle story joins the neighbour that makes the shorter clip', () => {
  const chunks = buildStoryChunks([
    { title: 'Левая', start: 0, end: 100 },
    { title: 'Короткая', start: 102, end: 150 },
    { title: 'Правая', start: 152, end: 400 }
  ], []);

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => [chunk.start, chunk.end]), [[0, 150], [152, 400]]);
});

test('long stories split only on transcript segment boundaries', () => {
  const segments = [];
  for (let start = 0; start < 420; start += 30) {
    segments.push({ start, end: start + 30, text: `Завершённая мысль ${start}.` });
  }

  // Default hardMax is 390: a 420s story must split into two parts inside the
  // target range, cutting only at segment ends.
  const chunks = buildStoryChunks([{ title: 'Длинная', start: 0, end: 420 }], segments);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].end, 210);
  assert.equal(chunks[1].start, 210);
  assert.ok(chunks.every((chunk) => chunk.end - chunk.start <= 390));
});

test('custom profile: hardMax lower than the default splits more aggressively', () => {
  const segments = [];
  for (let start = 0; start < 420; start += 30) {
    segments.push({ start, end: start + 30, text: `Завершённая мысль ${start}.` });
  }

  const chunks = buildStoryChunks(
    [{ title: 'Длинная', start: 0, end: 420 }],
    segments,
    buildChunkProfile({ targetMinSec: 60, targetMaxSec: 150, hardMinSec: 30, hardMaxSec: 180 })
  );

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.end - chunk.start <= 180));
});

test('buildChunkProfile keeps the chain hardMin <= targetMin <= targetMax <= hardMax', () => {
  const profile = buildChunkProfile({ targetMinSec: 500, targetMaxSec: 100, hardMinSec: 700, hardMaxSec: 50 });
  assert.ok(profile.hardMinSec <= profile.targetMinSec);
  assert.ok(profile.targetMinSec <= profile.targetMaxSec);
  assert.ok(profile.targetMaxSec <= profile.hardMaxSec);
});

test('custom profile: hardMin forces merging even past the target range', () => {
  // hardMin=200: the 60s clip MUST merge into the neighbour even though the
  // combined 210s clip exceeds targetMax=180.
  const chunks = buildStoryChunks([
    { title: 'Основная', start: 0, end: 150 },
    { title: 'Осколок', start: 152, end: 212 }
  ], [], buildChunkProfile({ targetMinSec: 90, targetMaxSec: 180, hardMinSec: 200, hardMaxSec: 300 }));

  assert.equal(chunks.length, 1);
  assert.deepEqual([chunks[0].start, chunks[0].end], [0, 212]);
});

test('long story stays intact when there is no safe transcript boundary', () => {
  const chunks = buildStoryChunks(
    [{ title: 'Монолог', start: 0, end: 360 }],
    [{ start: 0, end: 360, text: 'Незаконченная длинная реплика' }]
  );

  assert.equal(chunks.length, 1);
  assert.deepEqual([chunks[0].start, chunks[0].end], [0, 360]);
});

test('fillTimelineGaps covers head, middle gaps and tail', () => {
  const stories = [
    { title: 'A', start: 60, end: 120 },
    { title: 'B', start: 150, end: 200 }
  ];
  const fills = fillTimelineGaps(stories, 300, { minGapSec: 30, gapTitle: 'Фрагмент' });

  // 0-60 head, 120-150 is exactly 30s (>= minGap so kept), 200-300 tail
  assert.deepEqual(fills.map((f) => [f.start, f.end]), [[0, 60], [120, 150], [200, 300]]);
  assert.ok(fills.every((f) => f.title === 'Фрагмент'));
});

test('fillTimelineGaps returns nothing when stories already cover everything', () => {
  const stories = [{ title: 'A', start: 0, end: 100 }, { title: 'B', start: 100, end: 200 }];
  assert.deepEqual(fillTimelineGaps(stories, 200, { minGapSec: 30 }), []);
});

test('fillTimelineGaps handles empty story list (whole footage as one span)', () => {
  const fills = fillTimelineGaps([], 500, { minGapSec: 30 });
  assert.equal(fills.length, 1);
  assert.deepEqual([fills[0].start, fills[0].end], [0, 500]);
});

test('fillTimelineGaps skips the tail when it is shorter than minGapSec', () => {
  const stories = [{ title: 'A', start: 0, end: 190 }];
  const fills = fillTimelineGaps(stories, 200, { minGapSec: 30 });
  assert.deepEqual(fills, []);
});
