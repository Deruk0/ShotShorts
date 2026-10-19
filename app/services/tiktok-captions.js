const path = require('node:path');
const { randomInt } = require('node:crypto');

function normalizeHashtagPreset(input) {
  if (typeof input?.tags !== 'string' && !Array.isArray(input?.tags)) throw new Error('invalid_hashtags');
  const tokens = (Array.isArray(input.tags) ? input.tags.join(' ') : input.tags).normalize('NFC').split(/[\s,;#]+/u).filter(Boolean);
  const seen = new Set();
  const tags = [];
  for (const token of tokens) {
    if (!/^[\p{L}\p{M}\p{N}_]+$/u.test(token) || token.length > 100) throw new Error('invalid_hashtags');
    const key = token.toLowerCase();
    if (!seen.has(key)) { seen.add(key); tags.push(`#${token}`); }
  }
  if (!tags.length || tags.length > 200) throw new Error('invalid_hashtags');
  const minCount = Number(input.minCount);
  const maxCount = Number(input.maxCount);
  if (!Number.isInteger(minCount) || !Number.isInteger(maxCount) || minCount < 1 || maxCount < minCount || maxCount > 200) {
    throw new Error('invalid_hashtag_range');
  }
  return { tags, minCount, maxCount };
}

function captionText(value) {
  if (typeof value !== 'string' || value.length > 2200) throw new Error('invalid_caption');
  return value;
}

function composeCaption({ title, fileName, number = 1, hashtagPreset }, pick = randomInt) {
  captionText(title);
  if (typeof fileName !== 'string' || !fileName || fileName.length > 1024 || !Number.isInteger(number) || number < 1) {
    throw new Error('invalid_caption_sample');
  }
  const filename = path.win32.basename(fileName.replaceAll('/', '\\'));
  const name = filename.slice(0, filename.length - path.win32.extname(filename).length);
  let hashtags = '';
  if (hashtagPreset) {
    const { tags, minCount, maxCount } = normalizeHashtagPreset(hashtagPreset);
    const pool = [...tags];
    for (let index = pool.length - 1; index > 0; index--) {
      const other = pick(index + 1);
      [pool[index], pool[other]] = [pool[other], pool[index]];
    }
    const min = Math.min(minCount, pool.length);
    const max = Math.min(maxCount, pool.length);
    hashtags = pool.slice(0, min + pick(max - min + 1)).join(' ');
  }
  const values = { name, filename, n: String(number), hashtags };
  // One pass keeps braces in filenames literal and reuses one hashtag sample.
  let result = title.replace(/\{(name|filename|n|hashtags)\}/g, (_token, key) => values[key]);
  if (hashtags && !title.includes('{hashtags}')) result += `${result && !/\s$/.test(result) ? ' ' : ''}${hashtags}`;
  return captionText(result.trim());
}

module.exports = { normalizeHashtagPreset, composeCaption, captionText };
