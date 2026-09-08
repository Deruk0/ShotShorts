// Smoke test for the ETA estimator logic (extracted from renderer app.js).
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Extract the estimator source from app.js between markers and eval it in a sandbox.
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'app.js'), 'utf8');
const start = src.indexOf('// ===== SMART ETA ESTIMATOR =====');
const end = src.indexOf('function getSelectedKaraokeEffects()');
assert.ok(start > 0 && end > start, 'estimator block found');
const block = src.slice(start, end);

const factory = new Function(`${block}; return { createEtaEstimator, STAGE_ORDER, EtaHistory };`);
const { createEtaEstimator, STAGE_ORDER, EtaHistory } = factory();

// ---- Test 1: percent creeps during percent-less LLM waits, stays monotonic ----
{
  let now = 1_000_000;
  const est = createEtaEstimator({}, { now: () => now });
  est.onEvent({ stage: 'extract', stagePercent: 0, meta: { sourceDurationSec: 600 } });
  now += 2000;
  est.onEvent({ stage: 'transcribe', stagePercent: null });
  now += 30000;
  const snap = est.tick(now);
  assert.ok(snap.percent > 5 && snap.percent < 40, `percent should creep while waiting, got ${snap.percent}`);
  assert.ok(snap.etaMs > 0, 'eta should exist');
  now += 5000;
  const snap2 = est.tick(now);
  assert.ok(snap2.percent >= snap.percent, 'percent monotonic');
}

// ---- Test 2: percent-driven stage + upload speed ----
{
  let now = 1_000_000;
  const est = createEtaEstimator({}, { now: () => now });
  est.onEvent({ stage: 'extract', stagePercent: 0 });
  now += 1000;
  est.onEvent({ stage: 'transcribe', stagePercent: 50, upload: { loaded: 1_000_000, total: 4_000_000, bps: 1_500_000, ts: now } });
  now += 500;
  est.onEvent({ stage: 'transcribe', stagePercent: 55, upload: { loaded: 2_000_000, total: 4_000_000, bps: 1_500_000, ts: now } });
  now += 3500;
  const snap = est.tick(now);
  assert.ok(snap.percent > 5 && snap.percent < 40, `percent plausible, got ${snap.percent}`);
  assert.ok(snap.speedBps > 0, 'speed shown during upload');
  assert.ok(snap.etaMs > 0 && snap.etaMs < 10 * 60 * 1000, `eta plausible, got ${snap.etaMs}`);
}

// ---- Test 3: history prior keeps ETA modest for known fast runs ----
{
  let now = 1_000_000;
  const prior = {
    render: { totalMs: 10000, perMinMs: 0, perChunkMs: 5000, samples: 5 },
    transcribe: { totalMs: 20000, perMinMs: 4000, perChunkMs: 0, samples: 5 }
  };
  const est = createEtaEstimator(prior, { now: () => now });
  est.onEvent({ stage: 'extract', stagePercent: 0, meta: { sourceDurationSec: 60 } });
  now += 1000;
  est.onEvent({ stage: 'transcribe', stagePercent: null });
  now += 1000;
  const snap = est.tick(now);
  // Unknown stages still use conservative defaults, but learned transcribe
  // (4s/min × 1min) and render priors must keep the estimate well under the
  // ~5min sum of all defaults.
  assert.ok(snap.etaMs < 180000, `prior-based eta should be modest, got ${snap.etaMs}`);
}

// ---- Test 4: EtaHistory EMA + per-chunk record ----
{
  const store = {};
  EtaHistory.record(store, 'render', 30000, 0, 3);
  assert.strictEqual(store.render.perChunkMs, 10000);
  EtaHistory.record(store, 'render', 60000, 0, 3);
  assert.strictEqual(store.render.perChunkMs, Math.round(20000 * 0.6 + 10000 * 0.4));
  assert.strictEqual(store.render.samples, 2);
}

// ---- Test 5: stalled detection after long silence ----
{
  let now = 1_000_000;
  const est = createEtaEstimator({}, { now: () => now });
  est.onEvent({ stage: 'extract', stagePercent: 0 });
  now += 60000;
  const snap = est.tick(now);
  assert.strictEqual(snap.stalled, true);
  assert.strictEqual(snap.etaMs, null);
}

// Advance the monotonic ease with a burst of short ticks (as the real 1s
// interval would), keeping the run "alive".
function ease(est, fromNow, seconds) {
  let t = fromNow;
  for (let i = 0; i < seconds; i++) { t += 1000; est.tick(t); }
  return t;
}

// ---- Test 6: chunked render is monotonic across chunk resets ----
{
  let now = 1_000_000;
  const est = createEtaEstimator({}, { now: () => now });
  est.onEvent({ stage: 'render', chunkIndex: 1, chunkCount: 3, stagePercent: 0, meta: { sourceDurationSec: 600 } });
  now += 2000;
  est.onEvent({ stage: 'render', chunkIndex: 1, chunkCount: 3, stagePercent: 100 });
  now = ease(est, now, 12);
  const p1 = est.tick(now).percent;
  assert.ok(p1 > 8 && p1 < 15, `chunk 1 done plausible, got ${p1}`);
  now += 5000;
  est.onEvent({ stage: 'render', chunkIndex: 2, chunkCount: 3, stagePercent: 0 });
  now = ease(est, now, 5);
  const p2 = est.tick(now).percent;
  assert.ok(p2 >= p1 - 0.001, `no regress on chunk switch, got ${p2} vs ${p1}`);
  now += 8000;
  est.onEvent({ stage: 'render', chunkIndex: 2, chunkCount: 3, stagePercent: 100 });
  now += 2000;
  est.onEvent({ stage: 'render', chunkIndex: 3, chunkCount: 3, stagePercent: 0 });
  now += 6000;
  est.onEvent({ stage: 'render', chunkIndex: 3, chunkCount: 3, stagePercent: 90 });
  now = ease(est, now, 12);
  const p3 = est.tick(now).percent;
  assert.ok(p3 > 20 && p3 < 50, `chunk 3 @90% plausible, got ${p3}`);
}

// ---- Test 7: percent resets between transcribe chunks don't regress the bar ----
{
  let now = 1_000_000;
  const est = createEtaEstimator({}, { now: () => now });
  est.onEvent({ stage: 'transcribe', stagePercent: 0, chunkIndex: 1, chunkCount: 2, meta: { sourceDurationSec: 1200 } });
  now += 30000;
  est.onEvent({ stage: 'transcribe', stagePercent: 85, chunkIndex: 1, chunkCount: 2 });
  const p1 = est.tick(now).percent;
  now += 40000;
  est.onEvent({ stage: 'transcribe', stagePercent: 0, chunkIndex: 2, chunkCount: 2 });
  const p2 = est.tick(now).percent;
  assert.ok(p2 >= p1 - 0.001, `no regress between transcribe chunks, got ${p2} vs ${p1}`);
  now += 60000;
  est.onEvent({ stage: 'transcribe', stagePercent: 95, chunkIndex: 2, chunkCount: 2 });
  const p3 = est.tick(now).percent;
  assert.ok(p3 > p2, 'transcribe continues');
}

console.log('ETA estimator smoke tests passed');
