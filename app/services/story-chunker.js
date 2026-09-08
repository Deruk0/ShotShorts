const TARGET_CHUNK_DURATION_SEC = 180;
const MIN_CHUNK_DURATION_SEC = 90;
const MAX_CHUNK_DURATION_SEC = 300;
const MAX_COMBINED_DURATION_SEC = MAX_CHUNK_DURATION_SEC + MIN_CHUNK_DURATION_SEC;

// Cinema mode: movie scenes are standalone viral clips. Short scenes stay as
// they are (no merging — merging would glue unrelated scenes together), while
// long scenes are split at natural boundaries into TikTok-sized parts.
const CINEMA_CHUNK_PROFILE = Object.freeze({
  targetChunkDurationSec: 45,
  minChunkDurationSec: 20,
  maxChunkDurationSec: 90,
  maxCombinedDurationSec: 90,
  mergeShortChunks: false
});

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function buildChunkProfile(options = {}) {
  const target = clampNumber(options.targetChunkDurationSec, 10, 3600, TARGET_CHUNK_DURATION_SEC);
  const min = clampNumber(options.minChunkDurationSec, 5, target, MIN_CHUNK_DURATION_SEC);
  const max = clampNumber(options.maxChunkDurationSec, min, 7200, MAX_CHUNK_DURATION_SEC);
  const maxCombined = clampNumber(options.maxCombinedDurationSec, max, 14400, max + min);
  return {
    targetChunkDurationSec: target,
    minChunkDurationSec: min,
    maxChunkDurationSec: max,
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
    if (segment.end < partStart + profile.minChunkDurationSec) continue;
    if (segment.end > latestEnd || segment.end >= storyEnd - 20) continue;
    const score = boundaryScore(segment, segments[i + 1], desiredEnd);
    if (!best || score < best.score) best = { end: segment.end, score };
  }
  return best?.end || null;
}

function splitLongStoryAtNaturalBoundaries(story, transcriptSegments, profile) {
  const duration = story.end - story.start;
  if (duration <= profile.maxChunkDurationSec) return [{ ...story, partIndex: null }];

  const segments = normalizeTranscriptSegments(transcriptSegments)
    .filter((segment) => segment.end > story.start && segment.start < story.end);
  const expectedParts = Math.max(2, Math.round(duration / profile.targetChunkDurationSec));
  const desiredPartDuration = duration / expectedParts;
  const chunks = [];
  let partStart = story.start;

  while (story.end - partStart > profile.maxChunkDurationSec) {
    const desiredEnd = Math.min(story.end, partStart + desiredPartDuration);
    const latestEnd = Math.min(story.end, partStart + profile.maxChunkDurationSec);
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

function mergeShortChunks(chunks, profile) {
  const activeProfile = profile || buildChunkProfile();
  const merged = chunks.map((chunk) => ({
    ...chunk,
    storyTitles: chunkTitles(chunk),
    storyCount: Number(chunk.storyCount || 1)
  }));

  // Repeatedly attach the shortest clip to the adjacent result that produces
  // the smaller combined duration. This also absorbs a short final tail.
  while (merged.length > 1) {
    let changed = false;
    for (let i = 0; i < merged.length; i++) {
      if (chunkDuration(merged[i]) >= activeProfile.minChunkDurationSec) continue;

      const candidates = [];
      if (i > 0) {
        const duration = merged[i].end - merged[i - 1].start;
        if (duration <= activeProfile.maxCombinedDurationSec) candidates.push({ side: 'left', duration });
      }
      if (i + 1 < merged.length) {
        const duration = merged[i + 1].end - merged[i].start;
        if (duration <= activeProfile.maxCombinedDurationSec) candidates.push({ side: 'right', duration });
      }
      if (!candidates.length) continue;

      candidates.sort((a, b) => a.duration - b.duration || (a.side === 'left' ? -1 : 1));
      if (candidates[0].side === 'left') {
        merged.splice(i - 1, 2, mergeAdjacentChunks(merged[i - 1], merged[i]));
      } else {
        merged.splice(i, 2, mergeAdjacentChunks(merged[i], merged[i + 1]));
      }
      changed = true;
      break;
    }
    if (!changed) break;
  }

  return merged;
}

function buildStoryChunks(stories, transcriptSegments, options = {}) {
  const profile = buildChunkProfile(options);
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
  TARGET_CHUNK_DURATION_SEC,
  MIN_CHUNK_DURATION_SEC,
  MAX_CHUNK_DURATION_SEC,
  MAX_COMBINED_DURATION_SEC,
  CINEMA_CHUNK_PROFILE,
  buildChunkProfile,
  buildStoryChunks,
  mergeShortChunks,
  splitLongStoryAtNaturalBoundaries,
  fillTimelineGaps
};
