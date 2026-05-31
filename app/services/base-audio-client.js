const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');

class BaseAudioClient {
  static DEFAULT_RETRY_DELAY_MS = 40_000;
  static MAX_RATE_LIMIT_WAITS = 3;

  static _keyCooldowns = new Map();
  static _keyUsageCount = new Map();

  static reset() {
    BaseAudioClient._keyCooldowns.clear();
    BaseAudioClient._keyUsageCount.clear();
  }

  constructor(keys, proxy) {
    this.keys = keys;
    this.proxy = proxy;
  }

  // --- Abstract getters (must be implemented by subclasses) ---
  get apiUrl() {
    throw new Error('apiUrl getter must be implemented by subclass');
  }

  get model() {
    throw new Error('model getter must be implemented by subclass');
  }

  get providerName() {
    throw new Error('providerName getter must be implemented by subclass');
  }

  // --- Headers builder (can be overridden) ---
  _buildHeaders(apiKey) {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  // --- Payload builder (can be overridden) ---
  _buildPayload(audioBase64, prompt) {
    return {
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt,
            },
            {
              type: 'input_audio',
              input_audio: {
                data: audioBase64,
                format: 'mp3',
              },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    };
  }

  // --- Shared utilities ---
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _parseRetryDelay(error) {
    const msg = error.message || '';
    const match = msg.match(/retry\s*(?:in|after|delay)[:\s]*(\d+\.?\d*)\s*s/i)
      || msg.match(/"retryDelay"\s*:\s*"(\d+\.?\d*)s"/i)
      || msg.match(/retry[_\s-]?after[:\s]*(\d+)/i);
    if (match) return Math.ceil(parseFloat(match[1]) * 1000);
    return BaseAudioClient.DEFAULT_RETRY_DELAY_MS;
  }

  _isRateLimitError(err) {
    const msg = (err.message || '').toLowerCase();
    return msg.includes('429') || msg.includes('quota') || msg.includes('rate_limit') || msg.includes('too many requests');
  }

  _setCooldown(apiKey, delayMs) {
    BaseAudioClient._keyCooldowns.set(apiKey, {
      availableAt: Date.now() + delayMs,
    });
    const masked = apiKey.slice(0, 6) + '…' + apiKey.slice(-4);
    console.log(`[${this.constructor.name}] Key ${masked} on cooldown for ${Math.round(delayMs / 1000)}s`);
  }

  _isOnCooldown(apiKey) {
    const cd = BaseAudioClient._keyCooldowns.get(apiKey);
    if (!cd) return false;
    if (Date.now() >= cd.availableAt) {
      BaseAudioClient._keyCooldowns.delete(apiKey);
      return false;
    }
    return true;
  }

  _getAvailableKey() {
    let bestKey = null;
    let bestUsage = Infinity;
    for (const key of this.keys) {
      if (this._isOnCooldown(key)) continue;
      const usage = BaseAudioClient._keyUsageCount.get(key) || 0;
      if (usage < bestUsage) {
        bestKey = key;
        bestUsage = usage;
      }
    }
    return bestKey;
  }

  async _waitForNextAvailableKey() {
    let earliest = Infinity;
    let earliestKey = null;
    for (const key of this.keys) {
      const cd = BaseAudioClient._keyCooldowns.get(key);
      if (cd && cd.availableAt < earliest) {
        earliest = cd.availableAt;
        earliestKey = key;
      }
    }
    if (!earliestKey) return this.keys[0];
    const waitMs = Math.max(earliest - Date.now(), 0) + 2000;
    console.log(`[${this.constructor.name}] All keys on cooldown. Waiting ${Math.round(waitMs / 1000)}s for next available key...`);
    await this._sleep(waitMs);
    BaseAudioClient._keyCooldowns.delete(earliestKey);
    return earliestKey;
  }

  _recordSuccess(apiKey) {
    const count = BaseAudioClient._keyUsageCount.get(apiKey) || 0;
    BaseAudioClient._keyUsageCount.set(apiKey, count + 1);
  }

  _extractJsonArray(text) {
    if (!text) return null;

    // Strategy 1: Find all [...] blocks and try parsing from last to first
    // (reasoning models often put the final answer at the end)
    const matches = [];
    let depth = 0;
    let start = -1;

    for (let i = 0; i < text.length; i++) {
      if (text[i] === '[') {
        if (depth === 0) start = i;
        depth++;
      } else if (text[i] === ']') {
        depth--;
        if (depth === 0 && start !== -1) {
          matches.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }

    // Try parsing from the LAST match backward (reasoning models put answer at end)
    for (let i = matches.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(matches[i]);
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log(`[${this.constructor.name}] Found valid JSON array with ${parsed.length} items (match ${i + 1}/${matches.length})`);
          return parsed;
        }
      } catch {
        // Continue to next match
      }
    }

    // Strategy 2: If response_format was used, the content might be a JSON object wrapper
    try {
      const wrapped = JSON.parse(text);
      if (wrapped && typeof wrapped === 'object') {
        for (const key of Object.keys(wrapped)) {
          const val = wrapped[key];
          if (Array.isArray(val) && val.length > 0) return val;
          if (typeof val === 'string') {
            try {
              const inner = JSON.parse(val);
              if (Array.isArray(inner) && inner.length > 0) return inner;
            } catch {}
          }
        }
      }
    } catch {}

    // Strategy 3: Find JSON in markdown code blocks ```json [...] ```
    const codeBlockMatches = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
    for (const match of codeBlockMatches) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {}
      // Maybe the array is wrapped in extra text inside the code block
      const innerMatch = match[1].match(/\[[\s\S]*\]/);
      if (innerMatch) {
        try {
          const parsed = JSON.parse(innerMatch[0]);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        } catch {}
      }
    }

    // Strategy 4: Find any {...} block that might contain an array
    const objMatches = [];
    let objDepth = 0;
    let objStart = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') {
        if (objDepth === 0) objStart = i;
        objDepth++;
      } else if (text[i] === '}') {
        objDepth--;
        if (objDepth === 0 && objStart !== -1) {
          try {
            const parsed = JSON.parse(text.slice(objStart, i + 1));
            if (parsed && typeof parsed === 'object') {
              for (const key of Object.keys(parsed)) {
                const val = parsed[key];
                if (Array.isArray(val) && val.length > 0) return val;
              }
            }
          } catch {}
          objStart = -1;
        }
      }
    }

    return null;
  }

  _buildAxiosConfig() {
    const config = {
      timeout: 600000, // 10 minutes for audio analysis
    };

    if (this.proxy && this.proxy.host) {
      const { type = 'http', host, port, username, password } = this.proxy;
      const cleanHost = host.replace(/^(https?|socks\d?):\/\//i, '');
      const encUser = username ? encodeURIComponent(String(username)) : '';
      const encPass = password ? encodeURIComponent(String(password)) : '';

      if (type === 'socks5') {
        const url = username
          ? `socks5://${encUser}:${encPass}@${cleanHost}:${port}`
          : `socks5://${cleanHost}:${port}`;
        config.httpsAgent = new SocksProxyAgent(url);
      } else {
        const proto = type === 'https' ? 'https' : 'http';
        const url = username
          ? `${proto}://${encUser}:${encPass}@${cleanHost}:${port}`
          : `${proto}://${cleanHost}:${port}`;
        config.httpsAgent = new HttpsProxyAgent(url);
      }
    }

    return config;
  }

  async _convertAudioToMp3(audioFilePath, onProgress) {
    const ext = path.extname(audioFilePath).toLowerCase();
    if (ext === '.mp3') {
      return audioFilePath;
    }

    const outPath = path.join(os.tmpdir(), `ss_audio_${Date.now()}.mp3`);
    onProgress?.('Converting audio to MP3 for upload…');

    return new Promise((resolve, reject) => {
      ffmpeg(audioFilePath)
        .audioCodec('libmp3lame')
        .audioBitrate(128)
        .audioChannels(1)
        .audioFrequency(16000)
        .format('mp3')
        .output(outPath)
        .on('end', () => resolve(outPath))
        .on('error', (e, stdout, stderr) => {
          reject(new Error(`MP3 conversion failed: ${e.message}${stderr ? '\nstderr: ' + stderr : ''}`));
        })
        .run();
    });
  }

  async _encodeAudioToBase64(audioFilePath) {
    const buffer = fs.readFileSync(audioFilePath);
    return buffer.toString('base64');
  }

  async _callApi(apiKey, audioBase64, prompt, onProgress) {
    const masked = apiKey.slice(0, 6) + '…' + apiKey.slice(-4);
    console.log(`[${this.constructor.name}] Calling ${this.providerName} with key ${masked}`);
    onProgress?.(`Sending audio to NVIDIA Nemotron AI via ${this.providerName}…`);

    const payload = this._buildPayload(audioBase64, prompt);
    const axiosConfig = this._buildAxiosConfig();
    const response = await axios.post(this.apiUrl, payload, {
      ...axiosConfig,
      headers: this._buildHeaders(apiKey),
    });

    if (!response.data || !response.data.choices || !response.data.choices[0]) {
      throw new Error(`Invalid response structure from ${this.providerName}`);
    }

    const msg = response.data.choices[0].message;
    
    // Try all possible text sources to find JSON
    const sources = [
      { name: 'content', text: msg?.content || '' },
      { name: 'reasoning', text: msg?.reasoning || '' },
      { name: 'reasoning_content', text: msg?.reasoning_content || '' },
    ];
    
    for (const src of sources) {
      if (src.text) {
        const extracted = this._extractJsonArray(src.text);
        if (extracted) {
          return JSON.stringify(extracted);
        }
      }
    }
    
    // If no JSON found anywhere, return content as text for backward compat
    const text = msg?.content || msg?.reasoning || msg?.reasoning_content || '';
    if (!text) {
      throw new Error(`Empty response from ${this.providerName}`);
    }

    return text;
  }

  async _tryAnalyze(audioFilePath, prompt, onProgress) {
    const maxAttempts = this.keys.length * 2;
    let lastError = null;
    let rateLimitWaits = 0;

    let mp3Path = null;
    try {
      mp3Path = await this._convertAudioToMp3(audioFilePath, onProgress);
      const stats = fs.statSync(mp3Path);
      console.log(`[${this.constructor.name}] Audio MP3: ${mp3Path}, size: ${stats.size} bytes`);

      if (stats.size > 10 * 1024 * 1024) {
        console.warn(`[${this.constructor.name}] Warning: Audio file is ${Math.round(stats.size / 1024 / 1024)}MB, may exceed provider limits`);
      }

      onProgress?.('Encoding audio for upload…');
      const audioBase64 = await this._encodeAudioToBase64(mp3Path);

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let apiKey = this._getAvailableKey();
        if (!apiKey) {
          if (rateLimitWaits >= BaseAudioClient.MAX_RATE_LIMIT_WAITS) {
            console.log(`[${this.constructor.name}] All keys exhausted after ${rateLimitWaits} waits. Giving up.`);
            break;
          }
          onProgress?.(`Rate limited! Waiting for API key...`);
          apiKey = await this._waitForNextAvailableKey();
          rateLimitWaits++;
        }

        const masked = apiKey.slice(0, 6) + '…' + apiKey.slice(-4);
        console.log(`[${this.constructor.name}] Attempt ${attempt + 1}/${maxAttempts} | Key: ${masked}`);
        onProgress?.(`Initializing Nemotron analysis (attempt ${attempt + 1}/${maxAttempts})`);

        try {
          onProgress?.('Analyzing audio with AI…');
          const text = await this._callApi(apiKey, audioBase64, prompt, onProgress);

          onProgress?.('Parsing AI response…');
          const segments = this._extractJsonArray(text);
          if (!segments) {
            // Write full response to debug file for troubleshooting
            const debugPath = path.join(os.tmpdir(), `shotshorts_debug_${Date.now()}.txt`);
            const debugContent = `=== ShotShorts NVIDIA Debug Log ===\nTimestamp: ${new Date().toISOString()}\nProvider: ${this.providerName}\nModel: ${this.model}\n\n=== FULL RESPONSE TEXT (${text.length} chars) ===\n${text}\n\n=== END ===`;
            try { fs.writeFileSync(debugPath, debugContent, 'utf8'); } catch {}
            
            const preview = text.slice(0, 300).replace(/\n/g, ' ');
            throw new Error(`${this.providerName} response did not contain valid JSON array. Preview: ${preview}...\n\nDebug file saved to: ${debugPath}`);
          }

          this._recordSuccess(apiKey);
          console.log(`[${this.constructor.name}] Success with key ${masked}, found ${segments.length} stories`);

          return segments.map((s, i) => {
            const st = Number(s.start) || 0;
            const en = Number(s.end) || 0;
            return {
              index: s.index || i + 1,
              title: s.title || `Story ${i + 1}`,
              start: st,
              end: en
            };
          }).filter(s => s.end > s.start);
        } catch (err) {
          lastError = err;
          console.error(`[${this.constructor.name}] Attempt ${attempt + 1} failed: ${err.message}`);

          if (this._isRateLimitError(err)) {
            const delayMs = this._parseRetryDelay(err);
            this._setCooldown(apiKey, delayMs);
            continue;
          }

          if (attempt < maxAttempts - 1) continue;
        }
      }
    } finally {
      if (mp3Path && mp3Path !== audioFilePath) {
        try { fs.unlinkSync(mp3Path); } catch {}
      }
    }

    return { failed: true, error: lastError };
  }

  async analyzeAudio(audioFilePath, onProgress) {
    BaseAudioClient.reset();
    onProgress?.('Reading optimized audio file...');

    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio file not found: ${audioFilePath}`);
    }

    const audioBuffer = fs.readFileSync(audioFilePath);
    console.log(`[${this.constructor.name}] Audio: ${audioFilePath}, size: ${audioBuffer.length} bytes`);

    const prompt = `You are an audio analyst. This audio file contains multiple stories narrated one after another.

Your task:
1. Listen to the entire audio carefully from start to finish.
2. Identify EVERY individual story. Do NOT skip any story. Do NOT merge stories together.
3. For each story, provide the START timestamp and END timestamp in seconds (decimal, e.g. 123.45).
4. Give each story a VERY SHORT title (maximum 3-4 words) that captures the meaning of the FIRST SENTENCE of the story. The title MUST be in Russian language.

IMPORTANT RULES:
- The first story starts at 0.0 seconds (or close to it after any intro).
- The last story ends at the end of the audio.
- Every story MUST be in the output. Do not omit any story.
- Do NOT merge multiple stories into one entry.
- Be precise with timestamps — detect natural pauses, music changes, or transition sounds between stories.
- The title MUST be very short (max 3-4 words) and based strictly on the first sentence of the story.
- Respond ONLY with valid JSON array, no markdown, no explanation.

Response format:
[
  {"index": 1, "title": "Короткое название на русском", "start": 0.0, "end": 125.3},
  {"index": 2, "title": "Короткое название на русском", "start": 127.8, "end": 298.1}
]`;

    console.log(`[${this.constructor.name}] Starting analysis with model: ${this.model}`);
    onProgress?.(`Starting analysis with Nemotron 3 Nano Omni...`);

    const result = await this._tryAnalyze(audioFilePath, prompt, onProgress);

    if (result && !result.failed) {
      onProgress?.(`Success! Found ${result.length} stories.`);
      return result;
    }

    throw new Error(`${this.providerName} analysis failed. Last error: ${result.error?.message}`);
  }
}

module.exports = { BaseAudioClient };
