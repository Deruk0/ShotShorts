/**
 * WhisperService — transcription via Groq API (whisper-large-v3).
 *
 * Strategy:
 *  • Sends audio to Groq's Whisper endpoint — no local Python/PyTorch needed.
 *  • Outputs per-segment timed text, converts to ASS/SRT subtitle format.
 *  • Supports word-level timestamps for karaoke mode.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { normalizeGroqApiKeys, pickAvailableGroqKey, setGroqKeyCooldown } = require('./groq-key-utils');
const { abortableSleep, isAbortError, onAbort, runFfmpegCommand, throwIfAborted } = require('./cancellation');

// ---------------------------------------------------------------------------
// ASS style presets
// ---------------------------------------------------------------------------
const ASS_STYLES = {
  Classic: {
    fontName: 'Arial',
    fontSize: 20,
    primaryColour: '&H00FFFFFF',
    outlineColour: '&H00000000',
    backColour: '&H80000000',
    bold: 1,
    outline: 3,
    shadow: 2,
    alignment: 2,
    marginV: 40,
    marginH: 40,
    BorderStyle: 1
  },
  Minimal: {
    fontName: 'Arial',
    fontSize: 18,
    primaryColour: '&H00E5E7EB',
    outlineColour: '&H00000000',
    backColour: '&H00000000',
    bold: 0,
    outline: 1.5,
    shadow: 1.5,
    alignment: 2,
    marginV: 30,
    marginH: 40,
    BorderStyle: 1
  },
  Highlight: {
    fontName: 'Arial Black',
    fontSize: 22,
    primaryColour: '&H0066E0FF',
    outlineColour: '&H00000000',
    backColour: '&H80000000',
    bold: 1,
    outline: 3.5,
    shadow: 3,
    alignment: 2,
    marginV: 40,
    marginH: 40,
    BorderStyle: 1
  },
  TikTokBold: {
    fontName: 'Arial Black',
    fontSize: 24,
    primaryColour: '&H00FFFFFF',
    outlineColour: '&H00000000',
    backColour: '&H00000000',
    bold: 1,
    outline: 5,
    shadow: 5,
    alignment: 2,
    marginV: 44,
    marginH: 40,
    BorderStyle: 1
  },
  HeavyShadow: {
    fontName: 'Arial Black',
    fontSize: 24,
    primaryColour: '&H00FFFFFF',
    outlineColour: '&H00000000',
    backColour: '&H00000000',
    bold: 1,
    outline: 5,
    shadow: 8,
    alignment: 2,
    marginV: 44,
    marginH: 40,
    BorderStyle: 1
  },
  SoftBox: {
    fontName: 'Arial',
    fontSize: 20,
    primaryColour: '&H00F2F2F2',
    outlineColour: '&H30FFFFFF',
    backColour: '&H7A000000',
    bold: 1,
    outline: 2,
    shadow: 1.5,
    alignment: 2,
    marginV: 40,
    marginH: 40,
    BorderStyle: 3
  }
};

const GROQ_MODELS = {
  'whisper-large-v3': 'Whisper Large v3',
  'whisper-large-v3-turbo': 'Whisper Large v3 Turbo'
};

const MAX_DIRECT_UPLOAD_BYTES = 4 * 1024 * 1024;
const MIN_CHUNK_DURATION_SEC = 60;
const MAX_CHUNK_DURATION_SEC = 4 * 60;
const MAX_RATE_LIMIT_RETRIES = 8;
const DEFAULT_RATE_LIMIT_DELAY_MS = 30000;

const groqTranscriptionKeyCooldowns = new Map();
const groqTranscriptionKeyCursor = { current: 0 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function seconds2ass(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s.toFixed(2)).padStart(5, '0')}`;
}

function seconds2srt(t) {
  const safe = Math.max(0, Number(t) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function escapeAssText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function buildFallbackTimedWords(seg) {
  const textWords = String(seg?.text || '')
    .replace(/\r?\n/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!textWords.length) return [];

  const segStart = Math.max(0, Number(seg?.start) || 0);
  const segEndRaw = Number(seg?.end);
  const segEnd = Number.isFinite(segEndRaw) ? Math.max(segStart + 0.2, segEndRaw) : (segStart + 0.2);
  const total = Math.max(0.2, segEnd - segStart);
  const step = total / textWords.length;

  return textWords.map((word, i) => {
    const start = segStart + step * i;
    const end = i === textWords.length - 1 ? segEnd : (segStart + step * (i + 1));
    return { word, start, end };
  });
}

function applyCaseToText(text, caseName = 'sentence') {
  const value = String(text || '');
  if (caseName === 'uppercase') return value.toUpperCase();
  if (caseName === 'lowercase') return value.toLowerCase();
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildAssKaraokeLine(words, activeIndex, karaokeEffects, styleName, caseName, baseColour) {
  const highlightColour = '&H0000D4FF&';
  const safeBaseColour = String(baseColour || '&H00FFFFFF&');

  const normalized = words.map((w) => applyCaseToText(String(w || '').trim(), caseName)).filter(Boolean);
  return normalized.map((word, i) => {
    let rendered = word;
    if (i === activeIndex) {
      if (karaokeEffects.has('caps') && caseName !== 'uppercase') {
        rendered = rendered.toUpperCase();
      }
      const tags = [karaokeEffects.has('box') ? '\\rKaraokeBox' : '\\rDefault'];
      if (karaokeEffects.has('highlight')) {
        tags.push(`\\1c${highlightColour}`);
      } else {
        tags.push(`\\1c${safeBaseColour}`);
      }
      if (!tags.length) tags.push(`\\c${highlightColour}`);
      return `{${tags.join('')}}${escapeAssText(rendered)}{\\rDefault}`;
    }
    return escapeAssText(rendered);
  }).join(' ');
}

// ---------------------------------------------------------------------------
// Build proxy agent for Groq requests
// ---------------------------------------------------------------------------
function buildProxyAgent(proxy) {
  if (!proxy || !proxy.host) return null;
  const { type = 'http', host, port, username, password } = proxy;
  const cleanHost = host.replace(/^(https?|socks\d?):\/\//i, '');
  const encUser = username ? encodeURIComponent(String(username)) : '';
  const encPass = password ? encodeURIComponent(String(password)) : '';

  if (type === 'socks5') {
    const url = username
      ? `socks5://${encUser}:${encPass}@${cleanHost}:${port}`
      : `socks5://${cleanHost}:${port}`;
    return new SocksProxyAgent(url);
  }
  const proto = type === 'https' ? 'https' : 'http';
  const url = username
    ? `${proto}://${encUser}:${encPass}@${cleanHost}:${port}`
    : `${proto}://${cleanHost}:${port}`;
  return new HttpsProxyAgent(url);
}

// ---------------------------------------------------------------------------
// Groq API request helper
// ---------------------------------------------------------------------------
async function groqRequest(apiKey, audioPath, model, language, proxy, signal) {
  throwIfAborted(signal);
  const FormData = require('form-data');
  const form = new FormData();
  const ext = path.extname(audioPath).toLowerCase();
  const contentType = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';
  const fileSize = fs.statSync(audioPath).size;
  const fileStream = fs.createReadStream(audioPath);
  const cleanupAbort = onAbort(signal, () => {
    fileStream.destroy();
  });

  form.append('file', fileStream, {
    filename: path.basename(audioPath),
    contentType
  });
  form.append('model', model);
  form.append('language', language);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');

  const contentLength = await new Promise((resolve, reject) => {
    form.getLength((err, length) => {
      if (err) return reject(err);
      resolve(length);
    });
  });

  const config = {
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': String(contentLength)
    },
    timeout: 300000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true,
    signal
  };

  const agent = buildProxyAgent(proxy);
  if (agent) {
    config.httpsAgent = agent;
    console.log(`[Groq] Using proxy: ${proxy.type}://${proxy.host}:${proxy.port}`);
  } else {
    console.log(`[Groq] No proxy configured, going direct. Proxy data:`, JSON.stringify(proxy));
  }

  let response;
  try {
    response = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      config
    );
  } finally {
    cleanupAbort();
  }

  if (response.status >= 200 && response.status < 300) {
    return response.data;
  }

  const serverHint = response.headers?.server || response.headers?.via || 'unknown';
  const bodyText = typeof response.data === 'string'
    ? response.data
    : JSON.stringify(response.data || {});
  const err = new Error(`Groq transcription failed with status ${response.status}. Upload bytes=${contentLength}, audio bytes=${fileSize}, server=${serverHint}, body=${bodyText.slice(0, 400)}`);
  err.response = response;
  throw err;
}

// Transient network/server errors worth retrying (socket resets, timeouts,
// DNS hiccups, and 5xx / 429 from the API).
function isRetryableNetworkError(err) {
  const code = err?.code || err?.cause?.code;
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH'].includes(code)) {
    return true;
  }
  if (err?.message && /socket hang up|network|timeout/i.test(err.message)) {
    return true;
  }
  const status = err?.response?.status;
  if (status === 429 || (status >= 500 && status <= 599)) {
    return true;
  }
  return false;
}

function isPayloadTooLargeError(err) {
  return err?.response?.status === 413;
}

function isRateLimitError(err) {
  return err?.response?.status === 429;
}

function parseDurationMs(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return Math.max(0, Math.ceil(numeric * 1000));
  }

  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  let totalMs = 0;
  const unitPattern = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds|ms|millisecond|milliseconds)\b/gi;
  for (const match of raw.matchAll(unitPattern)) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(amount)) continue;
    if (unit.startsWith('h')) totalMs += amount * 60 * 60 * 1000;
    else if (unit === 'm' || unit.startsWith('min')) totalMs += amount * 60 * 1000;
    else if (unit === 'ms' || unit.startsWith('milli')) totalMs += amount;
    else totalMs += amount * 1000;
  }

  return totalMs > 0 ? Math.ceil(totalMs) : null;
}

function getErrorText(err) {
  const data = err?.response?.data;
  if (!data) return err?.message || '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function getRateLimitDelayMs(err, fallbackMs = DEFAULT_RATE_LIMIT_DELAY_MS) {
  const headers = err?.response?.headers || {};
  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  const headerDelay = parseDurationMs(retryAfter);
  if (headerDelay !== null) return headerDelay;

  const resetAfter = headers['x-ratelimit-reset-after'] || headers['x-ratelimit-reset'] || headers['X-RateLimit-Reset'];
  const resetDelay = parseDurationMs(resetAfter);
  if (resetDelay !== null) return resetDelay;

  const text = getErrorText(err);
  const inMatch = text.match(/(?:try again|retry|available|reset)[^0-9]{0,40}(?:in|after)?\s*((?:\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds|ms|millisecond|milliseconds)\s*)+)/i);
  const textDelay = inMatch ? parseDurationMs(inMatch[1]) : null;
  if (textDelay !== null) return textDelay;

  return fallbackMs;
}

async function waitForGroqTranscriptionKey(apiKeys, onProgress, signal) {
  const normalizedKeys = normalizeGroqApiKeys(apiKeys);
  if (!normalizedKeys.length) {
    throw new Error('Groq API keys not set. Add at least one in Settings.');
  }

  while (true) {
    throwIfAborted(signal);
    const selected = pickAvailableGroqKey(normalizedKeys, groqTranscriptionKeyCooldowns, groqTranscriptionKeyCursor);
    if (selected.apiKey) {
      return selected;
    }

    const waitMs = Math.max(1000, selected.waitMs || DEFAULT_RATE_LIMIT_DELAY_MS);
    onProgress?.(`All Groq Whisper keys are cooling down. Waiting ${Math.ceil(waitMs / 1000)}s…`);
    await abortableSleep(waitMs, signal);
  }
}

// Wraps groqRequest with retry + exponential backoff for transient failures.
// Each retry re-creates the request (and its file read stream) from scratch.
async function groqRequestWithRetry(apiKeys, audioPath, model, language, proxy, onProgress, signal, maxRetries = 3) {
  let lastErr = null;
  let rateLimitRetries = 0;
  let transientRetries = 0;

  while (true) {
    throwIfAborted(signal);
    const selectedKey = await waitForGroqTranscriptionKey(apiKeys, onProgress, signal);

    try {
      return await groqRequest(selectedKey.apiKey, audioPath, model, language, proxy, signal);
    } catch (err) {
      lastErr = err;
      if (isAbortError(err)) throw err;

      if (isRateLimitError(err)) {
        if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
          throw err;
        }
        const delayMs = Math.min(getRateLimitDelayMs(err, DEFAULT_RATE_LIMIT_DELAY_MS), 10 * 60 * 1000);
        setGroqKeyCooldown(groqTranscriptionKeyCooldowns, selectedKey.apiKey, delayMs);
        rateLimitRetries++;
        onProgress?.(`Groq Whisper key ${selectedKey.index + 1}/${selectedKey.total} hit rate limit. Cooling down for ${Math.ceil(delayMs / 1000)}s and trying another key…`);
        continue;
      }

      if (transientRetries < maxRetries && isRetryableNetworkError(err)) {
        const delayMs = Math.min(2000 * Math.pow(2, transientRetries), 15000);
        const code = err?.code || err?.response?.status || err?.message;
        transientRetries++;
        console.warn(`[Groq] Transcription attempt ${transientRetries}/${maxRetries + 1} failed (${code}). Retrying in ${delayMs}ms…`);
        onProgress?.(`Network issue (${code}). Retrying Whisper request in ${Math.ceil(delayMs / 1000)}s…`);
        await abortableSleep(delayMs, signal);
        continue;
      }

      throw err;
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// WhisperService
// ---------------------------------------------------------------------------
class WhisperService {
  constructor() {
    this.apiKeys = [];
    this.proxy = null;
  }

  /**
   * Set Groq API keys.
   * @param {string[]|string} keys  One or more Groq API keys (gsk_...)
   */
  setApiKeys(keys) {
    this.apiKeys = normalizeGroqApiKeys(Array.isArray(keys) ? keys : [keys]);
  }

  setApiKey(key) {
    this.setApiKeys(key ? [key] : []);
  }

  /**
   * Set proxy config.
   * @param {object|null} proxy  { type, host, port, username, password }
   */
  setProxy(proxy) {
    this.proxy = proxy;
  }

  async _getAudioDuration(audioPath, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, metadata) => {
        if (err) return reject(err);
        try {
          throwIfAborted(signal);
          resolve(Number(metadata?.format?.duration) || 0);
        } catch (abortErr) {
          reject(abortErr);
        }
      });
    });
  }

  async _splitAudioIntoChunks(audioPath, chunkDurationSec, onProgress, signal) {
    const totalDuration = await this._getAudioDuration(audioPath, signal);
    if (!totalDuration || totalDuration <= chunkDurationSec) {
      return [{ path: audioPath, offsetSec: 0, durationSec: totalDuration || 0, cleanup: false }];
    }

    const chunks = [];
    let offsetSec = 0;
    let index = 0;

    while (offsetSec < totalDuration) {
      throwIfAborted(signal);
      const durationSec = Math.min(chunkDurationSec, totalDuration - offsetSec);
      const outPath = path.join(os.tmpdir(), `ss_whisper_chunk_${Date.now()}_${index}.mp3`);

      await runFfmpegCommand(
        ffmpeg(audioPath)
          .setStartTime(offsetSec)
          .setDuration(durationSec)
          .audioCodec('libmp3lame')
          .audioChannels(1)
          .audioFrequency(16000)
          .audioBitrate('32k')
          .format('mp3')
          .output(outPath),
        { signal }
      );

      chunks.push({ path: outPath, offsetSec, durationSec, cleanup: true });
      index++;
      offsetSec += chunkDurationSec;
      onProgress?.(`Prepared Whisper chunk ${index} (${Math.round(offsetSec)}s / ${Math.round(totalDuration)}s)…`);
    }

    return chunks;
  }

  async _splitExistingChunk(chunk, onProgress, signal) {
    const halfDuration = Math.max(MIN_CHUNK_DURATION_SEC, Math.floor((chunk.durationSec || 0) / 2));
    if (!chunk.path || !chunk.durationSec || halfDuration >= chunk.durationSec) {
      throw new Error('Whisper chunk is still too large and cannot be split further.');
    }

    const firstPath = path.join(os.tmpdir(), `ss_whisper_resplit_${Date.now()}_a.mp3`);
    const secondPath = path.join(os.tmpdir(), `ss_whisper_resplit_${Date.now()}_b.mp3`);

    const renderPiece = async (startSec, durationSec, outPath) => {
      throwIfAborted(signal);
      try {
        await runFfmpegCommand(
          ffmpeg(chunk.path)
            .setStartTime(startSec)
            .setDuration(durationSec)
            .audioCodec('copy')
            .format('mp3')
            .output(outPath),
          { signal }
        );
      } catch (err) {
        if (isAbortError(err)) throw err;
        await runFfmpegCommand(
          ffmpeg(chunk.path)
            .setStartTime(startSec)
            .setDuration(durationSec)
            .audioCodec('libmp3lame')
            .audioChannels(1)
            .audioFrequency(16000)
            .audioBitrate('32k')
            .format('mp3')
            .output(outPath),
          { signal }
        );
      }
    };

    const secondDuration = Math.max(0, chunk.durationSec - halfDuration);
    onProgress?.(`Whisper chunk still too large. Splitting ${Math.round(chunk.durationSec)}s chunk into two smaller parts…`);
    await renderPiece(0, halfDuration, firstPath);
    await renderPiece(halfDuration, secondDuration, secondPath);

    return [
      { path: firstPath, offsetSec: chunk.offsetSec, durationSec: halfDuration, cleanup: true },
      { path: secondPath, offsetSec: chunk.offsetSec + halfDuration, durationSec: secondDuration, cleanup: true }
    ].filter((item) => item.durationSec > 0);
  }

  _parseVerboseResult(result) {
    const segments = [];

    if (result.segments && Array.isArray(result.segments)) {
      for (const seg of result.segments) {
        const words = [];
        if (result.words && Array.isArray(result.words)) {
          for (const w of result.words) {
            if (w.start >= seg.start && w.start < seg.end) {
              words.push({
                word: w.word,
                start: w.start,
                end: w.end
              });
            }
          }
        }
        segments.push({
          start: seg.start,
          end: seg.end,
          text: seg.text.trim(),
          words
        });
      }
      return segments;
    }

    if (result.words && Array.isArray(result.words) && result.words.length > 0) {
      const allWords = result.words.map((w) => ({ word: w.word, start: w.start, end: w.end }));
      let segStart = allWords[0].start;
      let segWords = [];
      let prevEnd = allWords[0].start;
      for (const w of allWords) {
        if (segWords.length > 0 && (w.start - prevEnd > 1.5 || /[.!?]$/.test(segWords[segWords.length - 1].word))) {
          const text = segWords.map((sw) => sw.word).join(' ');
          segments.push({ start: segStart, end: segWords[segWords.length - 1].end, text: text.trim(), words: [...segWords] });
          segStart = w.start;
          segWords = [];
        }
        segWords.push(w);
        prevEnd = w.end;
      }
      if (segWords.length > 0) {
        const text = segWords.map((sw) => sw.word).join(' ');
        segments.push({ start: segStart, end: segWords[segWords.length - 1].end, text: text.trim(), words: [...segWords] });
      }
      return segments;
    }

    if (result.text) {
      segments.push({
        start: 0,
        end: 0,
        text: result.text.trim(),
        words: []
      });
    }

    return segments;
  }

  _shiftSegments(segments, offsetSec) {
    return segments.map((seg) => ({
      start: Math.max(0, Number(seg.start || 0) + offsetSec),
      end: Math.max(0, Number(seg.end || 0) + offsetSec),
      text: String(seg.text || '').trim(),
      words: Array.isArray(seg.words)
        ? seg.words.map((word) => ({
          word: String(word.word || '').trim(),
          start: Math.max(0, Number(word.start || 0) + offsetSec),
          end: Math.max(0, Number(word.end || 0) + offsetSec)
        }))
        : []
    }));
  }

  async _transcribeChunked(audioPath, model, language, apiKeys, proxy, onProgress, signal) {
    throwIfAborted(signal);
    const fileSize = fs.statSync(audioPath).size;
    const totalDuration = await this._getAudioDuration(audioPath, signal);
    const estimatedChunkDuration = totalDuration > 0
      ? Math.floor((totalDuration * MAX_DIRECT_UPLOAD_BYTES) / Math.max(fileSize, 1) * 0.85)
      : MAX_CHUNK_DURATION_SEC;
    const chunkDurationSec = Math.max(MIN_CHUNK_DURATION_SEC, Math.min(MAX_CHUNK_DURATION_SEC, estimatedChunkDuration || MAX_CHUNK_DURATION_SEC));

    onProgress?.(`Audio is too large for a single Groq upload. Splitting into ~${Math.round(chunkDurationSec / 60)} min Whisper chunks…`);
    const chunks = await this._splitAudioIntoChunks(audioPath, chunkDurationSec, onProgress, signal);
    const fullSegments = [];

    try {
      for (let i = 0; i < chunks.length; i++) {
        throwIfAborted(signal);
        const chunk = chunks[i];
        onProgress?.(`Transcribing Whisper chunk ${i + 1}/${chunks.length}…`);
        try {
          const result = await groqRequestWithRetry(
            apiKeys,
            chunk.path,
            model,
            language,
            proxy,
            (msg) => onProgress?.(`Chunk ${i + 1}/${chunks.length}: ${msg}`),
            signal
          );
          const parsed = this._parseVerboseResult(result);
          fullSegments.push(...this._shiftSegments(parsed, chunk.offsetSec));
        } catch (err) {
          if (!isPayloadTooLargeError(err) || chunk.durationSec <= MIN_CHUNK_DURATION_SEC) {
            throw err;
          }
          const replacementChunks = await this._splitExistingChunk(chunk, onProgress, signal);
          if (chunk.cleanup) {
            try { fs.unlinkSync(chunk.path); } catch {}
          }
          chunks.splice(i, 1, ...replacementChunks);
          i--;
        }
      }
    } finally {
      for (const chunk of chunks) {
        if (!chunk.cleanup) continue;
        try { fs.unlinkSync(chunk.path); } catch {}
      }
    }

    return fullSegments;
  }

  /**
   * Transcribe an audio file via Groq API.
   * @param {string}   audioPath   Path to WAV / MP3
   * @param {object}   opts        { model, language, apiKey, proxy }
   * @param {function} onProgress
   * @returns {Promise<Array>}     Array of { start, end, text, words[] }
   */
  async transcribe(audioPath, opts = {}, onProgress) {
    const model    = opts.model || 'whisper-large-v3';
    const language = opts.language || 'ru';
    const apiKeys  = normalizeGroqApiKeys(
      opts.apiKeys !== undefined ? opts.apiKeys : this.apiKeys,
      opts.apiKey || ''
    );
    const proxy    = opts.proxy || this.proxy;
    const signal   = opts.signal;
    throwIfAborted(signal);

    if (!apiKeys.length) {
      throw new Error('Groq API keys not set. Add at least one in Settings.');
    }

    onProgress?.(`Transcribing audio [${model}] via Groq…`);

    const fileSize = fs.statSync(audioPath).size;
    let segments;

    if (fileSize > MAX_DIRECT_UPLOAD_BYTES) {
      segments = await this._transcribeChunked(audioPath, model, language, apiKeys, proxy, onProgress, signal);
    } else {
      try {
        const result = await groqRequestWithRetry(apiKeys, audioPath, model, language, proxy, onProgress, signal);
        segments = this._parseVerboseResult(result);
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (!isPayloadTooLargeError(err)) throw err;
        onProgress?.('Groq rejected the full upload with 413. Retrying with Whisper chunking…');
        segments = await this._transcribeChunked(audioPath, model, language, apiKeys, proxy, onProgress, signal);
      }
    }

    onProgress?.(`Transcription complete: ${segments.length} segments`);
    return segments;
  }

  /**
   * Slice transcript segments into a local clip timeline.
   * Returned timestamps are shifted so the clip starts at 0.
   * @param {Array} segments
   * @param {number} clipStartSec
   * @param {number} clipEndSec
   * @returns {Array}
   */
  sliceSegments(segments, clipStartSec, clipEndSec) {
    const startSec = Math.max(0, Number(clipStartSec) || 0);
    const endSec = Math.max(startSec, Number(clipEndSec) || startSec);
    const out = [];

    for (const seg of Array.isArray(segments) ? segments : []) {
      const segStart = Number(seg?.start) || 0;
      const segEnd = Number(seg?.end) || segStart;
      if (segEnd <= startSec || segStart >= endSec) continue;

      const shiftedStart = Math.max(0, segStart - startSec);
      const shiftedEnd = Math.max(shiftedStart + 0.01, Math.min(segEnd, endSec) - startSec);
      const words = Array.isArray(seg?.words)
        ? seg.words
          .filter((word) => {
            const wordStart = Number(word?.start) || 0;
            const wordEnd = Number(word?.end) || wordStart;
            return wordEnd > startSec && wordStart < endSec;
          })
          .map((word) => {
            const wordStart = Number(word?.start) || 0;
            const wordEnd = Number(word?.end) || wordStart;
            return {
              word: String(word?.word || '').trim(),
              start: Math.max(0, wordStart - startSec),
              end: Math.max(0, Math.min(wordEnd, endSec) - startSec)
            };
          })
          .filter((word) => word.word && word.end > word.start)
        : [];

      out.push({
        start: shiftedStart,
        end: shiftedEnd,
        text: String(seg?.text || '').trim(),
        words
      });
    }

    return out.filter((seg) => seg.text || (Array.isArray(seg.words) && seg.words.length > 0));
  }

  /**
   * Convert transcription segments to an ASS subtitle string.
   */
  toASS(segments, styleName = 'Classic', offsetSec = 0, subtitleOptions = {}, caseName = 'sentence') {
    if (typeof subtitleOptions === 'string') {
      caseName = subtitleOptions;
      subtitleOptions = {};
    }
    const resolvedStyleName = subtitleOptions.stylePreset || styleName;
    const style = ASS_STYLES[resolvedStyleName] || ASS_STYLES.Classic;
    const wordsPerLine = Math.max(1, Number(subtitleOptions.wordsPerLine || 3));
    const maxLineMs = Math.max(300, Number(subtitleOptions.maxLineMs || 1200));
    const position = subtitleOptions.position || 'bottom';
    const alignment = position === 'top' ? 8 : (position === 'middle' ? 5 : 2);
    const fontSize = Math.max(12, Number(subtitleOptions.fontSize || style.fontSize || 20));
    const marginV = Math.max(10, Number(subtitleOptions.marginV || style.marginV || 40));
    const karaoke = !!subtitleOptions.karaoke;
    const fontName = String(subtitleOptions.fontFamily || style.fontName || 'Arial').replace(/,/g, ' ').trim() || 'Arial';
    const karaokeMode = String(subtitleOptions.karaokeMode || 'highlight');
    const resolvedCase = subtitleOptions.caseName || caseName;
    const effectsFromOptions = Array.isArray(subtitleOptions.karaokeEffects)
      ? subtitleOptions.karaokeEffects
      : [];
    const normalizedEffects = effectsFromOptions
      .map((e) => String(e || '').toLowerCase())
      .map((e) => e === 'underline' ? 'box' : e)
      .filter((e) => e === 'highlight' || e === 'box' || e === 'caps');
    const fallbackModeEffects = karaokeMode === 'both'
      ? ['highlight', 'box']
      : (karaokeMode === 'underline' ? ['box'] : [karaokeMode]);
    const karaokeEffects = new Set(normalizedEffects.length
      ? normalizedEffects
      : fallbackModeEffects.map((e) => e === 'underline' ? 'box' : e));
    if (!karaokeEffects.has('highlight') && !karaokeEffects.has('box') && !karaokeEffects.has('caps')) {
      karaokeEffects.add('highlight');
    }
    const secondaryColour = resolvedStyleName === 'Highlight' ? '&H00FFFFFF' : '&H0000D4FF';
    const basePrimaryColour = String(style.primaryColour || '&H00FFFFFF');
    const basePrimaryColourAss = basePrimaryColour.endsWith('&') ? basePrimaryColour : `${basePrimaryColour}&`;
    const borderStyle = style.BorderStyle || 1;
    const marginH = Math.max(20, Number(style.marginH || 40));

    const header = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: 1080',
      'PlayResY: 1920',
      'WrapStyle: 0',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: Default,${fontName},${fontSize},${style.primaryColour},${secondaryColour},${style.outlineColour},${style.backColour},${style.bold},0,0,0,100,100,0,0,${borderStyle},${style.outline},${style.shadow},${alignment},${marginH},${marginH},${marginV},204`,
      `Style: KaraokeBox,${fontName},${fontSize},&H00FFFFFF,${secondaryColour},&H4D5A63FF,&H8A303BFF,${style.bold},0,0,0,100,100,0,0,3,1,0,${alignment},${marginH},${marginH},${marginV},204`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ].join('\n');

    const events = [];
    for (const seg of segments) {
      const words = Array.isArray(seg.words) ? seg.words : [];
      let timedWords = words.filter(w =>
        Number.isFinite(Number(w?.start)) &&
        Number.isFinite(Number(w?.end)) &&
        Number(w.end) > Number(w.start)
      );
      if (karaoke && timedWords.length === 0) {
        timedWords = buildFallbackTimedWords(seg);
      }
      const hasUsableWordTimeline = timedWords.length >= 1;

      if (hasUsableWordTimeline) {
        let idx = 0;
        while (idx < timedWords.length) {
          const chunk = timedWords.slice(idx, idx + wordsPerLine);
          const cStartAbs = Number(chunk[0].start || seg.start);
          const cEndAbsRaw = Number(chunk[chunk.length - 1].end || seg.end);
          const cEndAbsCapped = Math.min(cEndAbsRaw, cStartAbs + maxLineMs / 1000);

          const cStart = Math.max(0, cStartAbs - offsetSec);
          const cEnd = Math.max(cStart + 0.12, cEndAbsCapped - offsetSec);
          const chunkWords = chunk.map(w => String(w.word || '').trim()).filter(Boolean);
          let text = chunkWords.join(' ').trim();
          if (karaoke) {
            for (let wi = 0; wi < chunk.length; wi++) {
              const w = chunk[wi];
              const wStart = Number(w.start || cStart);
              const nextStart = wi < chunk.length - 1 ? Number(chunk[wi + 1].start || w.end || wStart) : Number(w.end || cEnd);
              const ws = Math.max(0, wStart - offsetSec);
              const we = Math.max(ws + 0.06, Math.min(cEnd, nextStart - offsetSec));
              const line = buildAssKaraokeLine(
                chunkWords,
                wi,
                karaokeEffects,
                resolvedStyleName,
                resolvedCase,
                basePrimaryColourAss
              );
              if (line) {
                events.push(`Dialogue: 0,${seconds2ass(ws)},${seconds2ass(we)},Default,,0,0,0,,${line}`);
              }
            }
            idx += wordsPerLine;
            continue;
          }
          text = escapeAssText(applyCaseToText(text, resolvedCase));
          if (text) {
            events.push(`Dialogue: 0,${seconds2ass(cStart)},${seconds2ass(cEnd)},Default,,0,0,0,,${text}`);
          }
          idx += wordsPerLine;
        }
      } else {
        const segWords = String(seg.text || '').trim().split(/\s+/).filter(Boolean);
        const segStart = Math.max(0, seg.start - offsetSec);
        const segEnd = Math.max(segStart + 0.2, seg.end - offsetSec);
        const segDuration = Math.max(0.2, segEnd - segStart);
        const totalWords = segWords.length || 1;
        let idx = 0;
        while (idx < totalWords) {
          const chunkWords = segWords.slice(idx, idx + wordsPerLine);
          const chunkText = escapeAssText(applyCaseToText(chunkWords.join(' '), resolvedCase));
          if (!chunkText) { idx += wordsPerLine; continue; }
          const wordStart = segStart + (idx / totalWords) * segDuration;
          const wordEnd = Math.min(segStart + ((idx + wordsPerLine) / totalWords) * segDuration, segEnd);
          const cStart = wordStart;
          const cEnd = Math.min(Math.max(cStart + 0.2, cStart + maxLineMs / 1000), wordEnd);
          events.push(`Dialogue: 0,${seconds2ass(cStart)},${seconds2ass(cEnd)},Default,,0,0,0,,${chunkText}`);
          idx += wordsPerLine;
        }
      }
    }

    return `${header}\r\n${events.join('\r\n')}\r\n`;
  }

  /**
   * Convert transcription segments to SRT subtitle string.
   */
  toSRT(segments, offsetSec = 0, subtitleOptions = {}) {
    const caseName = subtitleOptions.caseName || subtitleOptions.karaokeCase || 'sentence';
    const wordsPerLine = Math.max(1, Number(subtitleOptions.wordsPerLine || 3));
    const maxLineMs = Math.max(300, Number(subtitleOptions.maxLineMs || 1200));
    const karaoke = !!subtitleOptions.karaoke;
    const stylePreset = String(subtitleOptions.stylePreset || 'Classic');
    const karaokeMode = String(subtitleOptions.karaokeMode || 'highlight');
    const effectsFromOptions = Array.isArray(subtitleOptions.karaokeEffects)
      ? subtitleOptions.karaokeEffects
      : [];
    const karaokeEffects = new Set(effectsFromOptions.length
      ? effectsFromOptions
      : (karaokeMode === 'both'
        ? ['highlight', 'underline']
        : [karaokeMode]));
    if (karaokeEffects.has('underline')) karaokeEffects.add('box');
    const rows = [];
    let n = 1;

    for (const seg of segments) {
      const words = Array.isArray(seg.words) ? seg.words : [];
      const timedWords = words.filter(w =>
        Number.isFinite(Number(w?.start)) &&
        Number.isFinite(Number(w?.end)) &&
        Number(w.end) > Number(w.start)
      );
      const hasUsableWordTimeline =
        timedWords.length >= 2 &&
        (Number(timedWords[timedWords.length - 1].start) - Number(timedWords[0].start)) > 0.2;

      if (hasUsableWordTimeline) {
        let idx = 0;
        while (idx < timedWords.length) {
          const chunk = timedWords.slice(idx, idx + wordsPerLine);
          const cStartAbs = Number(chunk[0].start || seg.start);
          const cEndAbsRaw = Number(chunk[chunk.length - 1].end || seg.end);
          const cEndAbsCapped = Math.min(cEndAbsRaw, cStartAbs + maxLineMs / 1000);

          const cStart = Math.max(0, cStartAbs - offsetSec);
          const cEnd = Math.max(cStart + 0.12, cEndAbsCapped - offsetSec);
          const wordsText = chunk.map(w => String(w.word || '').trim()).filter(Boolean);
          let text = wordsText.join(' ').replace(/\r?\n/g, ' ');
          text = applyCaseToText(text, caseName);
          if (karaoke && wordsText.length > 0) {
            const casedWords = text.split(/\s+/).filter(Boolean);
            const hi = casedWords.length > 1 ? Math.floor(casedWords.length / 2) : 0;
            const karaokeWords = casedWords.map((w, i) => {
              if (i !== hi) return w;
              let value = w;
              if (karaokeEffects.has('highlight')) {
                value = stylePreset === 'Highlight'
                  ? `<font color="#FFFFFF">${value}</font>`
                  : `<font color="#FFD400">${value}</font>`;
              }
              if (karaokeEffects.has('box')) {
                value = `<font bgcolor="#88FF3B30">${value}</font>`;
              }
              if (karaokeEffects.has('caps') && caseName !== 'uppercase') {
                value = String(value).toUpperCase();
              }
              return value;
            });
            text = karaokeWords.join(' ');
          }
          if (text) {
            rows.push(`${n++}\n${seconds2srt(cStart)} --> ${seconds2srt(cEnd)}\n${text}\n`);
          }
          idx += wordsPerLine;
        }
      } else {
        const segWords = String(seg.text || '').replace(/\r?\n/g, ' ').trim().split(/\s+/).filter(Boolean);
        const segStart = Math.max(0, Number(seg.start || 0) - offsetSec);
        const segEnd = Math.max(segStart + 0.2, Number(seg.end || 0) - offsetSec);
        const segDuration = Math.max(0.2, segEnd - segStart);
        const totalWords = segWords.length || 1;
        let idx = 0;
        while (idx < totalWords) {
          const chunkWords = segWords.slice(idx, idx + wordsPerLine);
          let text = applyCaseToText(chunkWords.join(' '), caseName);
          if (!text) { idx += wordsPerLine; continue; }
          const wordStart = segStart + (idx / totalWords) * segDuration;
          const wordEnd = Math.min(segStart + ((idx + wordsPerLine) / totalWords) * segDuration, segEnd);
          const cStart = wordStart;
          const cEnd = Math.min(Math.max(cStart + 0.2, cStart + maxLineMs / 1000), wordEnd);
          if (karaoke && chunkWords.length > 0) {
            const hi = chunkWords.length > 1 ? Math.floor(chunkWords.length / 2) : 0;
            const karaokeWords = chunkWords.map((w, i) => {
              if (i !== hi) return w;
              let value = w;
              if (karaokeEffects.has('highlight')) {
                value = stylePreset === 'Highlight'
                  ? `<font color="#FFFFFF">${value}</font>`
                  : `<font color="#FFD400">${value}</font>`;
              }
              if (karaokeEffects.has('box')) {
                value = `<font bgcolor="#88FF3B30">${value}</font>`;
              }
              if (karaokeEffects.has('caps') && caseName !== 'uppercase') {
                value = String(value).toUpperCase();
              }
              return value;
            });
            text = karaokeWords.join(' ');
          }
          rows.push(`${n++}\n${seconds2srt(cStart)} --> ${seconds2srt(cEnd)}\n${text}\n`);
          idx += wordsPerLine;
        }
      }
    }

    return rows.join('\n');
  }
}

module.exports = { WhisperService, ASS_STYLES, GROQ_MODELS };
