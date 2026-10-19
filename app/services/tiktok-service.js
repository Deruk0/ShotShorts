const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const axios = require('axios');

const REDIRECT_URI = 'http://127.0.0.1:8902/callback/';
const API = 'https://open.tiktokapis.com/v2';
const ACTIVE = new Set(['UPLOADING', 'PROCESSING_UPLOAD', 'PROCESSING_DOWNLOAD', 'UPLOAD_INTERRUPTED']);

function chunkPlan(size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 4 * 1024 ** 3) throw new Error('invalid_video_size');
  const chunkSize = Math.min(size, 16 * 1024 ** 2);
  return { chunkSize, count: Math.max(1, Math.floor(size / chunkSize)) };
}

function postInfo(input, creator) {
  if (input?.consent !== true) throw new Error('consent_required');
  if (typeof input.title !== 'string' || input.title.length > 2200) throw new Error('invalid_caption');
  if (!creator.privacy_level_options?.includes(input.privacy)) throw new Error('privacy_level_option_mismatch');
  if (input.branded && input.privacy === 'SELF_ONLY') throw new Error('branded_content_cannot_be_private');
  if (input.commercial && !input.ownBrand && !input.branded) throw new Error('commercial_disclosure_required');
  if (!input.commercial && (input.ownBrand || input.branded)) throw new Error('commercial_disclosure_required');
  for (const key of ['comment', 'duet', 'stitch']) {
    if (input[key] && creator[`${key}_disabled`]) throw new Error(`${key}_disabled`);
  }
  return {
    title: input.title, privacy_level: input.privacy,
    disable_comment: input.comment !== true, disable_duet: input.duet !== true, disable_stitch: input.stitch !== true,
    brand_organic_toggle: input.ownBrand === true, brand_content_toggle: input.branded === true,
    is_aigc: input.aigc === true
  };
}

// TikTok desktop PKCE uses a hex SHA256 challenge, rather than base64url.
function authorizeDesktop(clientKey, openExternal, signal) {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(32).toString('hex');
    const verifier = crypto.randomBytes(48).toString('hex');
    let timer;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      server.close();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new Error('operation_cancelled'));
    const server = http.createServer((req, res) => {
      let url;
      try { url = new URL(req.url, REDIRECT_URI); }
      catch { res.writeHead(400).end('Invalid callback.'); return; }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET' || url.pathname !== '/callback/' || url.searchParams.get('state') !== state) {
        res.writeHead(400).end('Invalid callback.');
        return;
      }
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) {
        res.end('TikTok authorization was not completed. Return to ShotShorts.');
        finish(new Error('authorization_denied'));
        return;
      }
      res.end('Return to ShotShorts to finish connecting TikTok.');
      finish(null, { code, code_verifier: verifier, redirect_uri: REDIRECT_URI });
    });
    server.on('error', () => finish(new Error('oauth_callback_unavailable')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    timer = setTimeout(() => finish(new Error('authorization_timeout')), 180000);
    server.listen(8902, '127.0.0.1', () => {
      const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
      url.search = new URLSearchParams({ client_key: clientKey, response_type: 'code', scope: 'video.publish',
        redirect_uri: REDIRECT_URI, state, code_challenge: crypto.createHash('sha256').update(verifier).digest('hex'),
        code_challenge_method: 'S256' }).toString();
      Promise.resolve().then(() => openExternal(url.href)).catch(() => finish(new Error('browser_open_failed')));
    });
  });
}

function createSecureStorage(filePath, safeStorage) {
  const check = () => { if (!safeStorage.isEncryptionAvailable()) throw new Error('secure_storage_unavailable'); };
  return {
    async read() {
      check();
      try { return JSON.parse(safeStorage.decryptString(await fs.readFile(filePath))); }
      catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('credentials_unreadable'); }
    },
    async write(value) {
      check();
      const encrypted = safeStorage.encryptString(JSON.stringify(value));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(`${filePath}.tmp`, encrypted, { mode: 0o600 });
      await fs.rename(`${filePath}.tmp`, filePath);
    }
  };
}

function createTikTokService({ storage, probe, openExternal, request = axios, authorize = authorizeDesktop, onProgress = () => {} }) {
  let state;
  let loading;
  let controller;
  let refreshing;
  const load = async () => {
    if (!loading) loading = storage.read().then((value) => { state = value; });
    await loading;
    return state;
  };
  const save = () => storage.write(state);
  const snapshot = () => ({ clientKey: state.clientKey || '', hasSecret: !!state.clientSecret,
    connected: !!state.tokens, lastPost: state.lastPost || null, redirectUri: REDIRECT_URI });
  const run = async (work) => {
    if (controller) throw new Error('operation_in_progress');
    controller = new AbortController();
    try { await load(); return await work(controller.signal); }
    catch (error) { if (controller.signal.aborted) throw new Error('operation_cancelled'); throw error; }
    finally { controller = null; }
  };
  async function call(url, data, signal, token, form = false) {
    let response;
    try {
      response = await request({ method: 'POST', url: `${API}${url}`, data: form ? new URLSearchParams(data).toString() : data,
        headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal, timeout: 60000, maxRedirects: 0, validateStatus: () => true });
    } catch (error) {
      if (signal?.aborted) throw new Error('operation_cancelled');
      throw new Error('tiktok_network_error');
    }
    const body = response.data;
    const code = typeof body?.error === 'string' ? body.error : body?.error?.code;
    if (response.status < 200 || response.status >= 300 || (code && code !== 'ok')) {
      // Never pass Axios errors, request configuration or tokens to the renderer.
      throw new Error(/^[a-zA-Z0-9_]{1,100}$/.test(code || '') ? code : `tiktok_http_${response.status}`);
    }
    return form ? body : body?.data;
  }
  async function setTokens(tokens) {
    if (!tokens?.access_token || !tokens.refresh_token || !tokens.scope?.split(',').includes('video.publish')) {
      throw new Error('video_publish_scope_required');
    }
    state.tokens = { ...tokens, expiresAt: Date.now() + Number(tokens.expires_in) * 1000 };
    await save();
  }
  async function access(signal) {
    if (!state.tokens) throw new Error('account_not_connected');
    if (state.tokens.expiresAt > Date.now() + 60000) return state.tokens.access_token;
    if (!refreshing) {
      refreshing = call('/oauth/token/', { client_key: state.clientKey, client_secret: state.clientSecret,
        grant_type: 'refresh_token', refresh_token: state.tokens.refresh_token }, signal, null, true)
        .then(setTokens).finally(() => { refreshing = null; });
    }
    await refreshing;
    return state.tokens.access_token;
  }
  const creatorInfo = async (signal) => call('/post/publish/creator_info/query/', {}, signal, await access(signal));
  return {
    async state() { await load(); return snapshot(); },
    configure(input) { return run(async () => {
      const clientKey = String(input?.clientKey || '').trim();
      const clientSecret = String(input?.clientSecret || '').trim() || state.clientSecret;
      if (!clientKey || !clientSecret || clientKey.length > 256 || clientSecret.length > 512) throw new Error('credentials_required');
      if (clientKey !== state.clientKey || clientSecret !== state.clientSecret) {
        if (state.tokens) throw new Error('disconnect_before_configuring');
        state = { clientKey, clientSecret };
        await save();
      }
      return snapshot();
    }); },
    connect() { return run(async (signal) => {
      if (!state.clientKey || !state.clientSecret) throw new Error('credentials_required');
      const grant = await authorize(state.clientKey, openExternal, signal);
      const tokens = await call('/oauth/token/', { client_key: state.clientKey, client_secret: state.clientSecret,
        grant_type: 'authorization_code', ...grant }, signal, null, true);
      const oldId = state.tokens?.open_id;
      await setTokens(tokens);
      if (oldId !== tokens.open_id) { delete state.lastPost; await save(); }
      return { ...snapshot(), creator: await creatorInfo(signal) };
    }); },
    disconnect() { return run(async (signal) => {
      if (state.tokens) await call('/oauth/revoke/', { client_key: state.clientKey, client_secret: state.clientSecret,
        token: await access(signal) }, signal, null, true);
      delete state.tokens;
      delete state.lastPost;
      await save();
      return snapshot();
    }); },
    creator() { return run((signal) => creatorInfo(signal)); },
    publish(input) { return run(async (signal) => {
      if (ACTIVE.has(state.lastPost?.status)) throw new Error('post_pending_check_status');
      if (!input || typeof input.filePath !== 'string' || !path.isAbsolute(input.filePath)) throw new Error('invalid_video_file');
      const mime = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' }[path.extname(input.filePath).toLowerCase()];
      if (!mime) throw new Error('invalid_video_file');
      const file = await fs.open(input.filePath, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error('invalid_video_file');
        const plan = chunkPlan(stat.size);
        const creator = await creatorInfo(signal);
        const info = postInfo(input, creator);
        const media = await probe(input.filePath);
        if (!media.hasVideo || !Number.isFinite(media.duration) || media.duration < 3 ||
          media.duration > creator.max_video_post_duration_sec) throw new Error('invalid_video_duration');
        const token = await access(signal);
        const init = await call('/post/publish/video/init/', { post_info: info, source_info: {
          source: 'FILE_UPLOAD', video_size: stat.size, chunk_size: plan.chunkSize, total_chunk_count: plan.count
        } }, signal, token);
        if (!init?.publish_id || !init.upload_url) throw new Error('invalid_publish_response');
        const uploadUrl = new URL(init.upload_url);
        if (uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password) throw new Error('invalid_upload_url');
        state.lastPost = { publishId: init.publish_id, title: info.title, privacy: info.privacy_level,
          status: 'UPLOADING', createdAt: new Date().toISOString() };
        await save();
        try {
          for (let index = 0; index < plan.count; index++) {
            signal.throwIfAborted();
            const start = index * plan.chunkSize;
            const end = index === plan.count - 1 ? stat.size - 1 : start + plan.chunkSize - 1;
            const buffer = Buffer.alloc(end - start + 1);
            let read = 0;
            while (read < buffer.length) {
              const result = await file.read(buffer, read, buffer.length - read, start + read);
              if (!result.bytesRead) throw new Error('video_changed_during_upload');
              read += result.bytesRead;
            }
            let response;
            try {
              response = await request({ method: 'PUT', url: uploadUrl.href, data: buffer, signal, timeout: 180000,
                maxRedirects: 0, maxBodyLength: Infinity, validateStatus: () => true,
                headers: { 'Content-Type': mime, 'Content-Length': buffer.length, 'Content-Range': `bytes ${start}-${end}/${stat.size}` } });
            } catch { throw new Error('upload_interrupted_check_status'); }
            const expectedStatus = index === plan.count - 1 ? 201 : 206;
            if (response.status !== expectedStatus) throw new Error('upload_interrupted_check_status');
            onProgress({ percent: Math.round((end + 1) / stat.size * 100) });
          }
          state.lastPost.status = 'PROCESSING_UPLOAD';
          await save();
        } catch (error) {
          // Keep the publish ID: cancellation cannot retract an accepted TikTok post.
          state.lastPost.status = 'UPLOAD_INTERRUPTED';
          await save();
          throw error;
        }
        return state.lastPost;
      } finally { await file.close(); }
    }); },
    status() { return run(async (signal) => {
      if (!state.lastPost) return null;
      const result = await call('/post/publish/status/fetch/', { publish_id: state.lastPost.publishId }, signal, await access(signal));
      state.lastPost = { ...state.lastPost, status: result.status, failReason: result.fail_reason || '',
        postIds: (result.publicaly_available_post_id || []).map(String) };
      await save();
      return state.lastPost;
    }); },
    cancel() { controller?.abort(); }
  };
}

module.exports = { createTikTokService, createSecureStorage, authorizeDesktop, chunkPlan, postInfo, REDIRECT_URI };
