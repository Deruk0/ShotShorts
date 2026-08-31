const test = require('node:test');
const assert = require('node:assert/strict');
const { WhisperService } = require('../app/services/whisper-service');

const segments = [{
  start: 0,
  end: 1,
  text: 'hello world',
  words: [
    { word: 'hello', start: 0, end: 0.5 },
    { word: 'world', start: 0.5, end: 1 }
  ]
}];

test('toASS free position tags every line with \\pos and centers the anchor', () => {
  const ws = new WhisperService();
  const ass = ws.toASS(segments, 'Classic', 0, { customPos: true, customX: 540, customY: 1850, wordsPerLine: 3 }, 'sentence');
  assert.ok(ass.includes('{\\pos(540,1850)}'));
  // Style Default uses Alignment 5 (middle-center anchor) in free mode
  const styleLine = ass.split('\n').find((l) => l.startsWith('Style: Default,'));
  assert.ok(styleLine);
  const fields = styleLine.split(',');
  // Format: Name, Fontname, Fontsize, ..., BorderStyle, Outline, Shadow, Alignment, ...
  assert.equal(fields[18], '5');
});

test('toASS clamps out-of-range free positions', () => {
  const ws = new WhisperService();
  const ass = ws.toASS(segments, 'Classic', 0, { customPos: true, customX: 9999, customY: -500, wordsPerLine: 3 }, 'sentence');
  assert.ok(ass.includes('{\\pos(1080,0)}'));
});

test('toASS keeps classic margin positioning when free position is off', () => {
  const ws = new WhisperService();
  const ass = ws.toASS(segments, 'Classic', 0, { position: 'bottom', wordsPerLine: 3 }, 'sentence');
  assert.ok(!ass.includes('\\pos('));
  const styleLine = ass.split('\n').find((l) => l.startsWith('Style: Default,'));
  assert.equal(styleLine.split(',')[18], '2');
});

test('toASS free position also applies to karaoke lines', () => {
  const ws = new WhisperService();
  const ass = ws.toASS(segments, 'Classic', 0, { customPos: true, customX: 540, customY: 1850, wordsPerLine: 3, karaoke: true, karaokeEffects: ['highlight'] }, 'sentence');
  const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.ok(dialogue.length > 0);
  assert.ok(dialogue.every((l) => l.includes('{\\pos(540,1850)}')));
});

test('toASS shifts events over interstitial pause windows', () => {
  const ws = new WhisperService();
  // Word starts at 61s: one full 60s interval has passed -> shift by 5s -> 66s.
  const shifted = ws.toASS([
    { start: 61, end: 62, text: 'hello world', words: [{ word: 'hello', start: 61, end: 62 }] }
  ], 'Classic', 0, { wordsPerLine: 3, interstitial: { intervalSec: 60, durationSec: 5 } }, 'sentence');
  assert.ok(shifted.includes('0:01:06.00'), 'expected shifted start 66s in ' + shifted.split('[Events]')[1]?.slice(0, 400));

  // Word before the first window keeps its original time.
  const unshifted = ws.toASS([
    { start: 1, end: 2, text: 'hello world', words: [{ word: 'hello', start: 1, end: 2 }] }
  ], 'Classic', 0, { wordsPerLine: 3, interstitial: { intervalSec: 60, durationSec: 5 } }, 'sentence');
  assert.ok(unshifted.includes('0:00:01.00'));
});

test('toASS cuts subtitles when the interstitial banner appears', () => {
  const ws = new WhisperService();
  // Word 59..62 straddles the window at output 60..65: the event must end
  // exactly at 60 (banner appearance), not render on top of the banner.
  const ass = ws.toASS([
    { start: 59, end: 62, text: 'hello world', words: [{ word: 'hello', start: 59, end: 62 }] }
  ], 'Classic', 0, { wordsPerLine: 3, interstitial: { intervalSec: 60, durationSec: 5 } }, 'sentence');
  const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'));
  assert.ok(dialogue.includes('0:00:59.00'), 'start stays at 59s');
  assert.ok(dialogue.includes('0:01:00.00'), 'end cut at 60s (window start)');

  // Word after the window resumes past it (shifted by 5s).
  const after = ws.toASS([
    { start: 63, end: 64, text: 'hello world', words: [{ word: 'hello', start: 63, end: 64 }] }
  ], 'Classic', 0, { wordsPerLine: 3, interstitial: { intervalSec: 60, durationSec: 5 } }, 'sentence');
  assert.ok(after.includes('0:01:08.00'), 'post-window event starts at 68s');

  // Without interstitial nothing is clipped (maxLineMs caps at 59+1.2s).
  const plain = ws.toASS([
    { start: 59, end: 62, text: 'hello world', words: [{ word: 'hello', start: 59, end: 62 }] }
  ], 'Classic', 0, { wordsPerLine: 3 }, 'sentence');
  assert.ok(plain.includes('0:01:00.20'));
});
