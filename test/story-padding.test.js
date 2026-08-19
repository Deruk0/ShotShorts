const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_PRE_ROLL_SEC,
  MAX_POST_ROLL_SEC,
  getNaturalStoryRange,
  alignStoriesToTranscript
} = require('../app/services/story-padding');

test('story edges use nearby speech gaps instead of fixed five-second padding', () => {
  const segments = [
    { start: 98, end: 99, text: 'Предыдущая мысль.', words: [{ word: 'мысль', start: 98, end: 99 }] },
    { start: 100, end: 110, text: 'Полная история.', words: [{ word: 'история', start: 100, end: 110 }] },
    { start: 112, end: 113, text: 'Следующая тема.', words: [{ word: 'следующая', start: 112, end: 113 }] }
  ];
  const range = getNaturalStoryRange({ start: 100, end: 110 }, segments, 300);

  assert.equal(MAX_PRE_ROLL_SEC, 0.65);
  assert.equal(MAX_POST_ROLL_SEC, 0.85);
  assert.equal(range.start, 99.5);
  assert.equal(range.end, 110.85);
});

test('natural ranges are clamped and never overlap neighbouring stories', () => {
  const segments = [
    { start: 0, end: 10, text: 'Первая история.' },
    { start: 10.4, end: 20, text: 'Вторая история.' }
  ];
  const ranges = alignStoriesToTranscript(
    [{ title: 'Первая', start: 0, end: 10 }, { title: 'Вторая', start: 10.4, end: 20 }],
    segments,
    20
  );

  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[1].end, 20);
  assert.ok(ranges[0].end <= ranges[1].start);
});
