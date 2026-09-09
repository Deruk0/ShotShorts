// Default clip-length profile for stories mode (all values user-configurable
// in Settings). Semantics:
// - targetMinSec: clips shorter than this are merge candidates
// - targetMaxSec: split points aim to land parts below this
// - hardMinSec: clips shorter than this MUST merge (even past the target)
// - hardMaxSec: clips longer than this get split (unless no safe cut exists)
// - maxCombinedDurationSec: merge cap for two clips
const DEFAULT_TARGET_MIN_SEC = 90;
const DEFAULT_TARGET_MAX_SEC = 300;
const DEFAULT_HARD_MIN_SEC = 60;
const DEFAULT_HARD_MAX_SEC = 390;

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function buildChunkProfile(options = {}) {
  const targetMin = clampNumber(options.targetMinSec, 5, 3600, DEFAULT_TARGET_MIN_SEC);
  const targetMax = clampNumber(options.targetMaxSec, targetMin, 7200, Math.max(DEFAULT_TARGET_MAX_SEC, targetMin));
  const hardMin = clampNumber(options.hardMinSec, 5, targetMin, Math.min(DEFAULT_HARD_MIN_SEC, targetMin));
  const hardMax = clampNumber(options.hardMaxSec, targetMax, 14400, Math.max(DEFAULT_HARD_MAX_SEC, targetMax));
  const maxCombined = clampNumber(options.maxCombinedDurationSec, targetMin, 14400, hardMax);
  return {
    targetMinSec: targetMin,
    targetMaxSec: targetMax,
    hardMinSec: hardMin,
    hardMaxSec: hardMax,
    targetChunkDurationSec: targetMin,
    minChunkDurationSec: targetMin,
    maxChunkDurationSec: hardMax,
    maxCombinedDurationSec: maxCombined,
    mergeShortChunks: options.mergeShortChunks !== false
  };
}

function normalizeTranscriptSegments(transcriptSegments) {
  return (Array.isArray(transcriptSegments) ? transcriptSegments : [])
    .map((segment) => ({
      start: Math.max(0, Number(segment?.start) || 0),
      end: Math.max(0, Number(segment?.end) || 0),
      text: String(segment?.text || '').trim()
    }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function boundaryScore(segment, nextSegment, desiredEnd) {
  const distancePenalty = Math.abs(segment.end - desiredEnd);
  const pauseAfter = nextSegment ? Math.max(0, nextSegment.start - segment.end) : 0;
  const sentenceBonus = /[.!?…][\"'»”)]*$/.test(segment.text) ? 10 : 0;
  const pauseBonus = Math.min(3, pauseAfter) * 18;
  return distancePenalty - sentenceBonus - pauseBonus;
}

function findNaturalCut(segments, partStart, desiredEnd, latestEnd, storyEnd, profile) {
  let best = null;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.end < partStart + (profile.hardMinSec || profile.minChunkDurationSec)) continue;
    if (segment.end > latestEnd || segment.end >= storyEnd - 20) continue;
    const score = boundaryScore(segment, segments[i + 1], desiredEnd);
    if (!best || score < best.score) best = { end: segment.end, score };
  }
  return best?.end || null;
}

function splitLongStoryAtNaturalBoundaries(story, transcriptSegments, profile) {
  const duration = story.end - story.start;
  if (duration <= (profile.hardMaxSec || profile.maxChunkDurationSec)) return [{ ...story, partIndex: null }];

  const segments = normalizeTranscriptSegments(transcriptSegments)
    .filter((segment) => segment.end > story.start && segment.start < story.end);
  const desiredPartDuration = Math.max(
    profile.hardMinSec || profile.minChunkDurationSec,
    Math.min(profile.targetMaxSec || profile.maxChunkDurationSec, duration / 2)
  );
  const chunks = [];
  let partStart = story.start;

  while (story.end - partStart > (profile.hardMaxSec || profile.maxChunkDurationSec)) {
    const desiredEnd = Math.min(story.end, partStart + desiredPartDuration);
    const latestEnd = Math.min(story.end, partStart + (profile.hardMaxSec || profile.maxChunkDurationSec));
    const cut = findNaturalCut(segments, partStart, desiredEnd, latestEnd, story.end, profile);
    if (!cut || cut <= partStart) {
      // A long complete story is preferable to a cut in the middle of speech.
      return [{ ...story, partIndex: null }];
    }
    chunks.push({ ...story, start: partStart, end: cut, partIndex: chunks.length + 1 });
    partStart = cut;
  }

  chunks.push({ ...story, start: partStart, end: story.end, partIndex: chunks.length + 1 });
  return chunks;
}

function chunkDuration(chunk) {
  return Math.max(0, Number(chunk?.end) - Number(chunk?.start));
}

function chunkTitles(chunk) {
  const titles = Array.isArray(chunk?.storyTitles) ? chunk.storyTitles : [chunk?.title];
  return [...new Set(titles.map((title) => String(title || '').trim()).filter(Boolean))];
}

function mergeAdjacentChunks(left, right) {
  const storyTitles = [...new Set([...chunkTitles(left), ...chunkTitles(right)])];
  return {
    ...left,
    // Keep the FIRST story's title for merged clips — the other stories are
    // tracked in storyTitles for stats, but the file name stays clean.
    title: (left.title || right.title || '').trim(),
    storyTitles,
    storyCount: Number(left.storyCount || 1) + Number(right.storyCount || 1),
    start: left.start,
    end: right.end,
    partIndex: null
  };
}

function pickMergeSide(merged, i) {
  const candidates = [];
  if (i > 0) candidates.push({ side: 'left', duration: merged[i].end - merged[i - 1].start });
  if (i + 1 < merged.length) candidates.push({ side: 'right', duration: merged[i + 1].end - merged[i].start });
  candidates.sort((a, b) => a.duration - b.duration || (a.side === 'left' ? -1 : 1));
  return candidates[0] || null;
}

function applyMerge(merged, i, side) {
  if (side === 'left') {
    merged.splice(i - 1, 2, mergeAdjacentChunks(merged[i - 1], merged[i]));
  } else {
    merged.splice(i, 2, mergeAdjacentChunks(merged[i], merged[i + 1]));
  }
}

function mergeShortChunks(chunks, profile) {
  const activeProfile = profile || buildChunkProfile();
  const merged = chunks.map((chunk) => ({
    ...chunk,
    storyTitles: chunkTitles(chunk),
    storyCount: Number(chunk.storyCount || 1)
  }));

  // Forced pass: clips below the HARD minimum must merge with a neighbour,
  // even if the combined clip overshoots the target range — a standalone
  // fragment nobody will watch is worse than a slightly long clip.
  let changed = true;
  while (changed && merged.length > 1) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      if (chunkDuration(merged[i]) >= activeProfile.hardMinSec) continue;
      const candidate = pickMergeSide(merged, i);
      if (!candidate) continue;
      applyMerge(merged, i, candidate.side);
      changed = true;
      break;
    }
  }

  // Target pass: clips below the TARGET minimum merge into the adjacent clip
  // that produces the smaller combined duration, capped at maxCombined. This
  // also absorbs a short final tail.
  changed = true;
  while (changed && merged.length > 1) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      if (chunkDuration(merged[i]) >= activeProfile.targetMinSec) continue;
      const candidate = pickMergeSide(merged, i);
      if (!candidate || candidate.duration > activeProfile.maxCombinedDurationSec) continue;
      applyMerge(merged, i, candidate.side);
      changed = true;
      break;
    }
  }

  return merged;
}

function isChunkProfile(value) {
  return !!value && typeof value === 'object' && 'hardMaxSec' in value;
}

function buildStoryChunks(stories, transcriptSegments, options = {}) {
  const profile = isChunkProfile(options) ? options : buildChunkProfile(options);
  const chunks = [];
  for (const story of Array.isArray(stories) ? stories : []) {
    if (!Number.isFinite(story?.start) || !Number.isFinite(story?.end) || story.end <= story.start) continue;
    chunks.push(...splitLongStoryAtNaturalBoundaries(story, transcriptSegments, profile));
  }
  const normalized = chunks.map((chunk) => ({
    ...chunk,
    storyTitles: chunkTitles(chunk),
    storyCount: Number(chunk.storyCount || 1)
  }));
  const finalChunks = profile.mergeShortChunks ? mergeShortChunks(normalized, profile) : normalized;
  return finalChunks.map((chunk, index) => ({ ...chunk, index: index + 1 }));
}

/**
 * Whole-footage mode: turn the gaps BETWEEN the detected stories (plus the
 * head and tail of the recording) into standalone fill clips so the output
 * covers 100% of the source timeline. Existing story clips are untouched.
 * Gaps shorter than minGapSec are skipped (not worth a separate file).
 * Pure function.
 */
function fillTimelineGaps(stories, totalDuration, options = {}) {
  const minGapSec = Math.max(5, Number(options.minGapSec) || 30);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) return [];

  const spans = (Array.isArray(stories) ? stories : [])
    .map((story) => ({
      start: Math.max(0, Number(story?.start) || 0),
      end: Math.min(totalDuration, Number(story?.end) || 0)
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);

  const gaps = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start - cursor >= minGapSec) {
      gaps.push({ start: cursor, end: span.start });
    }
    cursor = Math.max(cursor, span.end);
  }
  if (totalDuration - cursor >= minGapSec) {
    gaps.push({ start: cursor, end: totalDuration });
  }

  return gaps.map((gap, index) => ({
    title: options.gapTitle || `Part ${index + 1}`,
    start: gap.start,
    end: gap.end,
    storyCount: 0
  }));
}

module.exports = {
  DEFAULT_TARGET_MIN_SEC,
  DEFAULT_TARGET_MAX_SEC,
  DEFAULT_HARD_MIN_SEC,
  DEFAULT_HARD_MAX_SEC,
  buildChunkProfile,
  buildStoryChunks,
  mergeShortChunks,
  splitLongStoryAtNaturalBoundaries,
  fillTimelineGaps
};
