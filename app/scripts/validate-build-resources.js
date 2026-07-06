const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const resourcesDir = path.join(appDir, 'resources');
const warnOnly = process.argv.includes('--warn-only') || process.env.SHOTSHORTS_ALLOW_UNBUNDLED_FFMPEG === '1';

const required = [
  path.join(resourcesDir, 'ffmpeg.exe'),
  path.join(resourcesDir, 'ffprobe.exe')
];

const chromiumCandidates = [
  path.join(resourcesDir, 'chromium', 'chrome-win64', 'chrome.exe'),
  path.join(resourcesDir, 'chromium', 'chrome.exe')
];

function findOnPath(fileName) {
  try {
    const output = execFileSync('where.exe', [fileName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && fs.existsSync(line)) || null;
  } catch {
    return null;
  }
}

function relative(filePath) {
  return path.relative(appDir, filePath).replace(/\\/g, '/');
}

for (const targetPath of required) {
  if (fs.existsSync(targetPath)) continue;

  const fileName = path.basename(targetPath);
  const sourcePath = findOnPath(fileName);
  if (!sourcePath) continue;

  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  console.log(`[ShotShorts] Copied ${fileName} from PATH into app/${relative(targetPath)}.`);
}

const missingRequired = required.filter((filePath) => !fs.existsSync(filePath));
const hasChromium = chromiumCandidates.some((filePath) => fs.existsSync(filePath));

if (missingRequired.length > 0) {
  const lines = [
    '[ShotShorts] Build resource check failed.',
    'Portable Windows builds must bundle FFmpeg next to the app executable.',
    '',
    'Missing:',
    ...missingRequired.map((filePath) => `- app/${relative(filePath)}`),
    '',
    'Fix:',
    '- Put ffmpeg.exe and ffprobe.exe into app/resources/',
    '- Or set SHOTSHORTS_ALLOW_UNBUNDLED_FFMPEG=1 if this build intentionally relies on a system FFmpeg.'
  ];

  const message = lines.join('\n');
  if (warnOnly) {
    console.warn(message);
  } else {
    console.error(message);
    process.exit(1);
  }
}

if (!hasChromium) {
  console.warn([
    '[ShotShorts] Chromium was not found in app/resources/chromium/.',
    'Pixel-matched subtitle overlay will depend on Playwright/system Chrome and may fall back to ASS in the packaged app.'
  ].join('\n'));
}

if (missingRequired.length === 0) {
  console.log('[ShotShorts] Build resources OK.');
}
