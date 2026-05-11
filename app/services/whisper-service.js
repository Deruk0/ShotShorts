/**
 * WhisperService — local transcription via official OpenAI Whisper (PyTorch).
 *
 * Strategy:
 *  • Uses the `openai-whisper` pip package with PyTorch + CUDA 12.x (RTX 4060).
 *  • Checks/installs everything into a user-local venv on first run.
 *  • Default model: medium — good accuracy for Russian, ~1.5 GB VRAM.
 *  • Model files are downloaded on-demand and cached in app-data.
 *  • Outputs per-segment timed text, converts to ASS subtitle format.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const DATA_DIR = app
  ? path.join(app.getPath('userData'), 'whisper')
  : path.join(os.homedir(), '.shortsgen', 'whisper');

const VENV_DIR = path.join(DATA_DIR, 'venv');
const MODEL_DIR = path.join(DATA_DIR, 'models');

// Python executable inside venv
const PYTHON_EXE = process.platform === 'win32'
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');

// Inline Python script used for transcription
const PY_SCRIPT = path.join(DATA_DIR, 'transcribe.py');

const PYTHON_BOOTSTRAP = process.platform === 'win32'
  ? [
      ['py', ['-3', '-m', 'venv', VENV_DIR]],
      ['python', ['-m', 'venv', VENV_DIR]],
      ['python3', ['-m', 'venv', VENV_DIR]]
    ]
  : [
      ['python3', ['-m', 'venv', VENV_DIR]],
      ['python', ['-m', 'venv', VENV_DIR]]
    ];

const TORCH_INDEX_URLS = [
  'https://download.pytorch.org/whl/cu128',
  'https://download.pytorch.org/whl/cu126',
  'https://download.pytorch.org/whl/cu121'
];

// ---------------------------------------------------------------------------
// ASS style presets
// ---------------------------------------------------------------------------
const ASS_STYLES = {
  Classic: {
    fontName: 'Arial',
    fontSize: 20,
    primaryColour: '&H00FFFFFF',
    outlineColour: '&H00000000',
    backColour: '&H80000000',
    bold: 1,
    outline: 2,
    shadow: 1,
    alignment: 2,
    marginV: 40,
    BorderStyle: 1
  },
  Minimal: {
    fontName: 'Arial',
    fontSize: 18,
    primaryColour: '&H00FFFFFF',
    outlineColour: '&H00000000',
    backColour: '&H00000000',
    bold: 0,
    outline: 1.5,
    shadow: 0,
    alignment: 2,
    marginV: 30,
    BorderStyle: 1
  },
  Highlight: {
    fontName: 'Arial Black',
    fontSize: 22,
    primaryColour: '&H0000FFFF',   // yellow
    outlineColour: '&H00000000',
    backColour: '&H80000000',
    bold: 1,
    outline: 2.5,
    shadow: 2,
    alignment: 2,
    marginV: 40,
    BorderStyle: 1
  },
  TikTokBold: {
    fontName: 'Arial Black',
    fontSize: 24,
    primaryColour: '&H00FFFFFF',
    outlineColour: '&H00000000',
    backColour: '&H00000000',
    bold: 1,
    outline: 3.2,
    shadow: 2.4,
    alignment: 2,
    marginV: 44,
    BorderStyle: 1
  },
  HeavyShadow: {
    fontName: 'Arial Black',
    fontSize: 24,
    primaryColour: '&H00FFFFFF',
    outlineColour: '&H00000000',
    backColour: '&H00000000',
    bold: 1,
    outline: 3.2,
    shadow: 4.8,
    alignment: 2,
    marginV: 44,
    BorderStyle: 1
  },
  SoftBox: {
    fontName: 'Arial',
    fontSize: 20,
    primaryColour: '&H00F2F2F2',
    outlineColour: '&H24FFFFFF',
    backColour: '&H7A000000',
    bold: 1,
    outline: 1.4,
    shadow: 0.8,
    alignment: 2,
    marginV: 40,
    BorderStyle: 3
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function seconds2ass(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s.toFixed(2)).padStart(5, '0')}`;
}

function seconds2srt(t) {
  const safe = Math.max(0, Number(t) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function escapeAssText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function buildFallbackTimedWords(seg) {
  const textWords = String(seg?.text || '')
    .replace(/\r?\n/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!textWords.length) return [];

  const segStart = Math.max(0, Number(seg?.start) || 0);
  const segEndRaw = Number(seg?.end);
  const segEnd = Number.isFinite(segEndRaw) ? Math.max(segStart + 0.2, segEndRaw) : (segStart + 0.2);
  const total = Math.max(0.2, segEnd - segStart);
  const step = total / textWords.length;

  return textWords.map((word, i) => {
    const start = segStart + step * i;
    const end = i === textWords.length - 1 ? segEnd : (segStart + step * (i + 1));
    return { word, start, end };
  });
}

function applyCaseToText(text, caseName = 'sentence') {
  const value = String(text || '');
  if (caseName === 'uppercase') return value.toUpperCase();
  if (caseName === 'lowercase') return value.toLowerCase();
  if (!value) return value;
  // True sentence case: only capitalize the first character, preserve the rest
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildAssKaraokeLine(words, activeIndex, karaokeEffects, styleName, caseName, baseColour) {
  // ASS color format is BGR with trailing '&': &HAABBGGRR&
  const highlightColour = '&H0000D4FF&';
  const safeBaseColour = String(baseColour || '&H00FFFFFF&');

  const normalized = words.map((w) => applyCaseToText(String(w || '').trim(), caseName)).filter(Boolean);
  return normalized.map((word, i) => {
    let rendered = word;
    if (i === activeIndex) {
      if (karaokeEffects.has('caps') && caseName !== 'uppercase') {
        rendered = rendered.toUpperCase();
      }
      const tags = [karaokeEffects.has('box') ? '\\rKaraokeBox' : '\\rDefault'];
      if (karaokeEffects.has('highlight')) {
        tags.push(`\\1c${highlightColour}`);
      } else {
        // In "box only" mode, force original text color explicitly.
        tags.push(`\\1c${safeBaseColour}`);
      }
      if (!tags.length) tags.push(`\\c${highlightColour}`);
      return `{${tags.join('')}}${escapeAssText(rendered)}{\\rDefault}`;
    }
    return escapeAssText(rendered);
  }).join(' ');
}

// ---------------------------------------------------------------------------
// Inline Python transcription script
// ---------------------------------------------------------------------------
const TRANSCRIBE_PY = `
import sys, json, os, warnings
warnings.filterwarnings("ignore")
os.environ.setdefault('KMP_DUPLICATE_LIB_OK', 'TRUE')

ffmpeg_bin = os.environ.get("WHISPER_FFMPEG", "")
if ffmpeg_bin and os.path.exists(ffmpeg_bin):
    ffmpeg_dir = os.path.dirname(ffmpeg_bin)
    os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")

audio_path = sys.argv[1]
model_size = sys.argv[2]   # tiny | base | small | medium | large
language   = sys.argv[3]   # ru | en | ...
model_dir  = sys.argv[4]

import whisper
import torch

device = "cuda" if torch.cuda.is_available() else "cpu"
model = whisper.load_model(model_size, download_root=model_dir, device=device)

result = model.transcribe(
    audio_path,
    language=language,
    word_timestamps=True,
    verbose=False,
    fp16=torch.cuda.is_available()
)

out = []
for seg in result["segments"]:
    words = []
    if "words" in seg:
        for w in seg["words"]:
            words.append({"word": w["word"], "start": w["start"], "end": w["end"]})
    out.append({
        "start": seg["start"],
        "end":   seg["end"],
        "text":  seg["text"].strip(),
        "words": words
    })

print(json.dumps(out, ensure_ascii=False))
`.trim();

// ---------------------------------------------------------------------------
// WhisperService
// ---------------------------------------------------------------------------
class WhisperService {
  constructor() {
    this._ready = false;
    this.ffmpegPath = this._detectFfmpegPath();
    // Migrate legacy Whisper data dir (if present) to Electron app's data dir
    const legacyDir = path.join(os.homedir(), '.shortsgen', 'whisper');
    try {
      if (!fs.existsSync(DATA_DIR) && fs.existsSync(legacyDir)) {
        // Move legacy dir to new location
        fs.renameSync(legacyDir, DATA_DIR);
      }
    } catch (e) {
      // Non-fatal migration issues; will be logged later if needed
    }
    ensureDir(DATA_DIR);
    ensureDir(MODEL_DIR);
    this._writePyScript();
  }

  _writePyScript() {
    fs.writeFileSync(PY_SCRIPT, TRANSCRIBE_PY, 'utf8');
  }

  // Check whether the venv + openai-whisper are installed
  async isInstalled() {
    if (!fs.existsSync(PYTHON_EXE)) return false;
    try {
      await this._run(PYTHON_EXE, ['-c', 'import whisper, torch; print("ok")']);
      return true;
    } catch {
      return false;
    }
  }

  // Promisified child process runner for install steps
  _run(cmd, args, onProgress) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      proc.stdout.on('data', d => onProgress?.(d.toString().trim()));
      proc.stderr.on('data', d => onProgress?.(d.toString().trim()));
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)));
      proc.on('error', err => reject(new Error(`Cannot start ${cmd}: ${err.message}`)));
    });
  }

  _detectFfmpegPath() {
    const candidates = [
      path.join(__dirname, '..', 'resources', 'ffmpeg.exe'),
      path.join(path.dirname(process.execPath), 'resources', 'resources', 'ffmpeg.exe'),
      path.join(process.env.PROGRAMFILES  || 'C:\\Program Files',  'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'ffmpeg',  'bin', 'ffmpeg.exe'),
      path.join(process.env.LOCALAPPDATA  || '', 'ffmpeg',          'bin', 'ffmpeg.exe'),
      path.join(os.homedir(), 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(os.homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe'
    ];

    for (const c of candidates) {
      try {
        if (c && fs.existsSync(c)) return c;
      } catch {}
    }
    return null;
  }

  async _createVenv(onProgress) {
    let lastError = null;

    for (const [cmd, args] of PYTHON_BOOTSTRAP) {
      try {
        onProgress?.(`Trying Python launcher: ${cmd}`);
        await this._run(cmd, args, onProgress);
        return;
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(
      'Python 3.9+ was not found. Install Python and ensure `py`, `python`, or `python3` is available in PATH.' +
      (lastError ? ` Last error: ${lastError.message}` : '')
    );
  }

  async _installTorch(onProgress) {
    let lastError = null;

    for (const indexUrl of TORCH_INDEX_URLS) {
      try {
        onProgress?.(`Installing PyTorch from ${indexUrl}…`);
        await this._run(PYTHON_EXE, [
          '-m', 'pip', 'install', '--upgrade',
          'torch',
          '--index-url', indexUrl
        ], onProgress);
        return;
      } catch (err) {
        lastError = err;
      }
    }

    onProgress?.('CUDA PyTorch install failed, trying CPU fallback…');
    try {
      await this._run(PYTHON_EXE, [
        '-m', 'pip', 'install', '--upgrade', 'torch'
      ], onProgress);
      return;
    } catch (cpuErr) {
      throw new Error(
        'Failed to install PyTorch (CUDA and CPU fallback).' +
        (lastError ? ` CUDA error: ${lastError.message}.` : '') +
        ` CPU error: ${cpuErr.message}`
      );
    }
  }

  /**
   * Install openai-whisper + PyTorch (CUDA 12.1) into a local venv.
   * @param {function} onProgress  (message: string) => void
   */
  async install(onProgress) {
    ensureDir(VENV_DIR);
    if (!fs.existsSync(PYTHON_EXE)) {
      onProgress?.('Creating Python virtual environment…');
      await this._createVenv(onProgress);
    } else {
      onProgress?.('Using existing Whisper virtual environment…');
    }

    onProgress?.('Upgrading pip/setuptools…');
    await this._run(PYTHON_EXE, [
      '-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'
    ], onProgress);

    onProgress?.('Installing PyTorch with CUDA support (this may take several minutes)…');
    await this._installTorch(onProgress);

    onProgress?.('Installing openai-whisper…');
    await this._run(PYTHON_EXE, [
      '-m', 'pip', 'install', '--upgrade',
      'openai-whisper'
    ], onProgress);

    // Validate runtime imports after install
    await this._run(PYTHON_EXE, ['-c', 'import whisper, torch; print(torch.__version__)'], onProgress);

    onProgress?.('openai-whisper installed successfully ✓');
    this._writePyScript();
  }

  /**
   * Transcribe an audio file.
   * @param {string}   audioPath   Path to WAV / MP3
   * @param {object}   opts        { model: 'medium'|'small'|'large', language: 'ru' }
   * @param {function} onProgress
   * @returns {Promise<Array>}     Array of { start, end, text, words[] }
   */
  async transcribe(audioPath, opts = {}, onProgress) {
    const model    = opts.model    || 'medium';
    const language = opts.language || 'ru';

    if (!(await this.isInstalled())) {
      onProgress?.('Installing Whisper engine…');
      await this.install(onProgress);
    }

    if (!this.ffmpegPath) {
      onProgress?.('FFmpeg not found in known locations, Whisper will use system PATH…');
    }

    onProgress?.(`Transcribing audio [${model}]…`);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn(PYTHON_EXE, [
        PY_SCRIPT,
        audioPath,
        model,
        language,
        MODEL_DIR
      ], {
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          KMP_DUPLICATE_LIB_OK: 'TRUE',
          WHISPER_FFMPEG: this.ffmpegPath || '',
          PATH: this.ffmpegPath
            ? `${path.dirname(this.ffmpegPath)}${path.delimiter}${process.env.PATH || ''}`
            : (process.env.PATH || '')
        },
        windowsHide: true
      });

      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => {
        const line = d.toString();
        stderr += line;
        // Forward useful progress lines
        if (line.includes('%') || line.toLowerCase().includes('loading')) {
          onProgress?.(line.trim());
        }
      });

      proc.on('close', code => {
        if (code !== 0) {
          if (/ffmpeg/i.test(stderr) && /(not found|No such file|cannot find)/i.test(stderr)) {
            return reject(new Error(
              'Whisper cannot find ffmpeg. Install FFmpeg and add it to PATH, or place ffmpeg.exe in app/resources/.'
            ));
          }
          return reject(new Error(`Whisper exited with code ${code}\n${stderr.slice(-1500)}`));
        }
        try {
          const trimmed = stdout.trim();
          let data = null;
          try {
            data = JSON.parse(trimmed);
          } catch {
            const m = trimmed.match(/(\[[\s\S]*\])\s*$/);
            if (m) data = JSON.parse(m[1]);
          }
          if (!Array.isArray(data)) {
            throw new Error('Whisper output is not a JSON array');
          }
          resolve(data);
        } catch (e) {
          reject(new Error(`Failed to parse Whisper output: ${e.message}\nRaw: ${stdout.slice(0, 300)}`));
        }
      });

      proc.on('error', err => reject(new Error(`Failed to start Whisper: ${err.message}`)));
    });
  }

  /**
   * Convert transcription segments to an ASS subtitle string.
   * @param {Array}  segments   Result of transcribe()
   * @param {string} styleName  'Classic' | 'Minimal' | 'Highlight'
   * @param {number} offsetSec  Time offset to subtract (segment start)
   * @returns {string}          ASS file content
   */
  toASS(segments, styleName = 'Classic', offsetSec = 0, subtitleOptions = {}, caseName = 'sentence') {
    if (typeof subtitleOptions === 'string') {
      caseName = subtitleOptions;
      subtitleOptions = {};
    }
    // Allow stylePreset inside subtitleOptions to override the positional styleName argument
    const resolvedStyleName = subtitleOptions.stylePreset || styleName;
    const style = ASS_STYLES[resolvedStyleName] || ASS_STYLES.Classic;
    const wordsPerLine = Math.max(1, Number(subtitleOptions.wordsPerLine || 3));
    const maxLineMs = Math.max(300, Number(subtitleOptions.maxLineMs || 1200));
    const position = subtitleOptions.position || 'bottom';
    const alignment = position === 'top' ? 8 : (position === 'middle' ? 5 : 2);
    // User-specified fontSize always wins; fall back to preset default
    const fontSize = Math.max(12, Number(subtitleOptions.fontSize || style.fontSize || 20));
    const marginV = Math.max(10, Number(subtitleOptions.marginV || style.marginV || 40));
    const karaoke = !!subtitleOptions.karaoke;
    // User-specified fontFamily always wins over the preset font
    const fontName = String(subtitleOptions.fontFamily || style.fontName || 'Arial').replace(/,/g, ' ').trim() || 'Arial';
    const karaokeMode = String(subtitleOptions.karaokeMode || 'highlight');
    // caseName from subtitleOptions takes precedence over positional argument
    const resolvedCase = subtitleOptions.caseName || caseName;
    const effectsFromOptions = Array.isArray(subtitleOptions.karaokeEffects)
      ? subtitleOptions.karaokeEffects
      : [];
    const normalizedEffects = effectsFromOptions
      .map((e) => String(e || '').toLowerCase())
      .map((e) => e === 'underline' ? 'box' : e)
      .filter((e) => e === 'highlight' || e === 'box' || e === 'caps');
    const fallbackModeEffects = karaokeMode === 'both'
      ? ['highlight', 'box']
      : (karaokeMode === 'underline' ? ['box'] : [karaokeMode]);
    const karaokeEffects = new Set(normalizedEffects.length
      ? normalizedEffects
      : fallbackModeEffects.map((e) => e === 'underline' ? 'box' : e));
    if (!karaokeEffects.has('highlight') && !karaokeEffects.has('box') && !karaokeEffects.has('caps')) {
      karaokeEffects.add('highlight');
    }
    const secondaryColour = resolvedStyleName === 'Highlight' ? '&H00FFFFFF' : '&H0000D4FF';
    const basePrimaryColour = String(style.primaryColour || '&H00FFFFFF');
    const basePrimaryColourAss = basePrimaryColour.endsWith('&') ? basePrimaryColour : `${basePrimaryColour}&`;
    // Use BorderStyle from the preset (SoftBox=3 for opaque box, others=1 for outline)
    const borderStyle = style.BorderStyle || 1;

    const header = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: 1080',
      'PlayResY: 1920',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      // Keep SecondaryColour close to PrimaryColour to avoid aggressive red karaoke tint.
      `Style: Default,${fontName},${fontSize},${style.primaryColour},${secondaryColour},${style.outlineColour},${style.backColour},${style.bold},0,0,0,100,100,0,0,${borderStyle},${style.outline},${style.shadow},${alignment},10,10,${marginV},204`,
      // Word-level karaoke "red box" style (opaque box background).
      // Padding simulation via Outline thickness (ASS BorderStyle:3 box sizing).
      // Match preview as closely as possible:
      // CSS fill  rgba(255,59,48,0.46) -> ASS BackColour    &HA6303BFF  (alpha ~65%, slightly stronger for dark video bg)
      // CSS border rgba(255,99,90,0.7) -> ASS OutlineColour &HB35A63FF  (alpha 70%)
      // CSS padding ~6px horizontal    -> ASS Outline      3  (box extends 3px around glyph bounds)
      `Style: KaraokeBox,${fontName},${fontSize},&H00FFFFFF,${secondaryColour},&HB35A63FF,&HA6303BFF,${style.bold},0,0,0,100,100,0,0,3,3,0,${alignment},10,10,${marginV},204`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ].join('\n');

    const events = [];
    for (const seg of segments) {
      const words = Array.isArray(seg.words) ? seg.words : [];
      let timedWords = words.filter(w =>
        Number.isFinite(Number(w?.start)) &&
        Number.isFinite(Number(w?.end)) &&
        Number(w.end) > Number(w.start)
      );
      // If Whisper word timestamps are missing/weak, build a deterministic fallback
      // from segment text so karaoke mode still visibly works.
      if (karaoke && timedWords.length === 0) {
        timedWords = buildFallbackTimedWords(seg);
      }
      const hasUsableWordTimeline = timedWords.length >= 1;

      if (hasUsableWordTimeline) {
        let idx = 0;
        while (idx < timedWords.length) {
          const chunk = timedWords.slice(idx, idx + wordsPerLine);
          const cStartAbs = Number(chunk[0].start || seg.start);
          const cEndAbsRaw = Number(chunk[chunk.length - 1].end || seg.end);
          const cEndAbsCapped = Math.min(cEndAbsRaw, cStartAbs + maxLineMs / 1000);

          // Convert absolute Whisper timestamps into local segment time once.
          const cStart = Math.max(0, cStartAbs - offsetSec);
          const cEnd = Math.max(cStart + 0.12, cEndAbsCapped - offsetSec);
          const chunkWords = chunk.map(w => String(w.word || '').trim()).filter(Boolean);
          const chunkTextRaw = String(seg.text || '').trim();
          let text = chunkWords.join(' ').trim();
          if (karaoke) {
            for (let wi = 0; wi < chunk.length; wi++) {
              const w = chunk[wi];
              const wStart = Number(w.start || cStart);
              const nextStart = wi < chunk.length - 1 ? Number(chunk[wi + 1].start || w.end || wStart) : Number(w.end || cEnd);
              const ws = Math.max(0, wStart - offsetSec);
              const we = Math.max(ws + 0.06, Math.min(cEnd, nextStart - offsetSec));
              const line = buildAssKaraokeLine(
                chunkWords,
                wi,
                karaokeEffects,
                resolvedStyleName,
                resolvedCase,
                basePrimaryColourAss
              );
              if (line) {
                events.push(`Dialogue: 0,${seconds2ass(ws)},${seconds2ass(we)},Default,,0,0,0,,${line}`);
              }
            }
            idx += wordsPerLine;
            continue;
          }
          // For non-karaoke output prefer Whisper's original segment text to preserve punctuation.
          if (chunkTextRaw) text = chunkTextRaw;
          text = escapeAssText(applyCaseToText(text, resolvedCase));
          if (text) {
            events.push(`Dialogue: 0,${seconds2ass(cStart)},${seconds2ass(cEnd)},Default,,0,0,0,,${text}`);
          }
          idx += wordsPerLine;
        }
      } else {
        // No word timestamps — still split by wordsPerLine and maxLineMs
        const segWords = String(seg.text || '').trim().split(/\s+/).filter(Boolean);
        const segStart = Math.max(0, seg.start - offsetSec);
        const segEnd = Math.max(segStart + 0.2, seg.end - offsetSec);
        const segDuration = Math.max(0.2, segEnd - segStart);
        const totalWords = segWords.length || 1;
        let idx = 0;
        while (idx < totalWords) {
          const chunkWords = segWords.slice(idx, idx + wordsPerLine);
          const chunkText = escapeAssText(applyCaseToText(chunkWords.join(' '), resolvedCase));
          if (!chunkText) { idx += wordsPerLine; continue; }
          const wordStart = segStart + (idx / totalWords) * segDuration;
          const wordEnd = Math.min(segStart + ((idx + wordsPerLine) / totalWords) * segDuration, segEnd);
          const cStart = wordStart;
          const cEnd = Math.min(Math.max(cStart + 0.2, cStart + maxLineMs / 1000), wordEnd);
          events.push(`Dialogue: 0,${seconds2ass(cStart)},${seconds2ass(cEnd)},Default,,0,0,0,,${chunkText}`);
          idx += wordsPerLine;
        }
      }
    }

    return `${header}\r\n${events.join('\r\n')}\r\n`;
  }

  /**
   * Convert transcription segments to SRT subtitle string.
   * This is a safer fallback format for ffmpeg subtitle burn-in on Windows.
   */
  toSRT(segments, offsetSec = 0, subtitleOptions = {}) {
    const caseName = subtitleOptions.caseName || subtitleOptions.karaokeCase || 'sentence';
    const wordsPerLine = Math.max(1, Number(subtitleOptions.wordsPerLine || 3));
    const maxLineMs = Math.max(300, Number(subtitleOptions.maxLineMs || 1200));
    const karaoke = !!subtitleOptions.karaoke;
    const stylePreset = String(subtitleOptions.stylePreset || 'Classic');
    const karaokeMode = String(subtitleOptions.karaokeMode || 'highlight');
    const effectsFromOptions = Array.isArray(subtitleOptions.karaokeEffects)
      ? subtitleOptions.karaokeEffects
      : [];
    const karaokeEffects = new Set(effectsFromOptions.length
      ? effectsFromOptions
      : (karaokeMode === 'both'
        ? ['highlight', 'underline']
        : [karaokeMode]));
    if (karaokeEffects.has('underline')) karaokeEffects.add('box');
    const rows = [];
    let n = 1;

    for (const seg of segments) {
      const words = Array.isArray(seg.words) ? seg.words : [];
      const timedWords = words.filter(w =>
        Number.isFinite(Number(w?.start)) &&
        Number.isFinite(Number(w?.end)) &&
        Number(w.end) > Number(w.start)
      );
      const hasUsableWordTimeline =
        timedWords.length >= 2 &&
        (Number(timedWords[timedWords.length - 1].start) - Number(timedWords[0].start)) > 0.2;

      if (hasUsableWordTimeline) {
        let idx = 0;
        while (idx < timedWords.length) {
          const chunk = timedWords.slice(idx, idx + wordsPerLine);
          const cStartAbs = Number(chunk[0].start || seg.start);
          const cEndAbsRaw = Number(chunk[chunk.length - 1].end || seg.end);
          const cEndAbsCapped = Math.min(cEndAbsRaw, cStartAbs + maxLineMs / 1000);

          const cStart = Math.max(0, cStartAbs - offsetSec);
          const cEnd = Math.max(cStart + 0.12, cEndAbsCapped - offsetSec);
          const wordsText = chunk.map(w => String(w.word || '').trim()).filter(Boolean);
          let text = wordsText.join(' ').replace(/\r?\n/g, ' ');
          text = applyCaseToText(text, caseName);
          if (karaoke && wordsText.length > 0) {
            const casedWords = text.split(/\s+/).filter(Boolean);
            const hi = casedWords.length > 1 ? Math.floor(casedWords.length / 2) : 0;
            const karaokeWords = casedWords.map((w, i) => {
              if (i !== hi) return w;
              let value = w;
              if (karaokeEffects.has('highlight')) {
                // In yellow-forward style, highlighted karaoke word should be white.
                value = stylePreset === 'Highlight'
                  ? `<font color="#FFFFFF">${value}</font>`
                  : `<font color="#FFD400">${value}</font>`;
              }
              if (karaokeEffects.has('box')) {
                value = `<font bgcolor="#88FF3B30">${value}</font>`;
              }
              if (karaokeEffects.has('caps') && caseName !== 'uppercase') {
                value = String(value).toUpperCase();
              }
              return value;
            });
            text = karaokeWords.join(' ');
          }
          if (text) {
            rows.push(`${n++}\n${seconds2srt(cStart)} --> ${seconds2srt(cEnd)}\n${text}\n`);
          }
          idx += wordsPerLine;
        }
      } else {
        // No word timestamps — still split by wordsPerLine and maxLineMs
        const segWords = String(seg.text || '').replace(/\r?\n/g, ' ').trim().split(/\s+/).filter(Boolean);
        const segStart = Math.max(0, Number(seg.start || 0) - offsetSec);
        const segEnd = Math.max(segStart + 0.2, Number(seg.end || 0) - offsetSec);
        const segDuration = Math.max(0.2, segEnd - segStart);
        const totalWords = segWords.length || 1;
        let idx = 0;
        while (idx < totalWords) {
          const chunkWords = segWords.slice(idx, idx + wordsPerLine);
          let text = applyCaseToText(chunkWords.join(' '), caseName);
          if (!text) { idx += wordsPerLine; continue; }
          const wordStart = segStart + (idx / totalWords) * segDuration;
          const wordEnd = Math.min(segStart + ((idx + wordsPerLine) / totalWords) * segDuration, segEnd);
          const cStart = wordStart;
          const cEnd = Math.min(Math.max(cStart + 0.2, cStart + maxLineMs / 1000), wordEnd);
          if (karaoke && chunkWords.length > 0) {
            const hi = chunkWords.length > 1 ? Math.floor(chunkWords.length / 2) : 0;
            const karaokeWords = chunkWords.map((w, i) => {
              if (i !== hi) return w;
              let value = w;
              if (karaokeEffects.has('highlight')) {
                value = stylePreset === 'Highlight'
                  ? `<font color="#FFFFFF">${value}</font>`
                  : `<font color="#FFD400">${value}</font>`;
              }
              if (karaokeEffects.has('box')) {
                value = `<font bgcolor="#88FF3B30">${value}</font>`;
              }
              if (karaokeEffects.has('caps') && caseName !== 'uppercase') {
                value = String(value).toUpperCase();
              }
              return value;
            });
            text = karaokeWords.join(' ');
          }
          rows.push(`${n++}\n${seconds2srt(cStart)} --> ${seconds2srt(cEnd)}\n${text}\n`);
          idx += wordsPerLine;
        }
      }
    }

    return rows.join('\n');
  }
}

module.exports = { WhisperService, ASS_STYLES };
