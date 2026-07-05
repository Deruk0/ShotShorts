const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { normalizeGroqApiKeys, pickAvailableGroqKey, setGroqKeyCooldown } = require('./groq-key-utils');

const GROQ_QWEN_MODEL = 'qwen/qwen3.6-27b';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_RATE_LIMIT_RETRIES = 8;
const DEFAULT_RATE_LIMIT_DELAY_MS = 30000;

const groqChatKeyCooldowns = new Map();
const groqChatKeyCursor = { current: 0 };

function buildProxyAgent(proxy) {
  if (!proxy || !proxy.host) return null;

  const { type = 'http', host, port, username, password } = proxy;
  const cleanHost = String(host).replace(/^(https?|socks\d?):\/\//i, '');
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGroqChatKey(apiKeys, onProgress, label = 'Qwen') {
  const normalizedKeys = normalizeGroqApiKeys(apiKeys);
  if (!normalizedKeys.length) {
    throw new Error('Groq API keys not set. Add at least one in Settings.');
  }

  while (true) {
    const selected = pickAvailableGroqKey(normalizedKeys, groqChatKeyCooldowns, groqChatKeyCursor);
    if (selected.apiKey) {
      return selected;
    }

    const waitMs = Math.max(1000, selected.waitMs || DEFAULT_RATE_LIMIT_DELAY_MS);
    onProgress?.(`${label}: all Groq Qwen keys are cooling down. Waiting ${Math.ceil(waitMs / 1000)}s…`);
    await sleep(waitMs);
  }
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

function isRetryableError(err) {
  const code = err?.code || err?.cause?.code;
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH'].includes(code)) {
    return true;
  }
  const status = err?.response?.status;
  if (status === 429 || (status >= 500 && status <= 599)) {
    return true;
  }
  return !!(err?.message && /timeout|network|socket hang up/i.test(err.message));
}

function isPayloadTooLargeError(err) {
  return err?.response?.status === 413;
}

function isRateLimitError(err) {
  return err?.response?.status === 429;
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTimecode(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const total = Math.floor(safe);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function extractJsonObject(text) {
  if (!text) return null;

  try {
    const direct = JSON.parse(text);
    if (direct && typeof direct === 'object') return direct;
  } catch {}

  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }

  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object') return parsed;
        } catch {}
        start = -1;
      }
    }
  }

  return null;
}

function titleSimilarity(a, b) {
  const left = normalizeText(a).toLowerCase();
  const right = normalizeText(b).toLowerCase();
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftSet = new Set(left.split(/\s+/).filter(Boolean));
  const rightSet = new Set(right.split(/\s+/).filter(Boolean));
  let shared = 0;
  for (const word of leftSet) {
    if (rightSet.has(word)) shared++;
  }
  const base = Math.max(leftSet.size, rightSet.size, 1);
  return shared / base;
}

class GroqStoryAnalyzer {
  static MAX_BLOCK_CHARS = 180;
  static MAX_BLOCK_DURATION_SEC = 18;
  static MAX_BLOCK_GAP_SEC = 2.5;
  static MAX_WINDOW_CHARS = 9000;
  static MAX_WINDOW_BLOCKS = 70;
  static WINDOW_OVERLAP_BLOCKS = 6;
  static MIN_SPLITTABLE_CORE_BLOCKS = 10;

  constructor(apiKeys, proxy) {
    this.apiKeys = normalizeGroqApiKeys(apiKeys);
    this.proxy = proxy || null;
  }

  _buildAxiosConfig() {
    const config = {
      timeout: 180000
    };
    const agent = buildProxyAgent(this.proxy);
    if (agent) {
      config.httpsAgent = agent;
    }
    return config;
  }

  buildTranscriptBlocks(transcriptSegments) {
    const blocks = [];
    let current = null;

    const flush = () => {
      if (!current) return;
      const text = normalizeText(current.text);
      if (!text) {
        current = null;
        return;
      }
      blocks.push({
        id: blocks.length + 1,
        start: current.start,
        end: current.end,
        text
      });
      current = null;
    };

    for (const seg of Array.isArray(transcriptSegments) ? transcriptSegments : []) {
      const text = normalizeText(seg?.text);
      const start = Math.max(0, Number(seg?.start) || 0);
      const end = Math.max(start, Number(seg?.end) || start);
      if (!text || end <= start) continue;

      if (!current) {
        current = { start, end, text };
        continue;
      }

      const gap = Math.max(0, start - current.end);
      const nextText = `${current.text} ${text}`.trim();
      const nextDuration = end - current.start;
      const shouldSplit =
        gap > GroqStoryAnalyzer.MAX_BLOCK_GAP_SEC ||
        nextText.length > GroqStoryAnalyzer.MAX_BLOCK_CHARS ||
        nextDuration > GroqStoryAnalyzer.MAX_BLOCK_DURATION_SEC;

      if (shouldSplit) {
        flush();
        current = { start, end, text };
      } else {
        current.end = end;
        current.text = nextText;
      }
    }

    flush();
    return blocks;
  }

  buildTranscriptWindows(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) return [];

    const windows = [];
    let cursor = 0;

    while (cursor < blocks.length) {
      const coreStart = cursor;
      let charCount = 0;
      let blockCount = 0;

      while (cursor < blocks.length) {
        const line = this._formatBlockLine(blocks[cursor]);
        const fitsChars = charCount + line.length <= GroqStoryAnalyzer.MAX_WINDOW_CHARS;
        const fitsBlocks = blockCount < GroqStoryAnalyzer.MAX_WINDOW_BLOCKS;
        if (blockCount >= 8 && (!fitsChars || !fitsBlocks)) {
          break;
        }
        charCount += line.length;
        blockCount++;
        cursor++;
      }

      const coreEnd = Math.max(coreStart, cursor - 1);
      const overlap = GroqStoryAnalyzer.WINDOW_OVERLAP_BLOCKS;
      const windowStart = Math.max(0, coreStart - overlap);
      const windowEnd = Math.min(blocks.length - 1, coreEnd + overlap);

      windows.push({
        coreStart,
        coreEnd,
        windowStart,
        windowEnd,
        blocks: blocks.slice(windowStart, windowEnd + 1)
      });
    }

    return windows;
  }

  _formatBlockLine(block) {
    return `${String(block.id).padStart(3, '0')} ${formatTimecode(block.start)}-${formatTimecode(block.end)} ${block.text}\n`;
  }

  _buildPrompt(window, totalDuration) {
    const transcriptText = window.blocks.map((block) => this._formatBlockLine(block)).join('');
    const coreStartId = window.blocks[window.coreStart - window.windowStart]?.id || window.blocks[0]?.id || 1;
    const coreEndId = window.blocks[window.coreEnd - window.windowStart]?.id || window.blocks[window.blocks.length - 1]?.id || coreStartId;
    const firstCoreStart = window.blocks[window.coreStart - window.windowStart]?.start || 0;
    const lastCoreEnd = window.blocks[window.coreEnd - window.windowStart]?.end || totalDuration;

    return [
      'Split this spoken transcript into stories.',
      'Return JSON only:',
      '{"stories":[{"title":"Короткий заголовок","start":0.0,"end":0.0}]}',
      'Rules:',
      '- title in Russian, 2-4 words',
      '- chronological order',
      '- do not skip stories',
      '- do not merge unrelated stories',
      '- use overlap blocks only as context',
      `- emit only stories whose START is inside core block ids ${String(coreStartId).padStart(3, '0')}..${String(coreEndId).padStart(3, '0')}`,
      `- if story start is before ${firstCoreStart.toFixed(2)} sec, omit it`,
      '- if no story starts in core range, return {"stories":[]}',
      `- recording duration ${totalDuration.toFixed(2)} sec`,
      `- visible core end about ${lastCoreEnd.toFixed(2)} sec`,
      'Blocks:',
      transcriptText
    ].join('\n');
  }

  async _requestWindow(apiKey, prompt, reasoningEffort = 'none') {
    const payload = {
      model: GROQ_QWEN_MODEL,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: { type: 'json_object' },
      reasoning_format: 'hidden',
      reasoning_effort: reasoningEffort,
      temperature: 0.2,
      top_p: 0.9,
      max_completion_tokens: 2048
    };

    const response = await axios.post(GROQ_CHAT_URL, payload, {
      ...this._buildAxiosConfig(),
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      validateStatus: () => true
    });

    if (response.status < 200 || response.status >= 300) {
      const bodyText = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data || {});
      const err = new Error(`Groq Qwen failed with status ${response.status}: ${bodyText.slice(0, 500)}`);
      err.response = response;
      throw err;
    }

    const content = response?.data?.choices?.[0]?.message?.content || '';
    const parsed = extractJsonObject(content);
    if (!parsed) {
      throw new Error('Groq Qwen returned invalid JSON');
    }
    return parsed;
  }

  async _requestWindowWithRetry(prompt, onProgress, label) {
    let lastErr = null;
    const efforts = ['none', 'default'];

    for (let pass = 0; pass < efforts.length; pass++) {
      const reasoningEffort = efforts[pass];
      let rateLimitRetries = 0;
      let transientRetries = 0;

      while (true) {
        const selectedKey = await waitForGroqChatKey(this.apiKeys, onProgress, label);

        try {
          if (pass > 0) {
            onProgress?.(`${label}: retrying with deeper reasoning…`);
          }
          return await this._requestWindow(selectedKey.apiKey, prompt, reasoningEffort);
        } catch (err) {
          lastErr = err;
          if (isPayloadTooLargeError(err)) {
            break;
          }

          if (isRateLimitError(err)) {
            if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
              throw err;
            }
            const delayMs = Math.min(getRateLimitDelayMs(err, DEFAULT_RATE_LIMIT_DELAY_MS), 10 * 60 * 1000);
            setGroqKeyCooldown(groqChatKeyCooldowns, selectedKey.apiKey, delayMs);
            rateLimitRetries++;
            onProgress?.(`${label}: Groq Qwen key ${selectedKey.index + 1}/${selectedKey.total} hit rate limit. Cooling down for ${Math.ceil(delayMs / 1000)}s and trying another key…`);
            continue;
          }

          if (transientRetries < 2 && isRetryableError(err)) {
            const delayMs = Math.min(2000 * Math.pow(2, transientRetries), 10000);
            transientRetries++;
            onProgress?.(`${label}: transient Groq error, retrying in ${Math.round(delayMs / 1000)}s…`);
            await sleep(delayMs);
            continue;
          }

          break;
        }
      }
    }

    throw lastErr || new Error('Groq Qwen analysis failed');
  }

  _splitWindow(window) {
    const coreBlockCount = window.coreEnd - window.coreStart + 1;
    if (coreBlockCount < GroqStoryAnalyzer.MIN_SPLITTABLE_CORE_BLOCKS) {
      return null;
    }

    const leftCoreStart = window.coreStart;
    const leftCoreEnd = Math.floor((window.coreStart + window.coreEnd) / 2);
    const rightCoreStart = leftCoreEnd + 1;
    const rightCoreEnd = window.coreEnd;
    const overlap = Math.max(2, Math.floor(GroqStoryAnalyzer.WINDOW_OVERLAP_BLOCKS / 2));

    const buildPart = (coreStart, coreEnd) => {
      const windowStart = Math.max(0, coreStart - overlap);
      const windowEnd = Math.min(this._allBlocks.length - 1, coreEnd + overlap);
      return {
        coreStart,
        coreEnd,
        windowStart,
        windowEnd,
        blocks: this._allBlocks.slice(windowStart, windowEnd + 1)
      };
    };

    return [
      buildPart(leftCoreStart, leftCoreEnd),
      buildPart(rightCoreStart, rightCoreEnd)
    ];
  }

  async _analyzeWindow(window, totalDuration, onProgress, label) {
    const prompt = this._buildPrompt(window, totalDuration);
    try {
      const parsed = await this._requestWindowWithRetry(prompt, onProgress, label);
      return this._sanitizeWindowStories(parsed.stories, window, totalDuration);
    } catch (err) {
      if (!isPayloadTooLargeError(err)) throw err;

      const split = this._splitWindow(window);
      if (!split) {
        throw new Error(`${label}: request is still too large for Qwen even after compression.`);
      }

      onProgress?.(`${label}: request too large for Qwen, splitting into smaller windows…`);
      const leftStories = await this._analyzeWindow(split[0], totalDuration, onProgress, `${label}.A`);
      const rightStories = await this._analyzeWindow(split[1], totalDuration, onProgress, `${label}.B`);
      return [...leftStories, ...rightStories];
    }
  }

  _sanitizeWindowStories(rawStories, window, totalDuration) {
    const stories = Array.isArray(rawStories) ? rawStories : [];
    const coreFirst = window.blocks[window.coreStart - window.windowStart];
    const coreLast = window.blocks[window.coreEnd - window.windowStart];
    const coreStartSec = coreFirst ? coreFirst.start : 0;
    const coreEndSec = coreLast ? coreLast.end : totalDuration;

    return stories
      .map((story) => {
        const title = normalizeText(story?.title).slice(0, 80);
        const start = Math.max(0, Number(story?.start) || 0);
        const end = Math.min(totalDuration, Number(story?.end) || 0);
        return { title, start, end };
      })
      .filter((story) => story.title && Number.isFinite(story.start) && Number.isFinite(story.end))
      .filter((story) => story.end - story.start >= 1)
      .filter((story) => story.start >= coreStartSec - 0.75 && story.start <= coreEndSec + 0.75);
  }

  _mergeStories(stories, totalDuration) {
    const sorted = [...stories]
      .map((story) => ({
        title: normalizeText(story.title),
        start: Math.max(0, Number(story.start) || 0),
        end: Math.min(totalDuration, Number(story.end) || 0)
      }))
      .filter((story) => story.title && story.end - story.start >= 1)
      .sort((a, b) => a.start - b.start);

    const merged = [];
    for (const story of sorted) {
      const prev = merged[merged.length - 1];
      if (!prev) {
        merged.push(story);
        continue;
      }

      const sameWindowDuplicate =
        Math.abs(story.start - prev.start) <= 8 &&
        Math.abs(story.end - prev.end) <= 12 &&
        titleSimilarity(story.title, prev.title) >= 0.5;

      if (sameWindowDuplicate) {
        if (story.end > prev.end) prev.end = story.end;
        if (story.title.length > prev.title.length) prev.title = story.title;
        continue;
      }

      if (story.start < prev.end && story.end > prev.end && titleSimilarity(story.title, prev.title) >= 0.6) {
        prev.end = story.end;
        continue;
      }

      merged.push(story);
    }

    return merged.map((story, index) => ({
      index: index + 1,
      title: story.title,
      start: Math.max(0, story.start),
      end: Math.max(story.start + 1, story.end)
    }));
  }

  async analyzeTranscript(transcriptSegments, totalDuration, onProgress) {
    if (!this.apiKeys.length) {
      throw new Error('Groq API keys not set. Add at least one in Settings.');
    }

    const blocks = this.buildTranscriptBlocks(transcriptSegments);
    if (!blocks.length) {
      throw new Error('Transcript is empty. Whisper returned no usable text.');
    }
    this._allBlocks = blocks;

    const windows = this.buildTranscriptWindows(blocks);
    onProgress?.(`Prepared transcript for Qwen: ${blocks.length} compact blocks, ${windows.length} analysis window(s).`);

    const rawStories = [];
    for (let i = 0; i < windows.length; i++) {
      const window = windows[i];
      const label = `Qwen window ${i + 1}/${windows.length}`;
      onProgress?.(`${label}: analyzing transcript…`);
      const cleanedStories = await this._analyzeWindow(window, totalDuration, onProgress, label);
      onProgress?.(`${label}: found ${cleanedStories.length} story start(s).`);
      rawStories.push(...cleanedStories);
    }

    const merged = this._mergeStories(rawStories, totalDuration);
    if (!merged.length) {
      throw new Error('Qwen returned no usable stories from the transcript.');
    }

    return {
      blocks,
      windows: windows.length,
      stories: merged
    };
  }
}

module.exports = { GroqStoryAnalyzer, GROQ_QWEN_MODEL };
