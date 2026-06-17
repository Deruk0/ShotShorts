/**
 * WhisperService — transcription via Groq API (whisper-large-v3 / whisper-large-v3-turbo).
 *
 * Strategy:
 *  • Sends audio to Groq's Whisper endpoint — no local Python/PyTorch needed.
 *  • Outputs per-segment timed text, converts to ASS/SRT subtitle format.
 *  • Supports word-level timestamps for karaoke mode.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

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
  'whisper-large-v3': 'Whisper Large v3 — best quality',
  'whisper-large-v3-turbo': 'Whisper Large v3 Turbo — faster, slightly less accurate'
};

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
// Build proxy agent (same pattern as base-audio-client.js)
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
function groqRequest(apiKey, audioPath, model, language, proxy) {
  const FormData = require('form-data');
  const form = new FormData();
  const ext = path.extname(audioPath).toLowerCase();
  const contentType = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';

  form.append('file', fs.createReadStream(audioPath), {
    filename: path.basename(audioPath),
    contentType
  });
  form.append('model', model);
  form.append('language', language);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');

  const config = {
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${apiKey}`
    },
    timeout: 300000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  };

  const agent = buildProxyAgent(proxy);
  if (agent) {
    config.httpsAgent = agent;
    console.log(`[Groq] Using proxy: ${proxy.type}://${proxy.host}:${proxy.port}`);
  } else {
    console.log(`[Groq] No proxy configured, going direct. Proxy data:`, JSON.stringify(proxy));
  }

  return axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    form,
    config
  ).then(res => res.data);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wraps groqRequest with retry + exponential backoff for transient failures.
// Each retry re-creates the request (and its file read stream) from scratch.
async function groqRequestWithRetry(apiKey, audioPath, model, language, proxy, onProgress, maxRetries = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await groqRequest(apiKey, audioPath, model, language, proxy);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isRetryableNetworkError(err)) {
        const delayMs = Math.min(2000 * Math.pow(2, attempt), 15000);
        const code = err?.code || err?.response?.status || err?.message;
        console.warn(`[Groq] Transcription attempt ${attempt + 1}/${maxRetries + 1} failed (${code}). Retrying in ${delayMs}ms…`);
        onProgress?.(`Network issue (${code}). Retrying transcription (${attempt + 1}/${maxRetries})…`);
        await sleep(delayMs);
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
    this.apiKey = null;
    this.proxy = null;
  }

  /**
   * Set the Groq API key.
   * @param {string} key  Groq API key (gsk_...)
   */
  setApiKey(key) {
    this.apiKey = key;
  }

  /**
   * Set proxy config.
   * @param {object|null} proxy  { type, host, port, username, password }
   */
  setProxy(proxy) {
    this.proxy = proxy;
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
    const apiKey   = opts.apiKey || this.apiKey;
    const proxy    = opts.proxy || this.proxy;

    if (!apiKey) {
      throw new Error('Groq API key not set. Add it in Settings.');
    }

    onProgress?.(`Transcribing audio [${model}] via Groq…`);

    const result = await groqRequestWithRetry(apiKey, audioPath, model, language, proxy, onProgress);

    // Groq verbose_json response has segments with word-level timestamps
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
    } else if (result.words && Array.isArray(result.words) && result.words.length > 0) {
      // No segments but we have words — reconstruct segments from words
      const allWords = result.words.map(w => ({ word: w.word, start: w.start, end: w.end }));
      // Group words into segments by sentence-ending punctuation or ~10s gaps
      let segStart = allWords[0].start;
      let segWords = [];
      let prevEnd = allWords[0].start;
      for (const w of allWords) {
        // Start a new segment on large gap or after sentence-ending punctuation
        if (segWords.length > 0 && (w.start - prevEnd > 1.5 || /[.!?]$/.test(segWords[segWords.length - 1].word))) {
          const text = segWords.map(sw => sw.word).join(' ');
          segments.push({ start: segStart, end: segWords[segWords.length - 1].end, text: text.trim(), words: [...segWords] });
          segStart = w.start;
          segWords = [];
        }
        segWords.push(w);
        prevEnd = w.end;
      }
      if (segWords.length > 0) {
        const text = segWords.map(sw => sw.word).join(' ');
        segments.push({ start: segStart, end: segWords[segWords.length - 1].end, text: text.trim(), words: [...segWords] });
      }
    } else if (result.text) {
      segments.push({
        start: 0,
        end: 0,
        text: result.text.trim(),
        words: []
      });
    }

    onProgress?.(`Transcription complete: ${segments.length} segments`);
    return segments;
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
