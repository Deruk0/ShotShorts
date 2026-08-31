const TARGET_CHUNK_DURATION_SEC = 180;
const MIN_CHUNK_DURATION_SEC = 90;
const MAX_CHUNK_DURATION_SEC = 300;
const MAX_COMBINED_DURATION_SEC = MAX_CHUNK_DURATION_SEC + MIN_CHUNK_DURATION_SEC;

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

function findNaturalCut(segments, partStart, desiredEnd, latestEnd, storyEnd) {
  let best = null;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.end < partStart + MIN_CHUNK_DURATION_SEC) continue;
    if (segment.end > latestEnd || segment.end >= storyEnd - 20) continue;
    const score = boundaryScore(segment, segments[i + 1], desiredEnd);
    if (!best || score < best.score) best = { end: segment.end, score };
  }
  return best?.end || null;
}

function splitLongStoryAtNaturalBoundaries(story, transcriptSegments) {
  const duration = story.end - story.start;
  if (duration <= MAX_CHUNK_DURATION_SEC) return [{ ...story, partIndex: null }];

  const segments = normalizeTranscriptSegments(transcriptSegments)
    .filter((segment) => segment.end > story.start && segment.start < story.end);
  const expectedParts = Math.max(2, Math.round(duration / TARGET_CHUNK_DURATION_SEC));
  const desiredPartDuration = duration / expectedParts;
  const chunks = [];
  let partStart = story.start;

  while (story.end - partStart > MAX_CHUNK_DURATION_SEC) {
    const desiredEnd = Math.min(story.end, partStart + desiredPartDuration);
    const latestEnd = Math.min(story.end, partStart + MAX_CHUNK_DURATION_SEC);
    const cut = findNaturalCut(segments, partStart, desiredEnd, latestEnd, story.end);
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

function mergeShortChunks(chunks) {
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
      if (chunkDuration(merged[i]) >= MIN_CHUNK_DURATION_SEC) continue;

      const candidates = [];
      if (i > 0) {
        const duration = merged[i].end - merged[i - 1].start;
        if (duration <= MAX_COMBINED_DURATION_SEC) candidates.push({ side: 'left', duration });
      }
      if (i + 1 < merged.length) {
        const duration = merged[i + 1].end - merged[i].start;
        if (duration <= MAX_COMBINED_DURATION_SEC) candidates.push({ side: 'right', duration });
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

function buildStoryChunks(stories, transcriptSegments) {
  const chunks = [];
  for (const story of Array.isArray(stories) ? stories : []) {
    if (!Number.isFinite(story?.start) || !Number.isFinite(story?.end) || story.end <= story.start) continue;
    chunks.push(...splitLongStoryAtNaturalBoundaries(story, transcriptSegments));
  }
  return mergeShortChunks(chunks).map((chunk, index) => ({ ...chunk, index: index + 1 }));
}

module.exports = {
  TARGET_CHUNK_DURATION_SEC,
  MIN_CHUNK_DURATION_SEC,
  MAX_CHUNK_DURATION_SEC,
  MAX_COMBINED_DURATION_SEC,
  buildStoryChunks,
  mergeShortChunks,
  splitLongStoryAtNaturalBoundaries
};
