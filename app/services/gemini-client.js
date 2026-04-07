const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const https = require('https');
const fs = require('fs');
const path = require('path');

class GeminiClient {
  static MODELS = ['gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-2.0-flash', 'gemini-3.1-flash-lite-preview'];
  static DEFAULT_RETRY_DELAY_MS = 40_000;
  static MAX_RATE_LIMIT_WAITS = 3;
  static API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

  static _keyCooldowns = new Map();
  static _keyUsageCount = new Map();

  static reset() {
    GeminiClient._keyCooldowns.clear();
    GeminiClient._keyUsageCount.clear();
  }

  constructor(keys, proxy) {
    this.keys = keys;
    this.proxy = proxy;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _parseRetryDelay(error) {
    const msg = error.message || '';
    const match = msg.match(/retry\s*(?:in|after|delay)[:\s]*(\d+\.?\d*)\s*s/i)
      || msg.match(/"retryDelay"\s*:\s*"(\d+\.?\d*)s"/i);
    if (match) return Math.ceil(parseFloat(match[1]) * 1000);
    return GeminiClient.DEFAULT_RETRY_DELAY_MS;
  }

  _isRateLimitError(err) {
    const msg = (err.message || '').toLowerCase();
    return msg.includes('429') || msg.includes('quota') || msg.includes('rate_limit') || msg.includes('too many requests') || msg.includes('resource_exhausted');
  }

  _setCooldown(apiKey, delayMs, modelName) {
    GeminiClient._keyCooldowns.set(apiKey, {
      availableAt: Date.now() + delayMs,
      model: modelName
    });
    const masked = apiKey.slice(0, 6) + '…' + apiKey.slice(-4);
    console.log(`[GeminiClient] Key ${masked} on cooldown for ${Math.round(delayMs / 1000)}s`);
  }

  _isOnCooldown(apiKey) {
    const cd = GeminiClient._keyCooldowns.get(apiKey);
    if (!cd) return false;
    if (Date.now() >= cd.availableAt) {
      GeminiClient._keyCooldowns.delete(apiKey);
      return false;
    }
    return true;
  }

  _getAvailableKey() {
    let bestKey = null;
    let bestUsage = Infinity;
    for (const key of this.keys) {
      if (this._isOnCooldown(key)) continue;
      const usage = GeminiClient._keyUsageCount.get(key) || 0;
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
      const cd = GeminiClient._keyCooldowns.get(key);
      if (cd && cd.availableAt < earliest) {
        earliest = cd.availableAt;
        earliestKey = key;
      }
    }
    if (!earliestKey) return this.keys[0];
    const waitMs = Math.max(earliest - Date.now(), 0) + 2000;
    console.log(`[GeminiClient] All keys on cooldown. Waiting ${Math.round(waitMs / 1000)}s for next available key...`);
    await this._sleep(waitMs);
    GeminiClient._keyCooldowns.delete(earliestKey);
    return earliestKey;
  }

  _recordSuccess(apiKey) {
    const count = GeminiClient._keyUsageCount.get(apiKey) || 0;
    GeminiClient._keyUsageCount.set(apiKey, count + 1);
  }

  _buildAgent() {
    if (!this.proxy || !this.proxy.host) return undefined;
    const { type = 'http', host, port, username, password } = this.proxy;
    const cleanHost = host.replace(/^(https?|socks\d?):\/\//i, '');

    if (type === 'socks5') {
      const url = username
        ? `socks5://${username}:${password}@${cleanHost}:${port}`
        : `socks5://${cleanHost}:${port}`;
      return new SocksProxyAgent(url);
    }

    const proto = type === 'https' ? 'https' : 'http';
    const url = username
      ? `${proto}://${username}:${password}@${cleanHost}:${port}`
      : `${proto}://${cleanHost}:${port}`;
    return new HttpsProxyAgent(url);
  }

  // Direct HTTPS request — bypasses SDK's fetch which ignores proxy agents
  _makeRequest(url, body, agent, onProgress) {
    return new Promise((resolve, reject) => {
      onProgress?.('Preparing request...');
      const parsed = new URL(url);
      const postData = JSON.stringify(body);

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      if (agent) options.agent = agent;

      let hasResponded = false;
      let isConnected = false;

      const req = https.request(options, (res) => {
        hasResponded = true;
        onProgress?.('Receiving response... (0%)');
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          onProgress?.('Parsing response...');
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            const json = JSON.parse(raw);
            if (res.statusCode !== 200) {
              const errMsg = json.error?.message || `HTTP ${res.statusCode}`;
              reject(new Error(`[${res.statusCode}] ${errMsg}`));
            } else {
              resolve(json);
            }
          } catch {
            reject(new Error(`Invalid JSON response (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`));
          }
        });
      });

      req.on('socket', (socket) => {
        onProgress?.('Connecting to Google (via proxy)...');
        socket.on('connect', () => {
          isConnected = true;
          onProgress?.('Connected! Uploading audio payload...');
        });
      });

      req.on('error', reject);
      
      // Strict 30-second timeout for connection/initial response if proxy is dead
      const timeoutId = setTimeout(() => {
        if (!hasResponded) {
          req.destroy();
          reject(new Error(`Request timeout (${isConnected ? 'AI processing' : 'Proxy connection'} took more than 45s)`));
        }
      }, 45_000);

      req.on('close', () => clearTimeout(timeoutId));

      req.write(postData, () => {
        onProgress?.('Upload complete. Awaiting AI response...');
      });
      req.end();
    });
  }

  async _tryWithModel(modelName, audioFilePath, audioBase64, mimeType, prompt, onProgress) {
    const maxAttempts = this.keys.length * 2;
    let lastError = null;
    let rateLimitWaits = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let apiKey = this._getAvailableKey();
      if (!apiKey) {
        if (rateLimitWaits >= GeminiClient.MAX_RATE_LIMIT_WAITS) {
          console.log(`[GeminiClient] All keys exhausted on ${modelName} after ${rateLimitWaits} waits. Giving up on this model.`);
          break;
        }
        onProgress?.(`Rate limited! Waiting for API key...`);
        apiKey = await this._waitForNextAvailableKey();
        rateLimitWaits++;
      }

      const masked = apiKey.slice(0, 6) + '…' + apiKey.slice(-4);
      console.log(`[GeminiClient] Attempt ${attempt + 1}/${maxAttempts} | Model: ${modelName} | Key: ${masked}`);
      onProgress?.(`Initializing model ${modelName} (attempt ${attempt + 1}/${maxAttempts})`);

      try {
        const agent = this._buildAgent();
        if (agent) {
          console.log(`[GeminiClient] Using proxy: ${this.proxy.type || 'http'}://${this.proxy.host}:${this.proxy.port}`);
        }

        const url = `${GeminiClient.API_BASE}/${modelName}:generateContent?key=${apiKey}`;
        const body = {
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: audioBase64 } }
            ]
          }]
        };

        const json = await this._makeRequest(url, body, agent, onProgress);

        const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) throw new Error('Gemini response did not contain valid JSON array');

        const segments = JSON.parse(match[0]);
        this._recordSuccess(apiKey);
        console.log(`[GeminiClient] ✓ Success with ${modelName} (key ${masked})`);

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

        if (err.message.includes('[400]') || err.message.includes('[404]')) {
          console.log(`[GeminiClient] Fatal error ${err.message}, aborting this model.`);
          break;
        }

        if (this._isRateLimitError(err)) {
          const delayMs = this._parseRetryDelay(err);
          this._setCooldown(apiKey, delayMs, modelName);
          continue;
        }

        if (attempt < maxAttempts - 1) continue;
      }
    }

    return { failed: true, error: lastError };
  }

  async analyzeAudio(audioFilePath, onProgress) {
    GeminiClient.reset();
    onProgress?.('Reading optimized audio file...');
    const audioBuffer = fs.readFileSync(audioFilePath);
    const audioBase64 = audioBuffer.toString('base64');
    const ext = path.extname(audioFilePath).toLowerCase();
    const mimeMap = { '.mp3':'audio/mp3', '.wav':'audio/wav', '.ogg':'audio/ogg', '.m4a':'audio/mp4', '.aac':'audio/aac', '.flac':'audio/flac', '.webm':'audio/webm' };
    const mimeType = mimeMap[ext] || 'audio/mp3';

    const prompt = `You are an audio analyst. This audio file contains multiple Reddit stories narrated one after another.
Between each story there is a distinct transition sound (like a "whoosh" or swoosh effect).

Your task:
1. Listen to the entire audio carefully.
2. Identify each individual story by detecting the transition sounds between them.
3. For each story, provide the START timestamp and END timestamp in seconds (decimal, e.g. 123.45).
4. Give each story a short descriptive title based on the FIRST SENTENCE of the story. The title MUST be in Russian language.

IMPORTANT:
- The first story starts at 0.0 seconds (or close to it after any intro).
- The last story ends at the end of the audio.
- Be precise with timestamps — the transition sound marks the BOUNDARY between stories.
- The title should be the first sentence of the story, translated to Russian.
- Respond ONLY with valid JSON, no markdown, no explanation.

Response format:
[
  {"index": 1, "title": "Короткое название на русском", "start": 0.0, "end": 125.3},
  {"index": 2, "title": "Короткое название на русском", "start": 127.8, "end": 298.1}
]`;

    let lastError = null;

    for (const modelName of GeminiClient.MODELS) {
      console.log(`[GeminiClient] ▶ Trying model: ${modelName}`);
      onProgress?.(`Starting analysis with ${modelName}...`);
      const result = await this._tryWithModel(modelName, audioFilePath, audioBase64, mimeType, prompt, onProgress);
      if (result && !result.failed) {
        onProgress?.(`✓ Success! Decoded frames.`);
        return result;
      }
      lastError = result.error;
      onProgress?.(`Error with ${modelName}: ${lastError?.message?.slice(0, 40) || 'Unknown'}. Trying fallback...`);
      console.log(`[GeminiClient] ✗ Model ${modelName} failed, trying next fallback...`);
    }

    throw new Error(`Gemini analysis failed on all models (${GeminiClient.MODELS.join(', ')}). Last error: ${lastError?.message}`);
  }
}

module.exports = { GeminiClient };
