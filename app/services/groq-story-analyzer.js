const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { normalizeGroqApiKeys, pickAvailableGroqKey, setGroqKeyCooldown } = require('./groq-key-utils');
const { abortableSleep, isAbortError, throwIfAborted } = require('./cancellation');

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

async function waitForGroqChatKey(apiKeys, onProgress, label = 'Qwen', signal) {
  const normalizedKeys = normalizeGroqApiKeys(apiKeys);
  if (!normalizedKeys.length) {
    throw new Error('Groq API keys not set. Add at least one in Settings.');
  }

  while (true) {
    throwIfAborted(signal);
    const selected = pickAvailableGroqKey(normalizedKeys, groqChatKeyCooldowns, groqChatKeyCursor);
    if (selected.apiKey) {
      return selected;
    }

    const waitMs = Math.max(1000, selected.waitMs || DEFAULT_RATE_LIMIT_DELAY_MS);
    onProgress?.(`${label}: all Groq Qwen keys are cooling down. Waiting ${Math.ceil(waitMs / 1000)}s…`);
    await abortableSleep(waitMs, signal);
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

function isJsonGenerationError(err) {
  if (err?.code === 'INVALID_MODEL_JSON') return true;
  if (err?.response?.status !== 400) return false;
  const text = getErrorText(err);
  return /json_validate_failed|failed to validate json|generated json|failed_generation/i.test(text);
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function endsWithSentenceBoundary(text) {
  return /[.!?…][\"'»”)]*$/.test(normalizeText(text));
}

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function clampConfidence(value, fallback = 0.5) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0, numeric));
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
  static REFINEMENT_CONTEXT_BLOCKS = 12;
  static REFINEMENT_LOOKAHEAD_BLOCKS = 24;
  static MAX_REFINEMENT_BLOCKS = 64;

  constructor(apiKeys, proxy) {
    this.apiKeys = normalizeGroqApiKeys(apiKeys);
    this.proxy = proxy || null;
  }

  _buildAxiosConfig(signal) {
    const config = {
      timeout: 180000,
      signal
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
        endsWithSentenceBoundary(current.text) ||
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
      'Find complete, self-contained stories in this spoken transcript.',
      'A story begins at the earliest block needed to understand who/what is being discussed and the setup or premise.',
      'A story ends only after its outcome, answer, punchline, conclusion, or final consequence. Topic changes and unrelated examples belong to another story.',
      'Return JSON only:',
      '{"stories":[{"title":"Короткий заголовок","start_block_id":1,"end_block_id":4,"has_setup":true,"has_resolution":true,"starts_mid_thought":false,"ends_mid_thought":false,"confidence":0.9,"end_may_continue":false}]}',
      'Rules:',
      '- title in Russian, 2-4 words',
      '- chronological order',
      '- do not skip stories',
      '- do not merge unrelated stories',
      '- boundaries MUST be integer block ids printed at the start of transcript lines; never invent timestamps',
      '- include setup/context at the start; never begin on a pronoun, answer, consequence, or continuation that depends on omitted speech',
      '- include the resolution at the end; never stop on an unfinished sentence, unanswered question, setup without payoff, or transition into the conclusion',
      '- short but complete stories are valid; do not extend them merely to reach a target duration',
      '- if the visible transcript ends before the resolution, set end_may_continue=true and use the last relevant visible block as end_block_id',
      '- use overlap blocks only as context',
      `- emit only stories whose START is inside core block ids ${String(coreStartId).padStart(3, '0')}..${String(coreEndId).padStart(3, '0')}`,
      `- if the story starts before block ${String(coreStartId).padStart(3, '0')} (${firstCoreStart.toFixed(2)} sec), omit it`,
      '- if no story starts in core range, return {"stories":[]}',
      `- recording duration ${totalDuration.toFixed(2)} sec`,
      `- visible core end about ${lastCoreEnd.toFixed(2)} sec`,
      'Blocks:',
      transcriptText
    ].join('\n');
  }

  async _requestWindow(apiKey, prompt, reasoningEffort = 'default', signal, requestOptions = {}) {
    throwIfAborted(signal);
    const useJsonMode = requestOptions.useJsonMode !== false;
    const payload = {
      model: GROQ_QWEN_MODEL,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      reasoning_format: 'hidden',
      reasoning_effort: reasoningEffort,
      temperature: 0.2,
      top_p: 0.9,
      max_completion_tokens: Math.max(2048, Number(requestOptions.maxCompletionTokens) || 4096)
    };
    if (useJsonMode) payload.response_format = { type: 'json_object' };

    const response = await axios.post(GROQ_CHAT_URL, payload, {
      ...this._buildAxiosConfig(signal),
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
      const err = new Error('Groq Qwen returned invalid JSON');
      err.code = 'INVALID_MODEL_JSON';
      err.failedGeneration = content.slice(0, 500);
      throw err;
    }
    return parsed;
  }

  async _requestWindowWithRetry(prompt, onProgress, label, signal) {
    let lastErr = null;
    const attempts = [
      { reasoningEffort: 'default', useJsonMode: true, description: 'reasoning + JSON mode' },
      { reasoningEffort: 'none', useJsonMode: true, description: 'non-reasoning JSON mode' },
      { reasoningEffort: 'none', useJsonMode: false, description: 'local JSON recovery' }
    ];

    for (let pass = 0; pass < attempts.length; pass++) {
      const attempt = attempts[pass];
      let rateLimitRetries = 0;
      let transientRetries = 0;

      while (true) {
        throwIfAborted(signal);
        const selectedKey = await waitForGroqChatKey(this.apiKeys, onProgress, label, signal);

        try {
          if (pass > 0) {
            onProgress?.(`${label}: retrying with ${attempt.description}…`);
          }
          return await this._requestWindow(
            selectedKey.apiKey,
            prompt,
            attempt.reasoningEffort,
            signal,
            { useJsonMode: attempt.useJsonMode, maxCompletionTokens: 4096 }
          );
        } catch (err) {
          lastErr = err;
          if (isAbortError(err)) throw err;
          if (isPayloadTooLargeError(err)) {
            throw err;
          }

          if (isJsonGenerationError(err)) {
            if (pass < attempts.length - 1) {
              onProgress?.(`${label}: Groq produced invalid JSON; switching recovery mode…`);
              break;
            }
            throw err;
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
            await abortableSleep(delayMs, signal);
            continue;
          }

          throw err;
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

  async _analyzeWindow(window, totalDuration, onProgress, label, signal) {
    throwIfAborted(signal);
    const prompt = this._buildPrompt(window, totalDuration);
    try {
      const parsed = await this._requestWindowWithRetry(prompt, onProgress, label, signal);
      return this._sanitizeWindowStories(parsed.stories, window, totalDuration);
    } catch (err) {
      if (!isPayloadTooLargeError(err)) throw err;

      const split = this._splitWindow(window);
      if (!split) {
        throw new Error(`${label}: request is still too large for Qwen even after compression.`);
      }

      onProgress?.(`${label}: request too large for Qwen, splitting into smaller windows…`);
      const leftStories = await this._analyzeWindow(split[0], totalDuration, onProgress, `${label}.A`, signal);
      const rightStories = await this._analyzeWindow(split[1], totalDuration, onProgress, `${label}.B`, signal);
      return [...leftStories, ...rightStories];
    }
  }

  _sanitizeWindowStories(rawStories, window, totalDuration) {
    const stories = Array.isArray(rawStories) ? rawStories : [];
    const visibleIds = new Set(window.blocks.map((block) => block.id));
    const coreFirst = window.blocks[window.coreStart - window.windowStart];
    const coreLast = window.blocks[window.coreEnd - window.windowStart];
    const coreStartId = coreFirst?.id || 1;
    const coreEndId = coreLast?.id || this._allBlocks.length;

    return stories
      .map((story) => {
        const title = normalizeText(story?.title).slice(0, 80);
        const startBlockId = this._resolveBlockId(story?.start_block_id, story?.start, 'start');
        const endBlockId = this._resolveBlockId(story?.end_block_id, story?.end, 'end');
        const startBlock = this._allBlocks[startBlockId - 1];
        const endBlock = this._allBlocks[endBlockId - 1];
        const endMayContinue = asBoolean(story?.end_may_continue, false);
        return {
          title,
          startBlockId,
          endBlockId,
          start: startBlock?.start,
          end: Math.min(totalDuration, endBlock?.end ?? totalDuration),
          hasSetup: asBoolean(story?.has_setup, true),
          hasResolution: asBoolean(story?.has_resolution, !endMayContinue),
          startsMidThought: asBoolean(story?.starts_mid_thought, false),
          endsMidThought: asBoolean(story?.ends_mid_thought, false),
          confidence: clampConfidence(story?.confidence),
          endMayContinue
        };
      })
      .filter((story) => story.title && Number.isInteger(story.startBlockId) && Number.isInteger(story.endBlockId))
      .filter((story) => visibleIds.has(story.startBlockId) && visibleIds.has(story.endBlockId))
      .filter((story) => story.endBlockId >= story.startBlockId)
      .filter((story) => Number.isFinite(story.start) && Number.isFinite(story.end))
      .filter((story) => story.end - story.start >= 1)
      .filter((story) => story.startBlockId >= coreStartId && story.startBlockId <= coreEndId);
  }

  _resolveBlockId(rawBlockId, rawTime, edge) {
    const maxId = this._allBlocks.length;
    const numericId = Number(rawBlockId);
    if (Number.isInteger(numericId) && numericId >= 1 && numericId <= maxId) {
      return numericId;
    }

    // Backward-compatible fallback for a model that ignores the schema once.
    const numericTime = Number(rawTime);
    if (!Number.isFinite(numericTime) || maxId === 0) return -1;
    let best = this._allBlocks[0];
    let bestDistance = Infinity;
    for (const block of this._allBlocks) {
      const anchor = edge === 'end' ? block.end : block.start;
      const distance = Math.abs(anchor - numericTime);
      if (distance < bestDistance) {
        best = block;
        bestDistance = distance;
      }
    }
    return best.id;
  }

  _mergeStories(stories, totalDuration) {
    const sorted = [...stories]
      .map((story) => ({
        ...story,
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
        if (story.end > prev.end) {
          prev.end = story.end;
          prev.endBlockId = story.endBlockId;
          prev.hasResolution = story.hasResolution;
          prev.endsMidThought = story.endsMidThought;
          prev.endMayContinue = story.endMayContinue;
        }
        if (story.title.length > prev.title.length) prev.title = story.title;
        prev.confidence = Math.max(prev.confidence || 0, story.confidence || 0);
        continue;
      }

      if (story.start < prev.end && story.end > prev.end && titleSimilarity(story.title, prev.title) >= 0.6) {
        prev.end = story.end;
        prev.endBlockId = story.endBlockId;
        prev.hasResolution = story.hasResolution;
        prev.endsMidThought = story.endsMidThought;
        prev.endMayContinue = story.endMayContinue;
        prev.confidence = Math.max(prev.confidence || 0, story.confidence || 0);
        continue;
      }

      merged.push(story);
    }

    return merged.map((story, index) => ({
      index: index + 1,
      ...story,
      title: story.title,
      start: Math.max(0, story.start),
      end: Math.max(story.start + 1, story.end)
    }));
  }

  _buildRefinementContext(story) {
    const startIndex = Math.max(0, Number(story.startBlockId) - 1);
    const endIndex = Math.max(startIndex, Number(story.endBlockId) - 1);
    const windowStart = Math.max(0, startIndex - GroqStoryAnalyzer.REFINEMENT_CONTEXT_BLOCKS);
    const windowEnd = Math.min(
      this._allBlocks.length - 1,
      endIndex + GroqStoryAnalyzer.REFINEMENT_LOOKAHEAD_BLOCKS
    );
    const full = this._allBlocks.slice(windowStart, windowEnd + 1);
    const maxBlocks = GroqStoryAnalyzer.MAX_REFINEMENT_BLOCKS;

    if (full.length <= maxBlocks) {
      return {
        blocks: full,
        transcriptText: full.map((block) => this._formatBlockLine(block)).join('')
      };
    }

    const headCount = Math.floor(maxBlocks / 2);
    const tailCount = maxBlocks - headCount;
    const head = full.slice(0, headCount);
    const tail = full.slice(-tailCount);
    return {
      blocks: [...head, ...tail],
      transcriptText: [
        ...head.map((block) => this._formatBlockLine(block).trimEnd()),
        '... middle blocks omitted; do not choose an omitted block as a boundary ...',
        ...tail.map((block) => this._formatBlockLine(block).trimEnd())
      ].join('\n') + '\n'
    };
  }

  _buildRefinementPrompt(story, context) {
    const visibleIds = context.blocks.map((block) => block.id);
    const firstId = Math.min(...visibleIds);
    const lastId = Math.max(...visibleIds);
    return [
      'Refine the boundaries of one proposed spoken story.',
      `Candidate title: ${story.title}`,
      `First-pass boundary: blocks ${story.startBlockId}..${story.endBlockId}`,
      'Move the boundaries when necessary. Do not merely judge the first-pass result.',
      'The corrected start must include the minimum setup needed to understand the people, subject, premise, and why the story is being told.',
      'The corrected end must include the answer, outcome, punchline, conclusion, or last relevant consequence.',
      'Exclude the tail of the previous topic and the beginning of the next unrelated topic.',
      'Never start on a continuation, unexplained pronoun, answer, or consequence. Never end mid-sentence, on an unanswered setup, or before the payoff.',
      'Short complete stories are valid. Do not pad for duration.',
      `Choose only block ids visibly printed below (visible range ${firstId}..${lastId}).`,
      'If no complete self-contained version of this candidate exists in the visible context, set complete=false.',
      'Return JSON only:',
      '{"story":{"title":"Короткий заголовок","start_block_id":1,"end_block_id":4,"has_setup":true,"has_resolution":true,"starts_mid_thought":false,"ends_mid_thought":false,"complete":true,"confidence":0.9}}',
      'Transcript:',
      context.transcriptText
    ].join('\n');
  }

  _sanitizeRefinedStory(rawStory, originalStory, context, totalDuration) {
    const visibleIds = new Set(context.blocks.map((block) => block.id));
    const startBlockId = Number(rawStory?.start_block_id);
    const endBlockId = Number(rawStory?.end_block_id);
    if (!Number.isInteger(startBlockId) || !Number.isInteger(endBlockId)) return null;
    if (!visibleIds.has(startBlockId) || !visibleIds.has(endBlockId) || endBlockId < startBlockId) return null;

    const startBlock = this._allBlocks[startBlockId - 1];
    const endBlock = this._allBlocks[endBlockId - 1];
    if (!startBlock || !endBlock) return null;

    const title = normalizeText(rawStory?.title || originalStory.title).slice(0, 80) || originalStory.title;
    const hasSetup = asBoolean(rawStory?.has_setup, true);
    const hasResolution = asBoolean(rawStory?.has_resolution, true);
    const startsMidThought = asBoolean(rawStory?.starts_mid_thought, false);
    const endsMidThought = asBoolean(rawStory?.ends_mid_thought, false);
    const complete = asBoolean(
      rawStory?.complete,
      hasSetup && hasResolution && !startsMidThought && !endsMidThought
    );

    return {
      ...originalStory,
      title,
      startBlockId,
      endBlockId,
      start: Math.max(0, startBlock.start),
      end: Math.min(totalDuration, endBlock.end),
      hasSetup,
      hasResolution,
      startsMidThought,
      endsMidThought,
      complete,
      endMayContinue: !complete || !hasResolution || endsMidThought,
      confidence: clampConfidence(rawStory?.confidence, originalStory.confidence)
    };
  }

  async _refineStory(story, position, totalStories, totalDuration, onProgress, signal) {
    const context = this._buildRefinementContext(story);
    const label = `Qwen boundary check ${position}/${totalStories}`;
    onProgress?.(`${label}: checking setup and resolution…`);
    const parsed = await this._requestWindowWithRetry(
      this._buildRefinementPrompt(story, context),
      onProgress,
      label,
      signal
    );
    const rawStory = parsed?.story || parsed;
    return this._sanitizeRefinedStory(rawStory, story, context, totalDuration);
  }

  _isCompleteStory(story) {
    return !!story &&
      story.hasSetup !== false &&
      story.hasResolution !== false &&
      !story.startsMidThought &&
      !story.endsMidThought &&
      !story.endMayContinue &&
      story.complete !== false;
  }

  async analyzeTranscript(transcriptSegments, totalDuration, onProgress, options = {}) {
    const signal = options.signal;
    throwIfAborted(signal);

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
      throwIfAborted(signal);
      const window = windows[i];
      const label = `Qwen window ${i + 1}/${windows.length}`;
      onProgress?.(`${label}: analyzing transcript…`);
      const cleanedStories = await this._analyzeWindow(window, totalDuration, onProgress, label, signal);
      onProgress?.(`${label}: found ${cleanedStories.length} story start(s).`);
      rawStories.push(...cleanedStories);
    }

    const merged = this._mergeStories(rawStories, totalDuration);
    if (!merged.length) {
      throw new Error('Qwen returned no usable stories from the transcript.');
    }

    const refined = [];
    for (let i = 0; i < merged.length; i++) {
      throwIfAborted(signal);
      const candidate = merged[i];
      try {
        const checked = await this._refineStory(
          candidate,
          i + 1,
          merged.length,
          totalDuration,
          onProgress,
          signal
        );
        if (!checked) {
          if (this._isCompleteStory(candidate)) {
            onProgress?.(`Boundary check ${i + 1}/${merged.length}: invalid block ids, keeping the complete first-pass boundary.`);
            refined.push({ ...candidate, complete: true });
          } else {
            onProgress?.(`Boundary check ${i + 1}/${merged.length}: invalid correction for an incomplete candidate; skipping it.`);
          }
          continue;
        }
        if (!this._isCompleteStory(checked)) {
          onProgress?.(`Boundary check ${i + 1}/${merged.length}: skipped an incomplete story candidate.`);
          continue;
        }
        refined.push(checked);
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (this._isCompleteStory(candidate)) {
          onProgress?.(`Boundary check ${i + 1}/${merged.length} failed (${err.message}); using the complete first-pass boundary.`);
          refined.push({ ...candidate, complete: true });
        } else {
          onProgress?.(`Boundary check ${i + 1}/${merged.length} failed for an incomplete candidate; skipping it.`);
        }
      }
    }

    if (!refined.length) {
      throw new Error('Qwen found candidates, but none had both a complete setup and resolution.');
    }

    return {
      blocks,
      windows: windows.length,
      stories: refined.map((story, index) => ({ ...story, index: index + 1 }))
    };
  }
}

module.exports = { GroqStoryAnalyzer, GROQ_QWEN_MODEL };
