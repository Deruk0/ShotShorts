/**
 * FontManager — downloads and caches Google Fonts locally for offline subtitle rendering.
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

const DATA_DIR = app
  ? path.join(app.getPath('userData'), 'fonts')
  : path.join(os.homedir(), '.shotshorts', 'fonts');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

class FontManager {
  constructor() {
    ensureDir(DATA_DIR);
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
