const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTikTokService, createSecureStorage, chunkPlan, postInfo, authorizeDesktop, REDIRECT_URI } = require('../app/services/tiktok-service');

const creator = { creator_nickname: 'Test', creator_username: 'test', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
  max_video_post_duration_sec: 60, comment_disabled: false, duet_disabled: true, stitch_disabled: false };
const input = { title: 'Описание #test', privacy: 'PUBLIC_TO_EVERYONE', consent: true };
const initial = () => ({ clientKey: 'key', clientSecret: 'secret', tokens: { access_token: 'token', refresh_token: 'refresh',
  open_id: 'creator', scope: 'video.publish', expiresAt: Date.now() + 3600000 } });

function harness(overrides = {}) {
  let saved = structuredClone(overrides.initial || initial());
  const calls = [];
  const service = createTikTokService({
    storage: { read: async () => structuredClone(saved), write: async (value) => { saved = structuredClone(value); } },
    probe: async () => ({ hasVideo: true, duration: 30 }),
    openExternal: async () => {},
    authorize: async () => ({ code: 'code', code_verifier: 'verifier', redirect_uri: REDIRECT_URI }),
    request: async (request) => {
      calls.push(request);
      if (overrides.request) return overrides.request(request);
      if (request.method === 'PUT') return { status: 201 };
      let data;
      if (request.url.endsWith('/creator_info/query/')) data = creator;
      else if (request.url.endsWith('/video/init/')) data = { publish_id: 'publish-1', upload_url: 'https://upload.tiktokapis.com/video/?token=private' };
      else if (request.url.endsWith('/status/fetch/')) data = { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['123'] };
      else throw new Error('Unexpected request');
      return { status: 200, data: { error: { code: 'ok' }, data } };
    }, ...overrides.dependencies
  });
  return { service, calls, saved: () => saved };
}

async function video(t, size = 1024) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shotshorts-tiktok-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.mp4');
  const handle = await fs.open(file, 'w');
  await handle.truncate(size); await handle.close();
  return file;
}

test('caption, disabled comments and disclosure map to Direct Post fields', () => {
  const result = postInfo(input, creator);
  assert.equal(result.title, input.title);
  assert.equal(result.disable_comment, true);
  assert.equal(result.disable_duet, true);
  assert.equal(postInfo({ ...input, comment: true, aigc: true }, creator).disable_comment, false);
  assert.equal(postInfo({ ...input, aigc: true }, creator).is_aigc, true);
});

test('consent, privacy, caption and account interaction restrictions are enforced', () => {
  assert.throws(() => postInfo({ ...input, consent: false }, creator), /consent_required/);
  assert.throws(() => postInfo({ ...input, privacy: '' }, creator), /privacy_level_option_mismatch/);
  assert.throws(() => postInfo({ ...input, title: 'a'.repeat(2201) }, creator), /invalid_caption/);
  assert.throws(() => postInfo({ ...input, duet: true }, creator), /duet_disabled/);
  assert.throws(() => postInfo({ ...input, commercial: true }, creator), /commercial_disclosure_required/);
  assert.throws(() => postInfo({ ...input, privacy: 'SELF_ONLY', commercial: true, branded: true }, creator), /branded_content_cannot_be_private/);
});

test('chunk plan covers small files, trailing bytes and the 4 GB limit', () => {
  for (const size of [1, 4 * 1024 ** 2, 16 * 1024 ** 2 + 1, 50_000_123, 4 * 1024 ** 3]) {
    const plan = chunkPlan(size);
    assert.equal(plan.count, Math.floor(size / plan.chunkSize));
    assert.ok(plan.count <= 1000);
    const lastSize = size - (plan.count - 1) * plan.chunkSize;
    assert.ok(lastSize <= 128 * 1024 ** 2);
  }
  assert.throws(() => chunkPlan(0));
  assert.throws(() => chunkPlan(4 * 1024 ** 3 + 1));
});

test('Direct Post uploads bytes without forwarding the bearer token, then checks status', async (t) => {
  const h = harness(); const filePath = await video(t);
  const post = await h.service.publish({ ...input, filePath });
  assert.equal(post.status, 'PROCESSING_UPLOAD');
  const init = h.calls.find((r) => r.url.endsWith('/video/init/'));
  assert.equal(init.data.post_info.title, input.title);
  assert.equal(init.data.post_info.disable_comment, true);
  assert.equal(init.headers.Authorization, 'Bearer token');
  const upload = h.calls.find((r) => r.method === 'PUT');
  assert.equal(upload.headers['Content-Range'], 'bytes 0-1023/1024');
  assert.equal(upload.headers.Authorization, undefined);
  assert.equal(upload.data.length, 1024);
  const status = await h.service.status();
  assert.equal(status.status, 'PUBLISH_COMPLETE');
  assert.deepEqual(status.postIds, ['123']);
  assert.equal(h.saved().lastPost.publishId, 'publish-1');
  const safe = await h.service.state();
  assert.equal(safe.clientSecret, undefined);
  assert.equal(safe.tokens, undefined);
});

test('oversize duration and missing consent never initiate an upload', async (t) => {
  const filePath = await video(t);
  const h = harness({ dependencies: { probe: async () => ({ hasVideo: true, duration: 61 }) } });
  await assert.rejects(h.service.publish({ ...input, filePath }), /invalid_video_duration/);
  assert.equal(h.calls.some((r) => r.url.endsWith('/video/init/')), false);
  const h2 = harness();
  await assert.rejects(h2.service.publish({ ...input, filePath, consent: false }), /consent_required/);
  assert.equal(h2.calls.some((r) => r.method === 'PUT'), false);
});

test('expired credentials refresh and persist the rotated refresh token', async () => {
  const old = initial(); old.tokens.expiresAt = 0;
  const h = harness({ initial: old, request: async (r) => {
    if (r.url.endsWith('/oauth/token/')) {
      assert.equal(new URLSearchParams(r.data).get('refresh_token'), 'refresh');
      return { status: 200, data: { access_token: 'new-token', refresh_token: 'new-refresh', scope: 'video.publish', expires_in: 86400 } };
    }
    assert.equal(r.headers.Authorization, 'Bearer new-token');
    return { status: 200, data: { data: creator, error: { code: 'ok' } } };
  } });
  await h.service.creator();
  assert.equal(h.saved().tokens.refresh_token, 'new-refresh');
});

test('TikTok errors survive HTTP 200 without leaking request credentials', async () => {
  const h = harness({ request: async () => ({ status: 200, data: { error: { code: 'unaudited_client_can_only_post_to_private_accounts', message: 'secret' } } }) });
  await assert.rejects(h.service.creator(), { message: 'unaudited_client_can_only_post_to_private_accounts' });
  const network = harness({ request: async () => { throw new Error('Bearer secret'); } });
  await assert.rejects(network.service.creator(), { message: 'tiktok_network_error' });
});

test('interrupted uploads retain their ID and prevent duplicate posting', async (t) => {
  const filePath = await video(t);
  const h = harness({ dependencies: { onProgress: () => { throw new Error('upload_interrupted_check_status'); } } });
  await assert.rejects(h.service.publish({ ...input, filePath }), /upload_interrupted/);
  assert.equal(h.saved().lastPost.status, 'UPLOAD_INTERRUPTED');
  assert.equal(h.saved().lastPost.publishId, 'publish-1');
  await assert.rejects(h.service.publish({ ...input, filePath }), /post_pending_check_status/);
  assert.equal((await h.service.status()).status, 'PUBLISH_COMPLETE');
});

test('restart recovers a pending post instead of starting a duplicate', async (t) => {
  const state = initial(); state.lastPost = { publishId: 'saved', status: 'UPLOADING' };
  const h = harness({ initial: state });
  await assert.rejects(h.service.publish({ ...input, filePath: await video(t) }), /post_pending_check_status/);
  assert.equal(h.calls.length, 0);
  await h.service.status();
  assert.equal(h.calls[0].data.publish_id, 'saved');
});

test('configuration cannot silently move a connected account to another client', async () => {
  const h = harness();
  await assert.rejects(h.service.configure({ clientKey: 'another', clientSecret: 'another' }), /disconnect_before_configuring/);
});

test('credentials are encrypted on disk and cannot fall back to plaintext', async (t) => {
  const file = await video(t);
  const credentialFile = path.join(path.dirname(file), 'credentials.enc');
  const crypto = require('node:crypto');
  const key = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: (text) => { const cipher = crypto.createCipheriv('aes-256-ctr', key, Buffer.alloc(16)); return Buffer.concat([cipher.update(text), cipher.final()]); },
    decryptString: (data) => { const cipher = crypto.createDecipheriv('aes-256-ctr', key, Buffer.alloc(16)); return Buffer.concat([cipher.update(data), cipher.final()]).toString(); } };
  const storage = createSecureStorage(credentialFile, safeStorage);
  assert.deepEqual(await storage.read(), {});
  await storage.write({ secret: 'never-plaintext' });
  assert.equal((await fs.readFile(credentialFile)).includes('never-plaintext'), false);
  assert.deepEqual(await storage.read(), { secret: 'never-plaintext' });
  const unavailable = createSecureStorage(credentialFile, { isEncryptionAvailable: () => false });
  await assert.rejects(unavailable.write({ secret: 'no' }), /secure_storage_unavailable/);
});

test('desktop OAuth validates state and passes the hex PKCE verifier', async () => {
  const crypto = require('node:crypto');
  const controller = new AbortController();
  let challenge;
  const grant = await authorizeDesktop('client-key', async (address) => {
    const auth = new URL(address);
    assert.equal(auth.searchParams.get('scope'), 'video.publish');
    assert.equal(auth.searchParams.get('redirect_uri'), REDIRECT_URI);
    challenge = auth.searchParams.get('code_challenge');
    const invalid = await fetch(`${REDIRECT_URI}?state=wrong&code=bad`);
    assert.equal(invalid.status, 400);
    const response = await fetch(`${REDIRECT_URI}?state=${auth.searchParams.get('state')}&code=valid`);
    assert.equal(response.status, 200);
  }, controller.signal);
  // The callback resolves before openExternal's final fetch completes.
  assert.equal(grant.code, 'valid');
  assert.equal(grant.code_verifier.length, 96);
  assert.equal(crypto.createHash('sha256').update(grant.code_verifier).digest('hex'), challenge);
});

test('sequential chunk uploads include trailing bytes in the final range', async (t) => {
  const size = 50_000_123;
  const filePath = await video(t, size);
  const ranges = [];
  const h = harness({ request: async (r) => {
    if (r.method === 'PUT') {
      ranges.push(r.headers['Content-Range']);
      assert.equal(r.data.length, Number(r.headers['Content-Length']));
      return { status: ranges.length === 2 ? 201 : 206 };
    }
    if (r.url.endsWith('/creator_info/query/')) return { status: 200, data: { data: creator } };
    assert.equal(r.data.source_info.total_chunk_count, 2);
    return { status: 200, data: { data: { publish_id: 'chunks', upload_url: 'https://upload.tiktokapis.com/video/' } } };
  } });
  await h.service.publish({ ...input, filePath });
  assert.deepEqual(ranges, ['bytes 0-16777215/50000123', 'bytes 16777216-50000122/50000123']);
});

test('cancel aborts an in-flight upload and keeps its ID for reconciliation', async (t) => {
  const filePath = await video(t);
  let started;
  const uploading = new Promise((resolve) => { started = resolve; });
  const h = harness({ request: async (r) => {
    if (r.method === 'PUT') {
      started();
      return new Promise((_resolve, reject) => r.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    if (r.url.endsWith('/creator_info/query/')) return { status: 200, data: { data: creator } };
    return { status: 200, data: { data: { publish_id: 'cancelled-upload', upload_url: 'https://upload.tiktokapis.com/video/' } } };
  } });
  const publishing = h.service.publish({ ...input, filePath });
  await uploading;
  h.service.cancel();
  await assert.rejects(publishing, /operation_cancelled/);
  assert.equal(h.saved().lastPost.publishId, 'cancelled-upload');
  assert.equal(h.saved().lastPost.status, 'UPLOAD_INTERRUPTED');
});

test('desktop authorization can be cancelled without leaving a callback listener', async () => {
  const controller = new AbortController();
  const grant = authorizeDesktop('client-key', async () => { controller.abort(); }, controller.signal);
  await assert.rejects(grant, /operation_cancelled/);
});
