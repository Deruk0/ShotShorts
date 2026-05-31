/**
 * FontManager — downloads and caches Google Fonts locally for offline subtitle rendering.
 *
 * Two cache layers:
 *  - .css + .woff2 — used by Playwright/Chromium-based subtitle renderer.
 *  - .ttf          — used by libass/ffmpeg via the `fontsdir=` option so the
 *                    burnt-in subtitles use the exact same font as the preview.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const FONT_FAMILIES = {
  'Inter': { weights: [400, 700], urlName: 'Inter' },
  'JetBrains Mono': { weights: [400, 700], urlName: 'JetBrains+Mono' },
  'Montserrat': { weights: [500, 700], urlName: 'Montserrat' },
  'Oswald': { weights: [500, 700], urlName: 'Oswald' }
};

const FONT_CSS_URL = (family, weights) =>
  `https://fonts.googleapis.com/css2?family=${family}:wght@${weights.join(';')}&display=swap`;

// Old User-Agent that makes Google Fonts return TTF instead of woff2.
const TTF_UA = 'Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1; Trident/4.0)';

const DATA_DIR = app
  ? path.join(app.getPath('userData'), 'fonts')
  : path.join(os.homedir(), '.shotshorts', 'fonts');
const TTF_DIR = path.join(DATA_DIR, 'ttf');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function downloadFile(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return downloadFile(res.headers.location, dest, headers).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

class FontManager {
  constructor() {
    ensureDir(DATA_DIR);
    ensureDir(TTF_DIR);
  }

  async ensureFonts(onProgress) {
    for (const [name, cfg] of Object.entries(FONT_FAMILIES)) {
      const cssPath = path.join(DATA_DIR, `${name.replace(/\s+/g, '_')}.css`);
      if (fs.existsSync(cssPath)) continue;

      onProgress?.(`Downloading font: ${name}…`);
      const cssUrl = FONT_CSS_URL(cfg.urlName, cfg.weights);
      const cssText = await httpGet(cssUrl);

      // Parse @font-face blocks and download woff2 files
      const fontFaceRegex = /@font-face\s*{([^}]+)}/g;
      let match;
      let localCss = '';
      let idx = 0;

      while ((match = fontFaceRegex.exec(cssText)) !== null) {
        const block = match[1];
        const urlMatch = block.match(/url\(([^)]+)\)/);
        if (!urlMatch) continue;

        const remoteUrl = urlMatch[1].replace(/['"]/g, '');
        const ext = path.extname(new URL(remoteUrl).pathname) || '.woff2';
        const localName = `${name.replace(/\s+/g, '_')}_${idx}${ext}`;
        const localPath = path.join(DATA_DIR, localName);

        if (!fs.existsSync(localPath)) {
          await downloadFile(remoteUrl, localPath);
        }

        // Replace URL in block with local file path (file:// protocol)
        const localBlock = block.replace(
          /url\([^)]+\)/,
          `url("file:///${localPath.replace(/\\/g, '/')}")`
        );
        localCss += `@font-face {${localBlock}}\n`;
        idx++;
      }

      fs.writeFileSync(cssPath, localCss, 'utf8');
      onProgress?.(`Font ${name} cached ✓`);
    }
  }

  /**
   * Ensure TTF files exist locally for libass. Best-effort:
   *  - on success, libass will pick correct font for ASS Fontname.
   *  - on failure (no network etc.), returns false; caller should fallback to a
   *    system font in the ASS style.
   */
  async ensureTtfFonts(onProgress) {
    try {
      for (const [name, cfg] of Object.entries(FONT_FAMILIES)) {
        const safeName = name.replace(/\s+/g, '_');
        const marker = path.join(TTF_DIR, `.${safeName}.ok`);
        if (fs.existsSync(marker)) continue;
        onProgress?.(`Downloading TTF font: ${name}…`);
        const cssUrl = FONT_CSS_URL(cfg.urlName, cfg.weights);
        const cssText = await httpGet(cssUrl, { 'User-Agent': TTF_UA });

        const fontFaceRegex = /@font-face\s*{([^}]+)}/g;
        let m, idx = 0, downloaded = 0;
        while ((m = fontFaceRegex.exec(cssText)) !== null) {
          const block = m[1];
          const urlMatch = block.match(/url\(([^)]+)\)/);
          if (!urlMatch) continue;
          const remoteUrl = urlMatch[1].replace(/['"]/g, '');
          const ext = path.extname(new URL(remoteUrl).pathname) || '.ttf';
          if (ext.toLowerCase() !== '.ttf') { idx++; continue; }
          const localName = `${safeName}_${idx}.ttf`;
          const localPath = path.join(TTF_DIR, localName);
          if (!fs.existsSync(localPath)) {
            try {
              await downloadFile(remoteUrl, localPath, { 'User-Agent': TTF_UA });
              downloaded++;
            } catch (e) {
              onProgress?.(`Font ${name} download failed: ${e.message}`);
            }
          } else {
            downloaded++;
          }
          idx++;
        }
        if (downloaded > 0) {
          try { fs.writeFileSync(marker, '', 'utf8'); } catch {}
        }
      }
      return true;
    } catch (err) {
      onProgress?.(`TTF fonts not available: ${err.message}`);
      return false;
    }
  }

  /** Directory containing TTF files for libass `fontsdir=`. */
  getTtfDir() {
    return TTF_DIR;
  }

  hasAnyTtf() {
    try {
      return fs.readdirSync(TTF_DIR).some((f) => /\.ttf$/i.test(f));
    } catch { return false; }
  }

  getFontCSS(fontFamily) {
    const cssPath = path.join(DATA_DIR, `${fontFamily.replace(/\s+/g, '_')}.css`);
    if (fs.existsSync(cssPath)) {
      return fs.readFileSync(cssPath, 'utf8');
    }
    return null;
  }

  isReady() {
    for (const name of Object.keys(FONT_FAMILIES)) {
      const cssPath = path.join(DATA_DIR, `${name.replace(/\s+/g, '_')}.css`);
      if (!fs.existsSync(cssPath)) return false;
    }
    return true;
  }
}

module.exports = { FontManager, FONT_FAMILIES };
