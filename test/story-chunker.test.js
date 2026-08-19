const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStoryChunks } = require('../app/services/story-chunker');

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

  const chunks = buildStoryChunks([{ title: 'Длинная', start: 0, end: 420 }], segments);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].end, 210);
  assert.equal(chunks[1].start, 210);
  assert.ok(chunks.every((chunk) => chunk.end - chunk.start <= 300));
});

test('long story stays intact when there is no safe transcript boundary', () => {
  const chunks = buildStoryChunks(
    [{ title: 'Монолог', start: 0, end: 360 }],
    [{ start: 0, end: 360, text: 'Незаконченная длинная реплика' }]
  );

  assert.equal(chunks.length, 1);
  assert.deepEqual([chunks[0].start, chunks[0].end], [0, 360]);
});
