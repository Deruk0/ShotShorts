const { GoogleGenerativeAI, GoogleAIFileManager } = require('@google/generative-ai');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fs = require('fs');
const path = require('path');

class GeminiClient {
  static MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
  ];
  static DEFAULT_RETRY_DELAY_MS = 40_000;
  static MAX_RATE_LIMIT_WAITS = 3;

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

  _getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.flac': 'audio/flac',
      '.webm': 'audio/webm'
    };
    return mimeMap[ext] || 'audio/mpeg';
  }

  _buildFetchOptions() {
    if (!this.proxy || !this.proxy.host) return undefined;
    const { type = 'http', host, port, username, password } = this.proxy;
    const cleanHost = host.replace(/^(https?|socks\d?):\/\//i, '');
    const encUser = username ? encodeURIComponent(String(username)) : '';
    const encPass = password ? encodeURIComponent(String(password)) : '';

    if (type === 'socks5') {
      const url = username
        ? `socks5://${encUser}:${encPass}@${cleanHost}:${port}`
        : `socks5://${cleanHost}:${port}`;
      return { agent: new SocksProxyAgent(url) };
    }

    const proto = type === 'https' ? 'https' : 'http';
    const url = username
      ? `${proto}://${encUser}:${encPass}@${cleanHost}:${port}`
      : `${proto}://${cleanHost}:${port}`;
    return { agent: new HttpsProxyAgent(url) };
  }

  async _uploadAudio(apiKey, audioFilePath, onProgress) {
    const mimeType = this._getMimeType(audioFilePath);
    console.log(`[GeminiClient] Uploading audio to File API: ${audioFilePath}, mime: ${mimeType}`);
    onProgress?.('Uploading audio to Google…');

    const fileManager = new GoogleAIFileManager(apiKey);
    const uploadResult = await fileManager.uploadFile(audioFilePath, {
      mimeType,
      displayName: path.basename(audioFilePath),
    });

    console.log(`[GeminiClient] File uploaded: ${uploadResult.file.uri}, state: ${uploadResult.file.state}`);
    return uploadResult.file;
  }

  async _tryWithModel(modelName, audioFilePath, prompt, onProgress) {
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
        // 1. Upload audio via File API
        const uploadedFile = await this._uploadAudio(apiKey, audioFilePath, onProgress);

        // 2. Generate content with file reference
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: modelName });

        onProgress?.('Analyzing audio with AI…');
        const result = await model.generateContent([
          { text: prompt },
          { fileData: { mimeType: uploadedFile.mimeType, fileUri: uploadedFile.uri } }
        ]);

        onProgress?.('Parsing AI response…');
        const response = await result.response;
        const text = response.text();

        const match = text.match(/\[[\s\S]*\]/);
        if (!match) throw new Error('Gemini response did not contain valid JSON array');

        const segments = JSON.parse(match[0]);
        this._recordSuccess(apiKey);
        console.log(`[GeminiClient] ✓ Success with ${modelName} (key ${masked}), found ${segments.length} stories`);

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
        console.error(`[GeminiClient] ✗ Model ${modelName} attempt ${attempt + 1} failed: ${err.message}`);

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

    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio file not found: ${audioFilePath}`);
    }

    const audioBuffer = fs.readFileSync(audioFilePath);
    console.log(`[GeminiClient] Audio: ${audioFilePath}, size: ${audioBuffer.length} bytes, mime: ${this._getMimeType(audioFilePath)}`);

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

    let lastError = null;

    for (const modelName of GeminiClient.MODELS) {
      console.log(`[GeminiClient] ▶ Trying model: ${modelName}`);
      onProgress?.(`Starting analysis with ${modelName}...`);
      const result = await this._tryWithModel(modelName, audioFilePath, prompt, onProgress);
      if (result && !result.failed) {
        onProgress?.(`✓ Success! Found ${result.length} stories.`);
        return result;
      }
      lastError = result.error;
      onProgress?.(`Error with ${modelName}: ${lastError?.message?.slice(0, 60) || 'Unknown'}. Trying fallback...`);
      console.log(`[GeminiClient] ✗ Model ${modelName} failed, trying next fallback...`);
    }

    throw new Error(`Gemini analysis failed on all models (${GeminiClient.MODELS.join(', ')}). Last error: ${lastError?.message}`);
  }
}

module.exports = { GeminiClient };
