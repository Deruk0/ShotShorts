const MAX_PRE_ROLL_SEC = 0.65;
const MAX_POST_ROLL_SEC = 0.85;
const MAX_ANCHOR_SNAP_SEC = 3;

function asDurationLimit(totalDuration, fallback) {
  return Number.isFinite(totalDuration) && totalDuration >= 0 ? totalDuration : fallback;
}

function normalizeSegments(transcriptSegments) {
  return (Array.isArray(transcriptSegments) ? transcriptSegments : [])
    .map((segment) => ({
      start: Math.max(0, Number(segment?.start) || 0),
      end: Math.max(0, Number(segment?.end) || 0),
      text: String(segment?.text || '').trim(),
      words: Array.isArray(segment?.words) ? segment.words : []
    }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function closestAnchor(segments, target, edge) {
  let best = target;
  let bestDistance = MAX_ANCHOR_SNAP_SEC + 0.001;
  for (const segment of segments) {
    const value = edge === 'end' ? segment.end : segment.start;
    const distance = Math.abs(value - target);
    if (distance < bestDistance) {
      best = value;
      bestDistance = distance;
    }
  }
  return best;
}

function flattenWordTimeline(segments) {
  const words = [];
  for (const segment of segments) {
    const timedWords = segment.words
      .map((word) => ({
        start: Number(word?.start),
        end: Number(word?.end)
      }))
      .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
    if (timedWords.length) words.push(...timedWords);
    else words.push({ start: segment.start, end: segment.end });
  }
  return words.sort((a, b) => a.start - b.start || a.end - b.end);
}

function silenceAround(words, anchor, edge) {
  if (edge === 'start') {
    let previousEnd = anchor;
    for (const word of words) {
      if (word.end <= anchor + 0.01) previousEnd = Math.min(anchor, word.end);
      else break;
    }
    return Math.max(0, anchor - previousEnd);
  }

  const next = words.find((word) => word.start >= anchor - 0.01);
  return next ? Math.max(0, next.start - anchor) : MAX_POST_ROLL_SEC;
}

function getNaturalStoryRange(story, transcriptSegments, totalDuration) {
  const detectedStart = Math.max(0, Number(story?.start) || 0);
  const detectedEnd = Math.max(detectedStart, Number(story?.end) || detectedStart);
  const durationLimit = asDurationLimit(totalDuration, detectedEnd + MAX_POST_ROLL_SEC);
  const segments = normalizeSegments(transcriptSegments);
  const words = flattenWordTimeline(segments);
  const anchorStart = closestAnchor(segments, detectedStart, 'start');
  const anchorEnd = closestAnchor(segments, detectedEnd, 'end');
  const silenceBefore = silenceAround(words, anchorStart, 'start');
  const silenceAfter = silenceAround(words, anchorEnd, 'end');
  const preRoll = Math.min(MAX_PRE_ROLL_SEC, silenceBefore > 0.04 ? silenceBefore * 0.5 : 0.08);
  const postRoll = Math.min(MAX_POST_ROLL_SEC, silenceAfter > 0.04 ? silenceAfter * 0.5 : 0.12);

  return {
    ...story,
    anchorStart,
    anchorEnd,
    start: Math.max(0, anchorStart - preRoll),
    end: Math.min(durationLimit, anchorEnd + postRoll)
  };
}

function alignStoriesToTranscript(stories, transcriptSegments, totalDuration) {
  const aligned = (Array.isArray(stories) ? stories : [])
    .map((story) => getNaturalStoryRange(story, transcriptSegments, totalDuration))
    .filter((story) => story.end > story.start)
    .sort((a, b) => a.anchorStart - b.anchorStart || a.anchorEnd - b.anchorEnd);

  // Padding must never pull the neighbouring story into the same clip.
  for (let i = 0; i + 1 < aligned.length; i++) {
    const current = aligned[i];
    const next = aligned[i + 1];
    if (current.end <= next.start) continue;
    const boundary = Math.max(
      current.anchorStart,
      Math.min(next.anchorEnd, (current.anchorEnd + next.anchorStart) / 2)
    );
    current.end = Math.max(current.start + 0.01, boundary);
    next.start = Math.min(next.end - 0.01, boundary);
  }

  return aligned.map(({ anchorStart, anchorEnd, ...story }) => story);
}

module.exports = {
  MAX_PRE_ROLL_SEC,
  MAX_POST_ROLL_SEC,
  getNaturalStoryRange,
  alignStoriesToTranscript
};
