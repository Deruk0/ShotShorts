// test logic isolated from process-handler.js

const segments = [
    { index: 1, title: 'Story 1', start: 0, end: 40 },
    { index: 2, title: 'Story 2', start: 40, end: 90 },
    { index: 3, title: 'Story 3', start: 90, end: 120 },
    { index: 4, title: 'Story 4', start: 120, end: 150 },
    { index: 5, title: 'Story Long', start: 150, end: 600 },
    { index: 6, title: 'Story Tiny', start: 600, end: 610 }
];

const MIN_DUR = 180; // 3 minutes
const MAX_DUR = 240; // 4 minutes

const finalEnd = segments[segments.length - 1].end;
const chunks = [];
let currentStart = segments[0].start;

while (currentStart < finalEnd) {
    const primarySeg = segments.find(s => s.end > currentStart && s.start <= currentStart) || segments[0];
    
    let minAllowedEnd = Math.min(finalEnd, currentStart + MIN_DUR);
    let maxAllowedEnd = Math.min(finalEnd, currentStart + MAX_DUR);
    
    // Handle tail end
    if (finalEnd - currentStart < MIN_DUR) {
        if (chunks.length > 0) {
        const prev = chunks[chunks.length - 1];
        if ((prev.end - prev.start) + (finalEnd - currentStart) <= MAX_DUR) {
            prev.end = finalEnd;
        } else {
            chunks.push({ ...primarySeg, start: currentStart, end: finalEnd, partIndex: null });
        }
        } else {
        chunks.push({ ...primarySeg, start: currentStart, end: finalEnd, partIndex: null });
        }
        break;
    }
    
    // Find valid story boundaries in allowed range
    let validBoundaries = segments.map(s => s.end).filter(b => b >= minAllowedEnd && b <= maxAllowedEnd);
    let cutPoint;
    
    if (validBoundaries.length > 0) {
        // Cut at a random valid story boundary
        cutPoint = validBoundaries[Math.floor(Math.random() * validBoundaries.length)];
    } else {
        // If no story boundary, cut randomly between 2-4 min
        if (maxAllowedEnd === finalEnd) {
        cutPoint = finalEnd;
        } else {
        cutPoint = currentStart + MIN_DUR + Math.random() * (MAX_DUR - MIN_DUR);
        }
    }
    
    chunks.push({ ...primarySeg, start: currentStart, end: cutPoint, partIndex: null });
    currentStart = cutPoint;
}

const titleCounts = {};
chunks.forEach(c => titleCounts[c.title] = (titleCounts[c.title] || 0) + 1);
const titleCurrent = {};
chunks.forEach((c, index) => {
    c.index = index + 1;
    if (titleCounts[c.title] > 1) {
    titleCurrent[c.title] = (titleCurrent[c.title] || 0) + 1;
    c.partIndex = titleCurrent[c.title];
    }
});

chunks.forEach(c => {
    console.log(`Chunk ${c.index} (${c.title}): start=${c.start.toFixed(2)}, end=${c.end.toFixed(2)}, duration=${(c.end - c.start).toFixed(2)}, part=${c.partIndex}`);
});
