/**
 * SubtitleRenderer — renders subtitle frames as HTML→PNG→WebM via Playwright.
 * Guarantees 100% visual match between app preview and final video.
 * Falls back to ASS if Playwright/Chromium is unavailable.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const { FontManager } = require('./font-manager');
const { createAbortError, runFfmpegCommand, throwIfAborted } = require('./cancellation');

const TMP_DIR = path.join(os.tmpdir(), 'shotshorts_subtitles');

// Try to locate Chromium for bundled app (relative to exe) or dev environment
function findChromiumExecutable() {
  // 1. Default Playwright location (dev)
  const defaultPath = chromium.executablePath();
  if (fs.existsSync(defaultPath)) return defaultPath;

  // 2. Bundled with app (relative to process.execPath)
  const bundledPaths = [
    path.join(path.dirname(process.execPath), 'resources', 'chromium', 'chrome-win64', 'chrome.exe'),
    path.join(path.dirname(process.execPath), 'resources', 'chromium', 'chrome.exe'),
    path.join(__dirname, '..', 'resources', 'chromium', 'chrome-win64', 'chrome.exe'),
    path.join(__dirname, '..', 'resources', 'chromium', 'chrome.exe'),
  ];
  for (const p of bundledPaths) {
    if (fs.existsSync(p)) return p;
  }

  // 3. System-wide Chrome / Chromium
  const systemPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Chromium\\Application\\chromium.exe',
  ];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function applyCaseToText(text, caseName = 'sentence') {
  const value = String(text || '');
  if (caseName === 'uppercase') return value.toUpperCase();
  if (caseName === 'lowercase') return value.toLowerCase();
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildFallbackTimedWords(seg) {
  const words = String(seg?.text || '')
    .replace(/\r?\n/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length) return [];

  const start = Math.max(0, Number(seg?.start) || 0);
  const rawEnd = Number(seg?.end);
  const end = Number.isFinite(rawEnd) ? Math.max(start + 0.2, rawEnd) : start + 0.2;
  const step = (end - start) / words.length;

  return words.map((word, index) => ({
    word,
    start: start + step * index,
    end: index === words.length - 1 ? end : start + step * (index + 1)
  }));
}

class SubtitleRenderer {
  constructor() {
    this.fontManager = new FontManager();
    this.browser = null;
    this.page = null;
    this.chromiumPath = null;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
    this.close().catch(() => {});
  }

  _throwIfCancelled(signal) {
    if (this.cancelled) throw createAbortError();
    throwIfAborted(signal);
  }

  isAvailable() {
    this.chromiumPath = findChromiumExecutable();
    return !!this.chromiumPath;
  }

  async _ensureBrowser(onProgress) {
    if (this.browser) return;

    if (!this.chromiumPath) {
      this.chromiumPath = findChromiumExecutable();
    }
    if (!this.chromiumPath) {
      throw new Error('Chromium not found. Install with: npx playwright install chromium');
    }

    onProgress?.(`Starting Chromium (${path.basename(this.chromiumPath)})…`);

    try {
      this.browser = await chromium.launch({
        executablePath: this.chromiumPath,
        headless: true,
        timeout: 30000,
      });
      this.page = await this.browser.newPage();
      await this.page.setViewportSize({ width: 1080, height: 1920 });
      onProgress?.('Chromium ready ✓');
    } catch (err) {
      throw new Error(`Failed to launch Chromium: ${err.message}`);
    }
  }

  async close() {
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
      this.page = null;
    }
  }

  /**
   * Render subtitle track as a WebM video with alpha channel.
   * Falls back to ASS rendering if Playwright unavailable.
   */
  async renderSubtitleTrack(segments, options, outputDir, onProgress) {
    this.cancelled = false;
    const signal = options.signal;
    this._throwIfCancelled(signal);

    // Check if Playwright is available
    if (!this.isAvailable()) {
      throw new Error('Playwright Chromium not available');
    }

    ensureDir(TMP_DIR);
    ensureDir(outputDir);

    // 1. Ensure fonts are downloaded
    await this.fontManager.ensureFonts(onProgress, signal);
    this._throwIfCancelled(signal);
    await this._ensureBrowser(onProgress);
    this._throwIfCancelled(signal);

    const fontCSS = this.fontManager.getFontCSS(options.fontFamily || 'Inter') || '';
    const styleCSS = this._buildStyleCSS(options);
    const position = options.position || 'bottom';
    const marginV = Math.max(10, Number(options.marginV || 40));
    const fontSize = Math.max(12, Number(options.fontSize || 20));
    const fontFamily = options.fontFamily || 'Inter';
    const karaoke = !!options.karaoke;
    const caseName = options.caseName || 'sentence';
    const wordsPerLine = Math.max(1, Number(options.wordsPerLine || 3));
    const maxLineMs = Math.max(300, Number(options.maxLineMs || 1200));
    const offsetSec = Number(options.offsetSec || 0);
    const trackDuration = Math.max(0, Number(options.duration || 0));

    // 2. Build subtitle frames with timing on the local clip timeline.
    const subtitleFrames = [];
    let frameIdx = 0;
    const totalSegments = segments.length;

    for (let si = 0; si < totalSegments; si++) {
      this._throwIfCancelled(signal);
      const seg = segments[si];
      const segStart = Number(seg.start) || 0;
      const segEnd = Number(seg.end) || (segStart + 1);
      const segDuration = Math.max(0.1, segEnd - segStart);

      const segText = String(seg.text || '').replace(/\r?\n/g, ' ').trim();

      onProgress?.(`Rendering subtitle frames… ${si + 1}/${totalSegments}`);

      let timedWords = Array.isArray(seg.words)
        ? seg.words.filter(w =>
          Number.isFinite(Number(w?.start)) &&
          Number.isFinite(Number(w?.end)) &&
          Number(w.end) > Number(w.start)
        )
        : [];

      if (karaoke && timedWords.length === 0) {
        timedWords = buildFallbackTimedWords(seg);
      }

      if (timedWords.length > 0) {
        let idx = 0;
        while (idx < timedWords.length) {
          const chunk = timedWords.slice(idx, idx + wordsPerLine);
          const chunkWords = chunk.map(w => String(w.word || '').trim()).filter(Boolean);
          if (!chunkWords.length) { idx += wordsPerLine; continue; }

          const chunkStart = Number(chunk[0].start || segStart);
          const rawChunkEnd = Number(chunk[chunk.length - 1].end || segEnd);
          const chunkEnd = Math.min(rawChunkEnd, chunkStart + maxLineMs / 1000);

          if (karaoke) {
            for (let wi = 0; wi < chunk.length; wi++) {
              const w = chunk[wi];
              const wStart = Number(w.start || chunkStart);
              const nextStart = wi < chunk.length - 1 ? Number(chunk[wi + 1].start || w.end || wStart) : Number(w.end || chunkEnd);
              const wEnd = Math.min(chunkEnd, nextStart);

              const pngPath = path.join(TMP_DIR, `ss_sub_${Date.now()}_${frameIdx++}.png`);
              const html = this._buildHTML(fontCSS, styleCSS, fontFamily, fontSize, position, marginV, chunkWords, wi, options);
              await this._renderFrame(html, pngPath, onProgress, signal);
              subtitleFrames.push({
                path: pngPath,
                start: Math.max(0, wStart - offsetSec),
                end: Math.max(0, wEnd - offsetSec)
              });
            }
          } else {
            const pngPath = path.join(TMP_DIR, `ss_sub_${Date.now()}_${frameIdx++}.png`);
            const html = this._buildHTML(fontCSS, styleCSS, fontFamily, fontSize, position, marginV, chunkWords, -1, options);
            await this._renderFrame(html, pngPath, onProgress, signal);
            subtitleFrames.push({
              path: pngPath,
              start: Math.max(0, chunkStart - offsetSec),
              end: Math.max(0, chunkEnd - offsetSec)
            });
          }

          idx += wordsPerLine;
        }
      } else {
        // Non-karaoke: split into chunks by wordsPerLine
        const allWords = segText.split(/\s+/).filter(Boolean);
        const totalWords = allWords.length || 1;
        let idx = 0;

        while (idx < totalWords) {
          const chunkWords = allWords.slice(idx, idx + wordsPerLine);
          const chunkText = chunkWords.join(' ');
          if (!chunkText) { idx += wordsPerLine; continue; }

          const wordStart = segStart + (idx / totalWords) * segDuration;
          const wordEnd = Math.min(segStart + ((idx + wordsPerLine) / totalWords) * segDuration, segEnd);
          const chunkEnd = Math.min(Math.max(wordStart + 0.2, wordStart + maxLineMs / 1000), wordEnd);

          const pngPath = path.join(TMP_DIR, `ss_sub_${Date.now()}_${frameIdx++}.png`);
          const html = this._buildHTML(fontCSS, styleCSS, fontFamily, fontSize, position, marginV, chunkText, -1, options);
          await this._renderFrame(html, pngPath, onProgress, signal);
          subtitleFrames.push({
            path: pngPath,
            start: Math.max(0, wordStart - offsetSec),
            end: Math.max(0, chunkEnd - offsetSec)
          });
          idx += wordsPerLine;
        }
      }
    }

    this._throwIfCancelled(signal);
    if (subtitleFrames.length === 0) {
      throw new Error('No subtitle frames were rendered');
    }

    const transparentPath = path.join(TMP_DIR, `ss_sub_transparent_${Date.now()}.png`);
    await this._renderFrame(this._buildTransparentHTML(), transparentPath, onProgress, signal);
    const frames = this._buildTimelineFrames(subtitleFrames, transparentPath, trackDuration);
    if (frames.length === 0) {
      throw new Error('No subtitle frames remained after timing was applied');
    }

    // 3. Build concat list for ffmpeg
    const listPath = path.join(TMP_DIR, `ss_sub_list_${Date.now()}.txt`);
    const outputWebM = path.join(outputDir, `ss_subtitles_${Date.now()}.webm`);

    try {
      const listLines = [];
      for (const frame of frames) {
        const duration = Math.max(0.04, frame.end - frame.start);
        listLines.push(`file '${frame.path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
        listLines.push(`duration ${duration.toFixed(3)}`);
      }
      const lastFrame = frames[frames.length - 1];
      listLines.push(`file '${lastFrame.path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
      listLines.push('duration 0.04');
      fs.writeFileSync(listPath, listLines.join('\n'), 'utf8');

      // 4. Assemble frames into WebM with alpha
      onProgress?.('Assembling subtitle video…');
      await this._ffmpegConcatToWebM(listPath, outputWebM, signal);
      return outputWebM;
    } finally {
      // 5. Cleanup temp PNGs
      for (const framePath of new Set(frames.map((frame) => frame.path))) {
        try { fs.unlinkSync(framePath); } catch {}
      }
      try { fs.unlinkSync(listPath); } catch {}
    }
  }

  _buildTimelineFrames(subtitleFrames, transparentPath, duration) {
    const sorted = subtitleFrames
      .map((frame) => ({
        ...frame,
        start: Math.max(0, Number(frame.start) || 0),
        end: Math.max(0, Number(frame.end) || 0)
      }))
      .filter((frame) => frame.end > frame.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);

    const totalDuration = duration > 0
      ? duration
      : Math.max(...sorted.map((frame) => frame.end), 0.04);
    const timeline = [];
    let cursor = 0;

    for (const frame of sorted) {
      const start = Math.min(Math.max(frame.start, cursor), totalDuration);
      const end = Math.min(Math.max(frame.end, start), totalDuration);
      if (start > cursor + 0.001) {
        timeline.push({ path: transparentPath, start: cursor, end: start });
      }
      if (end > start + 0.001) {
        timeline.push({ path: frame.path, start, end });
        cursor = end;
      }
      if (cursor >= totalDuration) break;
    }

    if (totalDuration > cursor + 0.001) {
      timeline.push({ path: transparentPath, start: cursor, end: totalDuration });
    }

    return timeline;
  }

  _buildStyleCSS(options) {
    const preset = options.stylePreset || 'Classic';
    const karaokeEffects = new Set(Array.isArray(options.karaokeEffects) ? options.karaokeEffects : []);
    const hasBox = karaokeEffects.has('box');
    const hasHighlight = karaokeEffects.has('highlight');
    const hasCaps = karaokeEffects.has('caps');

    let karaokeWordCSS = '';
    if (hasBox) {
      karaokeWordCSS += `
.karaoke-word {
  background: rgba(255, 59, 48, 0.46);
  border: 1px solid rgba(255, 99, 90, 0.7);
  border-radius: 7px;
  padding: 1px 6px 2px;
  display: inline-block;
}`;
    }
    if (hasHighlight) {
      if (!hasBox) {
        karaokeWordCSS += `
.karaoke-word { color: #ffd400; }`;
      } else {
        karaokeWordCSS += `
.karaoke-word { color: #ffffff; }`;
      }
    }
    if (hasCaps) {
      karaokeWordCSS += `
.karaoke-word { text-transform: uppercase; }`;
    }

    switch (preset) {
      case 'Classic':
        return `.subtitle-line { font-weight: 700; letter-spacing: 0.2px; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, -2px 0 0 rgba(0,0,0,0.9), 2px 0 0 rgba(0,0,0,0.9), 0 -2px 0 rgba(0,0,0,0.9), 0 2px 0 rgba(0,0,0,0.9), 0 2px 10px rgba(0,0,0,0.9); }${karaokeWordCSS}`;
      case 'Minimal':
        return `.subtitle-line { font-weight: 500; color: #e5e7eb; letter-spacing: 0.1px; text-shadow: 0 1px 3px rgba(0,0,0,0.9); }${karaokeWordCSS}`;
      case 'Highlight':
        return `.subtitle-line { font-weight: 800; color: #ffe066; letter-spacing: 0.35px; text-shadow: -1px -1px 0 rgba(0,0,0,0.95), 1px -1px 0 rgba(0,0,0,0.95), -1px 1px 0 rgba(0,0,0,0.95), 1px 1px 0 rgba(0,0,0,0.95), 0 0 10px rgba(255,208,0,0.25); }
${karaokeWordCSS}
.subtitle-line .karaoke-word { color: #ffffff; }
.subtitle-line .karaoke-word.mode-highlight { color: #ffe066; }`;
      case 'TikTokBold':
        return `.subtitle-line { font-weight: 900; letter-spacing: 0.3px; text-shadow: -2px -2px 0 rgba(0,0,0,0.98), 2px -2px 0 rgba(0,0,0,0.98), -2px 2px 0 rgba(0,0,0,0.98), 2px 2px 0 rgba(0,0,0,0.98), 0 4px 14px rgba(0,0,0,0.95); }${karaokeWordCSS}`;
      case 'HeavyShadow':
        return `.subtitle-line { font-weight: 900; letter-spacing: 0.35px; text-shadow: -2px -2px 0 rgba(0,0,0,0.98), 2px -2px 0 rgba(0,0,0,0.98), -2px 2px 0 rgba(0,0,0,0.98), 2px 2px 0 rgba(0,0,0,0.98), 0 4px 0 rgba(0,0,0,0.95), 0 8px 16px rgba(0,0,0,1); }${karaokeWordCSS}`;
      case 'SoftBox':
        return `.subtitle-line { font-weight: 700; color: #f2f2f2; letter-spacing: 0.18px; background: rgba(0,0,0,0.52); border: 1px solid rgba(255,255,255,0.14); border-radius: 8px; padding: 8px 10px; text-shadow: 0 1px 2px rgba(0,0,0,0.95); }${karaokeWordCSS}`;
      default:
        return '';
    }
  }

  _buildHTML(fontCSS, styleCSS, fontFamily, fontSize, position, marginV, text, highlightIndex, options) {
    const words = Array.isArray(text)
      ? text.map((word) => String(word || '').trim()).filter(Boolean)
      : String(text || '').split(/\s+/).filter(Boolean);
    const caseName = options.caseName || 'sentence';
    const casedText = applyCaseToText(words.join(' '), caseName);
    const casedWords = casedText.split(/\s+/).filter(Boolean);
    let htmlText = escapeHtml(casedText);
    if (highlightIndex >= 0 && options.karaoke) {
      const karaokeEffects = new Set(Array.isArray(options.karaokeEffects) ? options.karaokeEffects : []);
      htmlText = casedWords.map((w, i) => {
        if (i === highlightIndex) {
          const classes = ['karaoke-word'];
          if (karaokeEffects.has('highlight')) classes.push('mode-highlight');
          if (karaokeEffects.has('box')) classes.push('mode-box');
          const value = karaokeEffects.has('caps') && caseName !== 'uppercase' ? w.toUpperCase() : w;
          return `<span class="${classes.join(' ')}">${escapeHtml(value)}</span>`;
        }
        return escapeHtml(w);
      }).join(' ');
    }

    const placement = position === 'top'
      ? `top: ${marginV}px; bottom: auto;`
      : position === 'middle'
        ? 'top: 50%; bottom: auto; transform: translateY(-50%);'
        : `bottom: ${marginV}px; top: auto;`;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
${fontCSS}
html,
body {
  margin: 0;
  width: 1080px;
  height: 1920px;
  background: transparent;
  overflow: hidden;
}
.subtitle-line {
  position: absolute;
  left: 40px;
  right: 40px;
  ${placement}
  font-family: '${fontFamily}', sans-serif;
  font-size: ${fontSize}px;
  color: #ffffff;
  text-align: center;
  line-height: 1.18;
  box-sizing: border-box;
  word-break: break-word;
  white-space: normal;
}
${styleCSS}
</style>
</head>
<body>
  <div class="subtitle-line">${htmlText}</div>
</body>
</html>`;
  }

  _buildTransparentHTML() {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
html, body {
  margin: 0;
  width: 1080px;
  height: 1920px;
  background: transparent;
  overflow: hidden;
}
</style>
</head>
<body></body>
</html>`;
  }

  async _renderFrame(html, outputPath, onProgress, signal) {
    try {
      this._throwIfCancelled(signal);
      await this.page.setContent(html, { waitUntil: 'networkidle', timeout: 10000 });
      this._throwIfCancelled(signal);
      await this.page.evaluate(() => document.fonts.ready);
      this._throwIfCancelled(signal);
      await this.page.screenshot({
        path: outputPath,
        omitBackground: true,
        fullPage: false,
      });
      this._throwIfCancelled(signal);
    } catch (err) {
      onProgress?.(`Subtitle render error: ${err.message}`);
      throw err;
    }
  }

  async _ffmpegConcatToWebM(listPath, outputPath, signal) {
    return runFfmpegCommand(
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-c:v', 'libvpx-vp9',
          '-pix_fmt', 'yuva420p',
          '-auto-alt-ref', '0',
          '-crf', '32',
          '-b:v', '0',
          '-deadline', 'good',
          '-cpu-used', '5',
          '-row-mt', '1'
        ])
        .output(outputPath),
      {
        signal,
        formatError: (err) => new Error(`FFmpeg subtitle assembly failed: ${err.message}`)
      }
    );
  }
}

module.exports = { SubtitleRenderer, findChromiumExecutable };
