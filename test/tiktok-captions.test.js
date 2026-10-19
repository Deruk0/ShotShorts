const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHashtagPreset, composeCaption } = require('../app/services/tiktok-captions');

test('caption tokens combine filename, custom text, number, and one hashtag sample', () => {
  const result = composeCaption({ title: 'Смотри: {name} | {filename} | {n} {hashtags} / {hashtags}',
    fileName: 'C:\\clips\\Моя история.mp4', number: 2,
    hashtagPreset: { tags: 'кино #сериал #история', minCount: 2, maxCount: 2 } }, () => 0);
  assert.equal(result, 'Смотри: Моя история | Моя история.mp4 | 2 #сериал #история / #сериал #история');
});

test('filenames containing tokens are literal and unknown commands are preserved', () => {
  assert.equal(composeCaption({ title: '{name} {n} {other}', fileName: '/clips/{n}.mp4', number: 4 }), '{n} 4 {other}');
});

test('hashtags are normalized and deduplicated across case, separators, and Unicode', () => {
  const preset = normalizeHashtagPreset({ tags: '#Кино, кино\n#история; #story_time #café #cafe\u0301', minCount: 1, maxCount: 5 });
  assert.deepEqual(preset.tags, ['#Кино', '#история', '#story_time', '#café']);
});

test('hashtag samples stay within the range, have no duplicates, and use random order', () => {
  const preset = { tags: '#a #b #c #d', minCount: 2, maxCount: 4 };
  const low = composeCaption({ title: 'Text', fileName: 'clip.mp4', hashtagPreset: preset }, () => 0);
  const high = composeCaption({ title: 'Text', fileName: 'clip.mp4', hashtagPreset: preset }, max => max - 1);
  assert.equal(low, 'Text #b #c');
  assert.equal(high, 'Text #a #b #c #d');
  assert.notEqual(low, high);
});

test('a small hashtag pool uses all available unique tags', () => {
  assert.equal(composeCaption({ title: '{hashtags}', fileName: 'clip.mp4', hashtagPreset: {
    tags: '#a #a #b', minCount: 3, maxCount: 5
  } }, () => 0), '#b #a');
});

test('plain text still works and a missing hashtag preset removes only its token', () => {
  assert.equal(composeCaption({ title: 'Обычный текст #свой', fileName: 'clip.mp4' }), 'Обычный текст #свой');
  assert.equal(composeCaption({ title: '{name}\n{hashtags}', fileName: 'clip.mp4' }), 'clip');
});

test('invalid ranges and tags fail without returning a broken caption', () => {
  for (const preset of [{ tags: '', minCount: 1, maxCount: 2 }, { tags: '#bad-tag', minCount: 1, maxCount: 2 }]) {
    assert.throws(() => normalizeHashtagPreset(preset), /invalid_hashtags/);
  }
  assert.throws(() => normalizeHashtagPreset({ tags: '#ok', minCount: 5, maxCount: 2 }), /invalid_hashtag_range/);
  assert.throws(() => composeCaption({ title: 'x'.repeat(2198) + '{name}', fileName: 'long.mp4' }), /invalid_caption/);
});
