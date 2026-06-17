const { BaseAudioClient } = require('./base-audio-client');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const os = require('os');
const path = require('path');

class NvidiaClient extends BaseAudioClient {
  // NVIDIA reasoning models often run out of tokens on long audio (>10 min).
  // We split audio into chunks to ensure reliable analysis.
  static FULL_SEND_THRESHOLD_MIN = 5;
  static CHUNK_DURATION_MIN = 5;
  static CHUNK_OVERLAP_SEC = 30;

  get apiUrl() {
    return 'https://integrate.api.nvidia.com/v1/chat/completions';
  }

  get model() {
    return 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
  }

  get providerName() {
    return 'NVIDIA NIM';
  }

  _buildHeaders(apiKey) {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  _buildAxiosConfig() {
    return { ...super._buildAxiosConfig(), timeout: 900000 }; // 15 min for NVIDIA reasoning models
  }

  // Override payload for NVIDIA: higher max_tokens for reasoning models
  _buildPayload(audioBase64, prompt) {
    return {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'Be extremely concise in your analysis. Do not explain your reasoning — output ONLY the JSON array.',
        },
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
      temperature: 0.0,
      // Bounded so a degenerate repetition loop can't run to 65k tokens (a 5-min
      // chunk needs only a few hundred tokens of JSON). 16k leaves ample room.
      max_tokens: 16384,
      reasoning_budget: 8192,
      grace_period: 1024,
      // Anti-degeneration: reasoning models at temp=0 are prone to repeating the
      // same object forever. Penalties discourage the loop without hurting accuracy.
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
    };
  }

  // Override _callApi: NVIDIA reasoning models put final JSON in 'content', reasoning in 'reasoning'
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
      throw new Error('Invalid response structure from NVIDIA NIM');
    }

    const msg = response.data.choices[0].message;
    
    // For NVIDIA reasoning models:
    // - 'content' contains the final answer (may be JSON or empty if reasoning consumed all tokens)
    // - 'reasoning' contains the thinking process (we ignore it)
    const content = msg?.content || '';
    const reasoning = msg?.reasoning || '';
    
    const finishReason = response.data.choices[0]?.finish_reason;
    console.log(`[NvidiaClient] content length: ${content.length} | reasoning length: ${reasoning.length} | finish_reason: ${finishReason}`);
    
    // Strategy 1: If content starts with '[' it's likely direct JSON
    if (content.trim().startsWith('[')) {
      console.log(`[NvidiaClient] content starts with '[', returning directly`);
      return content;
    }

    // Strategy 2: Try to find JSON array in content
    if (content) {
      const extracted = this._extractJsonArray(content);
      if (extracted) {
        console.log(`[NvidiaClient] Found JSON array in content`);
        return JSON.stringify(extracted);
      }
    }

    // Strategy 3: If content is empty/missing, try extracting from reasoning (model ran out of tokens)
    if (reasoning) {
      const extracted = this._extractJsonArray(reasoning);
      if (extracted) {
        console.log(`[NvidiaClient] Found JSON array in reasoning (fallback after token exhaustion)`);
        return JSON.stringify(extracted);
      }
    }

    // Strategy 4: Check if finish_reason is 'length' — partial response
    if (finishReason === 'length') {
      console.log(`[NvidiaClient] finish_reason=length, model hit token limit`);
      if (content) {
        const extracted = this._extractJsonArray(content);
        if (extracted) return JSON.stringify(extracted);
      }
      if (reasoning) {
        const extracted = this._extractJsonArray(reasoning);
        if (extracted) return JSON.stringify(extracted);
      }
      throw new Error('NVIDIA NIM ran out of tokens. Try a shorter audio file or use OpenRouter provider.');
    }

    // Nothing found
    const text = content || reasoning || '';
    if (!text) {
      throw new Error('Empty response from NVIDIA NIM');
    }
    return text;
  }

  // Override MP3 conversion for NVIDIA: lower bitrate to keep payload smaller
  async _convertAudioToMp3(audioFilePath, onProgress) {
    const ext = path.extname(audioFilePath).toLowerCase();
    if (ext === '.mp3') {
      return audioFilePath;
    }

    const outPath = path.join(os.tmpdir(), `ss_nvidia_audio_${Date.now()}.mp3`);
    onProgress?.('Converting audio to MP3 for NVIDIA (optimized bitrate)…');

    return new Promise((resolve, reject) => {
      ffmpeg(audioFilePath)
        .audioCodec('libmp3lame')
        .audioBitrate(32)
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

  async _getAudioDuration(audioFilePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioFilePath, (err, metadata) => {
        if (err) return reject(err);
        const duration = metadata.format?.duration || 0;
        resolve(Number(duration) || 0);
      });
    });
  }

  async _splitAudioIntoChunks(audioFilePath, chunkDurationSec, overlapSec, onProgress) {
    const totalDuration = await this._getAudioDuration(audioFilePath);
    if (!totalDuration || totalDuration <= chunkDurationSec) {
      return [{ path: audioFilePath, offset: 0 }];
    }

    const chunks = [];
    const tmpDir = os.tmpdir();
    let start = 0;
    let index = 0;

    while (start < totalDuration) {
      const duration = Math.min(chunkDurationSec + overlapSec, totalDuration - start);
      const outPath = path.join(tmpDir, `ss_nvidia_chunk_${index}_${Date.now()}.mp3`);

      await new Promise((resolve, reject) => {
        ffmpeg(audioFilePath)
          .setStartTime(start)
          .setDuration(duration)
          .audioCodec('libmp3lame')
          .audioBitrate(32)
          .audioChannels(1)
          .audioFrequency(16000)
          .format('mp3')
          .output(outPath)
          .on('end', () => resolve())
          .on('error', (e) => reject(new Error(`Chunk ${index} failed: ${e.message}`)))
          .run();
      });

      chunks.push({ path: outPath, offset: start, duration });
      onProgress?.(`Prepared chunk ${index + 1}: ${start.toFixed(1)}s - ${(start + duration).toFixed(1)}s`);
      start += chunkDurationSec;
      index++;
    }

    return chunks;
  }

  _isChunkableError(err) {
    if (!err) return false;
    const status = err.response?.status;
    const msg = (err.message || '').toLowerCase();
    return status === 500 || status === 502 || status === 503 ||
           msg.includes('econnreset') || msg.includes('timeout') ||
           msg.includes('internal server') || msg.includes('bad gateway');
  }

  async _analyzeSingle(audioFilePath, prompt, onProgress) {
    // Returns { segments: [...] } or throws
    const result = await this._tryAnalyze(audioFilePath, prompt, onProgress);
    if (result && !result.failed) {
      return result;
    }
    throw result.error || new Error('Unknown analysis error');
  }

  _deduplicateSegments(segments) {
    // Sort by start time
    segments.sort((a, b) => a.start - b.start);

    const DEDUP_TOLERANCE_SEC = 15; // Half of the 30s overlap — catches duplicates without merging different stories
    const unique = [];
    for (const seg of segments) {
      const last = unique[unique.length - 1];
      if (last && Math.abs(seg.start - last.start) < DEDUP_TOLERANCE_SEC && Math.abs(seg.end - last.end) < DEDUP_TOLERANCE_SEC) {
        continue; // Skip duplicate
      }
      unique.push(seg);
    }

    // Re-index
    return unique.map((seg, i) => ({
      ...seg,
      index: i + 1,
    }));
  }

  async analyzeAudio(audioFilePath, onProgress) {
    BaseAudioClient.reset();
    onProgress?.('Reading optimized audio file...');

    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio file not found: ${audioFilePath}`);
    }

    const audioBuffer = fs.readFileSync(audioFilePath);
    console.log(`[NvidiaClient] Audio: ${audioFilePath}, size: ${audioBuffer.length} bytes`);

    const promptFirst = `Listen to this audio. It contains multiple stories told one after another.

For EACH story output: index, short Russian title (3-4 words), start and end timestamps in seconds.

Rules: no merging stories, no skipping. Be concise in your thinking — output ONLY a JSON array.

[{"index":1,"title":"Заголовок","start":0.0,"end":125.3}]`;

    const promptContinuation = `This audio is a CONTINUATION of a longer recording. Timestamps are relative to THIS clip (0.0 = start).

For EACH story in this clip output: index, short Russian title (3-4 words), start and end timestamps in seconds.

Rules: no merging, no skipping. Stories may start at 0.0 (continued from previous clip). Be concise — output ONLY a JSON array.

[{"index":1,"title":"Заголовок","start":0.0,"end":125.3}]`;

    const durationSec = await this._getAudioDuration(audioFilePath);
    const durationMin = durationSec / 60;
    const thresholdMin = NvidiaClient.FULL_SEND_THRESHOLD_MIN;

    let tempMp3 = null;
    const tempChunks = [];

    try {
      // Step 1: Convert to optimized MP3
      onProgress?.('Optimizing audio for NVIDIA NIM (low bitrate)…');
      tempMp3 = await this._convertAudioToMp3(audioFilePath, onProgress);

      // Step 2: Try sending as a whole (if under threshold)
      let segments = null;
      let wholeFailed = false;

      if (durationMin <= thresholdMin) {
        console.log(`[NvidiaClient] Audio is ${durationMin.toFixed(1)} min (<= ${thresholdMin} min), sending as whole…`);
        onProgress?.(`Sending ${durationMin.toFixed(1)} min audio to NVIDIA NIM…`);
        try {
          segments = await this._analyzeSingle(tempMp3, promptFirst, onProgress);
        } catch (err) {
          if (this._isChunkableError(err)) {
            console.log(`[NvidiaClient] Whole-audio failed with chunkable error (${err.message}), will retry with chunks.`);
            wholeFailed = true;
          } else {
            throw err; // Non-recoverable error (401, 429, etc.)
          }
        }
      } else {
        console.log(`[NvidiaClient] Audio is ${durationMin.toFixed(1)} min (> ${thresholdMin} min), will use chunking.`);
        wholeFailed = true;
      }

      // Step 3: If whole failed (or too long), split into chunks
      if (wholeFailed) {
        const chunkDuration = NvidiaClient.CHUNK_DURATION_MIN * 60;
        const overlap = NvidiaClient.CHUNK_OVERLAP_SEC;

        onProgress?.(`Audio too long for single request. Splitting into ${NvidiaClient.CHUNK_DURATION_MIN}-minute chunks…`);
        console.log(`[NvidiaClient] Splitting audio into ${NvidiaClient.CHUNK_DURATION_MIN}-min chunks with ${overlap}s overlap…`);

        const chunks = await this._splitAudioIntoChunks(tempMp3, chunkDuration, overlap, onProgress);
        tempChunks.push(...chunks);

        if (chunks.length === 0) {
          throw new Error('Failed to create audio chunks');
        }

        // Analyze each chunk
        const allSegments = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const isFirstChunk = i === 0;
          const chunkPrompt = isFirstChunk ? promptFirst : promptContinuation;
          
          onProgress?.(`Analyzing chunk ${i + 1}/${chunks.length} (offset: ${chunk.offset.toFixed(1)}s)…`);
          console.log(`[NvidiaClient] Analyzing chunk ${i + 1}/${chunks.length} at offset ${chunk.offset}s, using ${isFirstChunk ? 'first' : 'continuation'} prompt`);

          let chunkSegments;
          try {
            chunkSegments = await this._analyzeSingle(chunk.path, chunkPrompt, (msg) => {
              onProgress?.(`Chunk ${i + 1}/${chunks.length}: ${msg}`);
            });
          } catch (err) {
            console.error(`[NvidiaClient] Chunk ${i + 1} failed: ${err.message}`);
            throw new Error(`NVIDIA NIM analysis failed on chunk ${i + 1}/${chunks.length}. Error: ${err.message}. Please try again with a shorter video or use OpenRouter provider.`);
          }

          // Drop segments whose timestamps fall outside this chunk's real duration
          // (degenerate models hallucinate timestamps far past the audio length),
          // then adjust by the chunk's offset into the full recording.
          const chunkLen = chunk.duration || (NvidiaClient.CHUNK_DURATION_MIN * 60 + NvidiaClient.CHUNK_OVERLAP_SEC);
          const tolerance = 2; // small slack for rounding
          for (const seg of chunkSegments) {
            if (seg.start > chunkLen + tolerance || seg.end > chunkLen + tolerance) {
              console.log(`[NvidiaClient] Dropping out-of-range segment in chunk ${i + 1}: ${seg.start}-${seg.end}s (chunk is ${chunkLen.toFixed(1)}s)`);
              continue;
            }
            allSegments.push({
              ...seg,
              start: seg.start + chunk.offset,
              end: seg.end + chunk.offset,
            });
          }
        }

        // Deduplicate segments from overlapping regions
        segments = this._deduplicateSegments(allSegments);
        console.log(`[NvidiaClient] Merged ${allSegments.length} raw segments into ${segments.length} unique stories.`);
      }

      if (segments && segments.length > 0) {
        onProgress?.(`Success! Found ${segments.length} stories.`);
        return segments;
      }

      throw new Error('NVIDIA NIM returned no stories');

    } finally {
      // Cleanup temp files
      if (tempMp3 && tempMp3 !== audioFilePath) {
        try { fs.unlinkSync(tempMp3); } catch {}
      }
      for (const chunk of tempChunks) {
        try { fs.unlinkSync(chunk.path); } catch {}
      }
    }
  }
}

module.exports = { NvidiaClient };
