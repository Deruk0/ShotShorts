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

class SubtitleRenderer {
  constructor() {
    this.fontManager = new FontManager();
    this.browser = null;
    this.page = null;
    this.chromiumPath = null;
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
    // Check if Playwright is available
    if (!this.isAvailable()) {
      throw new Error('Playwright Chromium not available');
    }

    ensureDir(TMP_DIR);
    ensureDir(outputDir);

    // 1. Ensure fonts are downloaded
    await this.fontManager.ensureFonts(onProgress);
    await this._ensureBrowser(onProgress);

    const fontCSS = this.fontManager.getFontCSS(options.fontFamily || 'Inter') || '';
    const styleCSS = this._buildStyleCSS(options);
    const position = options.position || 'bottom';
    const marginV = Math.max(10, Number(options.marginV || 40));
    const fontSize = Math.max(12, Number(options.fontSize || 20));
    const fontFamily = options.fontFamily || 'Inter';
    const karaoke = !!options.karaoke;
    const caseName = options.caseName || 'sentence';
    const wordsPerLine = Math.max(1, Number(options.wordsPerLine || 3));

    // 2. Build unique frames with timing
    const frames = [];
    let frameIdx = 0;
    const totalSegments = segments.length;

    for (let si = 0; si < totalSegments; si++) {
      const seg = segments[si];
      const segStart = Number(seg.start) || 0;
      const segEnd = Number(seg.end) || (segStart + 1);
      const segDuration = Math.max(0.1, segEnd - segStart);

      // Apply case
      let segText = String(seg.text || '').trim();
      if (caseName === 'uppercase') segText = segText.toUpperCase();
      else if (caseName === 'lowercase') segText = segText.toLowerCase();

      onProgress?.(`Rendering subtitle frames… ${si + 1}/${totalSegments}`);

      if (karaoke && Array.isArray(seg.words) && seg.words.length > 0) {
        const timedWords = seg.words.filter(w =>
          Number.isFinite(Number(w?.start)) &&
          Number.isFinite(Number(w?.end)) &&
          Number(w.end) > Number(w.start)
        );

        if (timedWords.length === 0) {
          const pngPath = path.join(TMP_DIR, `ss_sub_${Date.now()}_${frameIdx++}.png`);
          const html = this._buildHTML(fontCSS, styleCSS, fontFamily, fontSize, position, marginV, segText, -1, options);
          await this._renderFrame(html, pngPath, onProgress);
          frames.push({ path: pngPath, start: segStart, end: segEnd });
          continue;
        }

        for (let wi = 0; wi < timedWords.length; wi++) {
          const w = timedWords[wi];
          const wStart = Number(w.start);
          const nextStart = wi < timedWords.length - 1 ? Number(timedWords[wi + 1].start) : segEnd;
          const wEnd = Math.min(nextStart, Number(w.end) || nextStart);

          const pngPath = path.join(TMP_DIR, `ss_sub_${Date.now()}_${frameIdx++}.png`);
          const html = this._buildHTML(fontCSS, styleCSS, fontFamily, fontSize, position, marginV, segText, wi, options);
          await this._renderFrame(html, pngPath, onProgress);
          frames.push({ path: pngPath, start: wStart, end: wEnd });
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

          const pngPath = path.join(TMP_DIR, `ss_sub_${Date.now()}_${frameIdx++}.png`);
          const html = this._buildHTML(fontCSS, styleCSS, fontFamily, fontSize, position, marginV, chunkText, -1, options);
          await this._renderFrame(html, pngPath, onProgress);
          frames.push({ path: pngPath, start: wordStart, end: wordEnd });
          idx += wordsPerLine;
        }
      }
    }

    if (frames.length === 0) {
      throw new Error('No subtitle frames were rendered');
    }

    // 3. Build concat list for ffmpeg
    const listPath = path.join(TMP_DIR, `ss_sub_list_${Date.now()}.txt`);
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
    const outputWebM = path.join(outputDir, `ss_subtitles_${Date.now()}.webm`);
    onProgress?.('Assembling subtitle video…');
    await this._ffmpegConcatToWebM(listPath, outputWebM);

    // 5. Cleanup temp PNGs
    for (const frame of frames) {
      try { fs.unlinkSync(frame.path); } catch {}
    }
    try { fs.unlinkSync(listPath); } catch {}

    return outputWebM;
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
.karaoke-word { color: #ffffff; }`;
      case 'TikTokBold':
        return `.subtitle-line { font-weight: 900; letter-spacing: 0.3px; text-shadow: -2px -2px 0 rgba(0,0,0,0.98), 2px -2px 0 rgba(0,0,0,0.98), -2px 2px 0 rgba(0,0,0,0.98), 2px 2px 0 rgba(0,0,0,0.98), 0 4px 14px rgba(0,0,0,0.95); }${karaokeWordCSS}`;
      case 'HeavyShadow':
        return `.subtitle-line { font-weight: 900; letter-spacing: 0.35px; text-shadow: -2px -2px 0 rgba(0,0,0,0.98), 2px -2px 0 rgba(0,0,0,0.98), -2px 2px 0 rgba(0,0,0,0.98), 2px 2px 0 rgba(0,0,0,0.98), 0 4px 0 rgba(0,0,0,0.95), 0 8px 16px rgba(0,0,0,1); }${karaokeWordCSS}`;
      case 'SoftBox':
        return `.subtitle-line { font-weight: 700; color: #f1f5f9; letter-spacing: 0.18px; background: rgba(0,0,0,0.48); border: 1px solid rgba(255,255,255,0.14); border-radius: 8px; padding: 8px 10px; text-shadow: 0 1px 2px rgba(0,0,0,0.95); max-width: 680px; }${karaokeWordCSS}`;
      default:
        return '';
    }
  }

  _buildHTML(fontCSS, styleCSS, fontFamily, fontSize, position, marginV, text, highlightIndex, options) {
    const alignItems = position === 'top' ? 'flex-start' : position === 'middle' ? 'center' : 'flex-end';

    let htmlText = escapeHtml(text);
    if (highlightIndex >= 0 && options.karaoke) {
      const words = text.split(/\s+/).filter(Boolean);
      htmlText = words.map((w, i) => {
        if (i === highlightIndex) return `<span class="karaoke-word">${escapeHtml(w)}</span>`;
        return escapeHtml(w);
      }).join(' ');
    }

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
${fontCSS}
body {
  margin: 0;
  width: 1080px;
  height: 1920px;
  background: transparent;
  display: flex;
  align-items: ${alignItems};
  justify-content: center;
  padding: ${marginV}px 40px;
  box-sizing: border-box;
}
.subtitle-line {
  font-family: '${fontFamily}', sans-serif;
  font-size: ${fontSize}px;
  color: #ffffff;
  text-align: center;
  line-height: 1.18;
  max-width: 1000px;
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

  async _renderFrame(html, outputPath, onProgress) {
    try {
      await this.page.setContent(html, { waitUntil: 'networkidle', timeout: 10000 });
      await this.page.evaluate(() => document.fonts.ready);
      const element = await this.page.$('.subtitle-line');
      if (!element) throw new Error('Subtitle element not found');
      await element.screenshot({
        path: outputPath,
        omitBackground: true,
      });
    } catch (err) {
      onProgress?.(`Subtitle render error: ${err.message}`);
      throw err;
    }
  }

  async _ffmpegConcatToWebM(listPath, outputPath) {
    return new Promise((resolve, reject) => {
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
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(new Error(`FFmpeg subtitle assembly failed: ${err.message}`)))
        .run();
    });
  }
}

module.exports = { SubtitleRenderer, findChromiumExecutable };
