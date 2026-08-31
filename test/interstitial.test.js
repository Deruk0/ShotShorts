const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planInterstitialSegments,
  buildInterstitialFilterGraph
} = require('../app/services/banner-utils');

test('planInterstitialSegments places windows after every full interval', () => {
  // 90s clip, banner every 60s for 5s -> one window at 60..65 (content time).
  // The content resumes from where it froze, so the last play is [60..90].
  const plan = planInterstitialSegments(90, 60, 5);
  const windows = plan.segments.filter((s) => s.type === 'window');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].start, 60);
  assert.equal(windows[0].duration, 5);
  assert.equal(plan.totalWindowSec, 5);
  // plays: [0..60] and [60..90] (content resumes from the frozen point)
  const plays = plan.segments.filter((s) => s.type === 'play');
  assert.deepEqual(plays.map((p) => [p.start, p.end]), [[0, 60], [60, 90]]);
});

test('planInterstitialSegments never schedules a window at t=0 or past the clip end', () => {
  const plan = planInterstitialSegments(120, 60, 5);
  assert.ok(plan.segments.every((s) => s.type !== 'window' || s.start >= 60));
  // A window at t=120 in a 120s clip would have zero length — skipped.
  assert.equal(plan.segments.filter((s) => s.type === 'window').length, 1);
  // A 125s clip does fit two full windows.
  const plan2 = planInterstitialSegments(125, 60, 5);
  assert.equal(plan2.segments.filter((s) => s.type === 'window').length, 2);
});

test('planInterstitialSegments trims the last window to the clip end', () => {
  const plan = planInterstitialSegments(62, 60, 5);
  const windows = plan.segments.filter((s) => s.type === 'window');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].duration, 2); // 62 - 60
});

test('planInterstitialSegments skips short clips and bad input', () => {
  assert.deepEqual(planInterstitialSegments(50, 60, 5).segments, []);
  assert.deepEqual(planInterstitialSegments(0, 60, 5).segments, []);
  assert.deepEqual(planInterstitialSegments(120, 0, 5).segments, []);
});

test('planInterstitialSegments uses the banner duration for the pause length', () => {
  // A long banner (90s) pauses the whole remaining clip; trimmed at clip end.
  const plan = planInterstitialSegments(100, 40, 90);
  const windows = plan.segments.filter((s) => s.type === 'window');
  assert.ok(windows.length >= 1);
  // No 30s cap anymore: window durations follow the banner length.
  assert.ok(windows.every((w) => w.duration <= 90));
  // Window trimmed to the clip end: window at 40 lasts min(90, 60) = 60.
  assert.equal(windows[0].duration, 60);
  assert.equal(plan.totalWindowSec, windows.reduce((sum, w) => sum + w.duration, 0));
});

test('buildInterstitialFilterGraph forks shared sources and gives each window its own banner input', () => {
  const plan = planInterstitialSegments(90, 60, 5);
  const graph = buildInterstitialFilterGraph({
    baseLabel: 'vconcat',
    bannerIndexBase: 2,
    audioInputIndex: 1,
    bannerHasAudio: true,
    layout: { x: 390, y: 885, width: 300, height: 150 },
    opacity: 1,
    segments: plan.segments
  });

  const videoOut = graph.filters.find((f) => f.endsWith('[ivout]'));
  const audioOut = graph.filters.find((f) => f.endsWith('[iall]'));
  assert.equal(videoOut, '[iseg0][iseg1][iseg2]concat=n=3:v=1:a=0[ivout]');
  assert.equal(audioOut, '[isega0][isega1][isega2]concat=n=3:v=0:a=1[iall]');

  // Base video forked once per segment (2 plays + 1 window).
  assert.ok(graph.filters.includes('[vconcat]split=3[vbr0][vbr1][vbr2]'));
  assert.ok(graph.filters.includes('[vbr0]trim=start=0:end=60,setpts=PTS-STARTPTS[iseg0]'));
  assert.ok(graph.filters.includes('[vbr1]trim=start=60:duration=0.0333,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=5,trim=end=5,setpts=PTS-STARTPTS[ifr1]'));
  // Main audio forked once per play segment.
  assert.ok(graph.filters.includes('[1:a]asplit=2[mabr0][mabr1]'));
  assert.ok(graph.filters.includes('[mabr0]atrim=start=0:end=60,asetpts=N/SR/TB,aformat=sample_rates=44100:channel_layouts=stereo[isega0]'));
  // The window reads its own dedicated banner demuxer (index = base + windowIdx).
  assert.ok(graph.filters.includes('[2:v]fps=30,scale=300:150:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=5,trim=end=5,setpts=PTS-STARTPTS[ibn1]'));
  assert.ok(graph.filters.includes('[2:a]atrim=end=5,asetpts=N/SR/TB,apad=whole_dur=5,aformat=sample_rates=44100:channel_layouts=stereo[isega1]'));
  assert.ok(graph.filters.some((f) => f.includes('overlay=390:885') && f.includes('[iseg1]')));
});

test('buildInterstitialFilterGraph maps each window to its own banner input', () => {
  const plan = planInterstitialSegments(240, 60, 5);
  const graph = buildInterstitialFilterGraph({
    baseLabel: 'vconcat',
    bannerIndexBase: 2,
    audioInputIndex: 1,
    bannerHasAudio: true,
    layout: { x: 0, y: 0, width: 300, height: 150 },
    segments: plan.segments
  });
  const windows = plan.segments.filter((s) => s.type === 'window');
  assert.equal(windows.length, 3);
  // Window k reads banner input base+k (video and audio), no split anywhere.
  assert.ok(graph.filters.includes('[2:v]fps=30,scale=300:150:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=5,trim=end=5,setpts=PTS-STARTPTS[ibn1]'));
  assert.ok(graph.filters.includes('[3:v]fps=30,scale=300:150:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=5,trim=end=5,setpts=PTS-STARTPTS[ibn3]'));
  assert.ok(graph.filters.includes('[4:v]fps=30,scale=300:150:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=5,trim=end=5,setpts=PTS-STARTPTS[ibn5]'));
  assert.ok(graph.filters.includes('[2:a]atrim=end=5,asetpts=N/SR/TB,apad=whole_dur=5,aformat=sample_rates=44100:channel_layouts=stereo[isega1]'));
  assert.ok(graph.filters.includes('[3:a]atrim=end=5,asetpts=N/SR/TB,apad=whole_dur=5,aformat=sample_rates=44100:channel_layouts=stereo[isega3]'));
  assert.ok(graph.filters.includes('[4:a]atrim=end=5,asetpts=N/SR/TB,apad=whole_dur=5,aformat=sample_rates=44100:channel_layouts=stereo[isega5]'));
  // The banner itself is never split — each window owns a dedicated demuxer.
  assert.ok(!graph.filters.some((f) => f.includes('bwbr') || f.includes('babr')));
});

test('buildInterstitialFilterGraph uses silence when the banner has no audio', () => {
  const plan = planInterstitialSegments(90, 60, 5);
  const graph = buildInterstitialFilterGraph({
    bannerIndex: 2,
    audioInputIndex: 1,
    bannerHasAudio: false,
    layout: { x: 0, y: 0, width: 300, height: 150 },
    segments: plan.segments
  });
  assert.ok(graph.filters.some((f) => f.startsWith('anullsrc=r=44100:cl=stereo') && f.includes('[isega1]')));
  assert.ok(!graph.filters.some((f) => f.startsWith('[2:a]')));
});

test('buildInterstitialFilterGraph fades the banner when opacity < 1', () => {
  const plan = planInterstitialSegments(90, 60, 5);
  const graph = buildInterstitialFilterGraph({
    bannerIndex: 2,
    audioInputIndex: 1,
    bannerHasAudio: true,
    layout: { x: 0, y: 0, width: 300, height: 150 },
    opacity: 0.5,
    segments: plan.segments
  });
  assert.ok(graph.filters.some((f) => f.includes('colorchannelmixer=aa=0.5') && f.includes('[ibn1]')));
});
