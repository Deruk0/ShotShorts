const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v']);
const SRT_STYLE_PRESETS = {
  Classic: { PrimaryColour: '&H00FFFFFF', OutlineColour: '&H00000000', BackColour: '&H00000000', Bold: 1, Outline: 3, Shadow: 2, BorderStyle: 1 },
  Minimal: { PrimaryColour: '&H00E5E7EB', OutlineColour: '&H00000000', BackColour: '&H00000000', Bold: 0, Outline: 1.5, Shadow: 1.5, BorderStyle: 1 },
  Highlight: { PrimaryColour: '&H0066E0FF', OutlineColour: '&H00000000', BackColour: '&H00000000', Bold: 1, Outline: 3.5, Shadow: 3, BorderStyle: 1 },
  TikTokBold: { PrimaryColour: '&H00FFFFFF', OutlineColour: '&H00000000', BackColour: '&H00000000', Bold: 1, Outline: 5, Shadow: 5, BorderStyle: 1 },
  HeavyShadow: { PrimaryColour: '&H00FFFFFF', OutlineColour: '&H00000000', BackColour: '&H00000000', Bold: 1, Outline: 5, Shadow: 8, BorderStyle: 1 },
  SoftBox: { PrimaryColour: '&H00F2F2F2', OutlineColour: '&H30FFFFFF', BackColour: '&H7A000000', Bold: 1, Outline: 2, Shadow: 1.5, BorderStyle: 3 }
};

class MediaProcessor {
  constructor() {
    this.cancelled = false;
    this._detectFfmpeg();
  }

  _detectFfmpeg() {
    // Bundled ffmpeg.exe in app/resources/ (dev) or resources/resources/ (after build)
    const devBundled  = path.join(__dirname, '..', 'resources', 'ffmpeg.exe');
    const prodBundled = path.join(path.dirname(process.execPath), 'resources', 'resources', 'ffmpeg.exe');

    const candidates = [
      devBundled,
      prodBundled,
      'ffmpeg',
      path.join(process.env.PROGRAMFILES  || 'C:\\Program Files',  'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'ffmpeg',  'bin', 'ffmpeg.exe'),
      path.join(process.env.LOCALAPPDATA  || '', 'ffmpeg',          'bin', 'ffmpeg.exe'),
      path.join(os.homedir(), 'ffmpeg',    'bin', 'ffmpeg.exe'),
      path.join(os.homedir(), 'scoop',     'shims', 'ffmpeg.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe'
    ];

    for (const c of candidates) {
      try {
        if (c === 'ffmpeg' || fs.existsSync(c)) {
          ffmpeg.setFfmpegPath(c);
          // Try to set ffprobe from the same directory
          const probe = c === 'ffmpeg' ? 'ffprobe' : path.join(path.dirname(c), 'ffprobe.exe');
          try { if (c === 'ffmpeg' || fs.existsSync(probe)) ffmpeg.setFfprobePath(probe); } catch {}
          return;
        }
      } catch {}
    }
  }

  cancel() { this.cancelled = true; }
  reset() { this.cancelled = false; }

  _buildSrtForceStyle(subtitleOptions = {}) {
    const position = subtitleOptions.position || 'bottom';
    const alignment = position === 'top' ? 8 : (position === 'middle' ? 5 : 2);
    const marginV = Math.max(10, Number(subtitleOptions.marginV || 40));
    const fontSize = Math.max(12, Number(subtitleOptions.fontSize || 20));
    const fontName = String(subtitleOptions.fontFamily || 'Inter').replace(/'/g, '');
    const stylePreset = String(subtitleOptions.stylePreset || 'Classic');
    const preset = SRT_STYLE_PRESETS[stylePreset] || SRT_STYLE_PRESETS.Classic;
    // Commas must be escaped for ffmpeg filter parser.
    return `Alignment=${alignment}\\,MarginV=${marginV}\\,FontSize=${fontSize}\\,FontName=${fontName}\\,PrimaryColour=${preset.PrimaryColour}\\,OutlineColour=${preset.OutlineColour}\\,BackColour=${preset.BackColour}\\,Bold=${preset.Bold}\\,Outline=${preset.Outline}\\,Shadow=${preset.Shadow}\\,BorderStyle=${preset.BorderStyle}`;
  }

  _escapeSubtitlePathForFilter(subtitlePath) {
    // Robust escaping for ffmpeg filter parser on Windows paths.
    return String(subtitlePath || '')
      .replace(/\\/g, '/')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'")
      .replace(/,/g, '\\,')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/;/g, '\\;')
      .replace(/ /g, '\\ ');
  }

  /**
   * Build the ffmpeg `ass=...` filter argument including `fontsdir=` when
   * available. Both paths are escaped for the libavfilter parser.
   */
  _buildAssFilterArgs(subtitlePath, subtitleOptions = {}) {
    const escapedSubs = this._escapeSubtitlePathForFilter(subtitlePath);
    const fontsDir = subtitleOptions && subtitleOptions.fontsDir;
    if (fontsDir && fs.existsSync(fontsDir)) {
      const escapedFonts = this._escapeSubtitlePathForFilter(fontsDir);
      return `ass='${escapedSubs}':fontsdir='${escapedFonts}'`;
    }
    return `ass='${escapedSubs}'`;
  }

  extractAudio(videoPath, onProgress) {
    const out = path.join(os.tmpdir(), `ss_audio_${Date.now()}.wav`);
    onProgress?.({ step: 'Extracting Audio', percent: 5, message: 'Separating audio track…' });

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo().audioCodec('pcm_s16le').audioChannels(2).audioFrequency(44100).format('wav').output(out)
        .on('progress', i => onProgress?.({ step: 'Extracting Audio', percent: 5 + Math.min(i.percent || 0, 100) * 0.15, message: `${Math.round(i.percent || 0)}%` }))
        .on('end', () => resolve(out))
        .on('error', (e, stdout, stderr) => reject(new Error(e.message + (stderr ? '\nstderr: ' + stderr : ''))))
        .run();
    });
  }

  downsampleAudioForAI(inputAudio, onProgress) {
    const out = path.join(os.tmpdir(), `ss_ai_${Date.now()}.wav`);
    return new Promise((resolve, reject) => {
      ffmpeg(inputAudio)
        .audioCodec('pcm_s16le').audioBitrate(16).audioChannels(1).audioFrequency(16000).format('wav').output(out)
        .on('progress', i => onProgress?.({ step: 'Analyzing Audio', percent: 22, message: `Optimizing for AI... ${Math.round(i.percent || 0)}%` }))
        .on('end', () => resolve(out))
        .on('error', (e, stdout, stderr) => reject(new Error(e.message + (stderr ? '\nstderr: ' + stderr : ''))))
        .run();
    });
  }


  getBackgroundVideos(folder) {
    return fs.readdirSync(folder)
      .filter(f => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
      .map(f => path.join(folder, f));
  }

  getVideoDuration(file) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(file, (err, data) => {
        if (err) reject(err);
        else resolve(data.format.duration || 0);
      });
    });
  }

  /**
   * @param {string|null} subtitlePath  Optional path to subtitle file (.ass/.srt) to burn in.
   */
  async assembleVideo(segment, audioPath, bgContext, outputDir, onProgress, subtitlePath = null, subtitleOptions = {}) {
    if (this.cancelled) throw new Error('Cancelled');

    console.log(`[ShotShorts] assembleVideo called, subtitlePath: ${subtitlePath || 'null'}`);

    const duration = segment.end - segment.start;
    const safeTitle = this._sanitizeFileName(segment.title || `Story ${segment.index}`);
    const outFileName = segment.partIndex
      ? this._sanitizeFileName(`Part ${segment.partIndex} - ${safeTitle}.mp4`)
      : this._sanitizeFileName(`${safeTitle}.mp4`);
    const outFile = path.join(outputDir, outFileName);
    const pId = segment.partIndex ? `${segment.index}_p${segment.partIndex}` : segment.index;
    const segAudio = path.join(os.tmpdir(), `ss_seg_${pId}_${Date.now()}.wav`);

    // Cut segment audio
    await new Promise((res, rej) => {
      ffmpeg(audioPath).setStartTime(segment.start).setDuration(duration)
        .audioCodec('pcm_s16le').audioChannels(2).audioFrequency(44100).format('wav')
        .output(segAudio)
        .on('end', res)
        .on('error', (e, stdout, stderr) => rej(new Error(e.message + (stderr ? '\nstderr: ' + stderr : ''))))
        .run();
    });
    if (this.cancelled) throw new Error('Cancelled');

    // Build background list — add 5s safety margin to prevent video freezing
    // before audio ends due to PTS rounding in concat filter
    let totalDur = 0;
    const selected = [];
    const maxSafetyDur = duration + 5;

    while (totalDur < maxSafetyDur) {
      if (bgContext.unused.length === 0) {
        if (bgContext.all.length === 0) break;
        let nextBatch = [...bgContext.all].sort(() => Math.random() - 0.5);
        if (selected.length > 0 && nextBatch[0] === selected[selected.length - 1] && nextBatch.length > 1) {
          const temp = nextBatch[0];
          nextBatch[0] = nextBatch[1];
          nextBatch[1] = temp;
        }
        bgContext.unused = nextBatch;
      }
      const bg = bgContext.unused.shift();
      try {
        let d = bgContext.durations[bg];
        if (d === undefined) {
          d = await this.getVideoDuration(bg);
          bgContext.durations[bg] = d;
        }
        if (d > 0) {
          selected.push(bg);
          totalDur += d;
        }
      } catch (err) {
        // Skip inaccessible videos
      }
    }

    if (this.cancelled) throw new Error('Cancelled');

    if (selected.length === 0) {
      throw new Error('No usable background videos found');
    }

    const msgTitle = segment.partIndex ? `"${segment.title}" (Part ${segment.partIndex})` : `"${segment.title}"`;
    onProgress?.({ step: `Rendering Story ${segment.index}`, percent: 0, message: `${msgTitle} (${Math.round(duration)}s)` });

    const progressHandler = i => {
      let p = i.percent || 0;
      if (i.timemark) {
        const parts = i.timemark.split(':');
        if (parts.length === 3) {
          const currentSeconds = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
          if (duration > 0) p = (currentSeconds / duration) * 100;
        }
      }
      onProgress?.({
        step: `Rendering Story ${segment.index}`,
        percent: Math.min(p, 100),
        message: `${msgTitle} — ${Math.min(Math.round(p), 100)}%`
      });
    };

    // Helper: check if subtitle is a rendered video overlay
    const isSubtitleVideo = subtitlePath && /\.(webm|mov)$/i.test(subtitlePath);

    // Merge
    try {
      // If total background duration is less than needed, concat will freeze last frame.
      // Use loop fallback instead to avoid frozen frames.
      if (totalDur < duration) {
        throw new Error('Insufficient background duration, using loop fallback');
      }

      await new Promise((res, rej) => {
        const cmd = ffmpeg();
        selected.forEach(bg => cmd.input(bg));
        cmd.input(segAudio);
        if (isSubtitleVideo) cmd.input(subtitlePath);

        const filterStrings = [];
        const concatInputs = [];
        selected.forEach((bg, index) => {
          filterStrings.push(`[${index}:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p[v${index}]`);
          concatInputs.push(`[v${index}]`);
        });
        filterStrings.push(`${concatInputs.join('')}concat=n=${selected.length}:v=1:a=0[vconcat]`);

        // Burn-in subtitles if provided
        if (subtitlePath) {
          console.log(`[ShotShorts] Applying subtitle: ${subtitlePath}, ext: ${path.extname(subtitlePath).toLowerCase()}`);
          if (isSubtitleVideo) {
            // Overlay pre-rendered subtitle video with alpha
            const subInputIndex = selected.length + 1;
            filterStrings.push(`[vconcat][${subInputIndex}:v]overlay=0:0:eof_action=pass:format=auto[vout]`);
            console.log(`[ShotShorts] Using video overlay for subtitles`);
          } else {
            const escaped = this._escapeSubtitlePathForFilter(subtitlePath);
            const ext = path.extname(subtitlePath).toLowerCase();
            console.log(`[ShotShorts] Escaped subtitle path: ${escaped}`);
            if (ext === '.ass') {
              filterStrings.push(`[vconcat]${this._buildAssFilterArgs(subtitlePath, subtitleOptions)}[vout]`);
            } else {
              const forceStyle = this._buildSrtForceStyle(subtitleOptions);
              filterStrings.push(`[vconcat]subtitles='${escaped}':charenc=UTF-8:force_style='${forceStyle}'[vout]`);
            }
          }
        } else {
          // `copy` is not a valid filter; use no-op pass-through.
          filterStrings.push(`[vconcat]null[vout]`);
        }

        const audioInputIndex = selected.length;
        cmd.complexFilter(filterStrings)
          .outputOptions([
            '-t', String(duration),
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '192k',
            '-map', '[vout]', '-map', `${audioInputIndex}:a:0`,
            '-shortest',
            '-movflags', '+faststart'
          ])
          .output(outFile)
          .on('progress', progressHandler)
          .on('end', () => res())
          .on('error', (e, stdout, stderr) => rej(new Error(e.message + (stderr ? '\nstderr: ' + stderr : ''))))
          .run();
      });
    } catch (concatError) {
      if (this.cancelled) throw new Error('Cancelled');
      onProgress?.({ step: `Rendering Story ${segment.index}`, percent: 0, message: `Concat failed, trying safe fallback...` });
      
      // Fallback: Re-create segAudio with explicit format to avoid corruption
      const safeSegAudio = path.join(os.tmpdir(), `ss_seg_safe_${pId}_${Date.now()}.wav`);
      try {
        await new Promise((res, rej) => {
          ffmpeg(audioPath)
            .setStartTime(segment.start)
            .setDuration(duration)
            .audioCodec('pcm_s16le')
            .audioChannels(2)
            .audioFrequency(44100)
            .format('wav')
            .output(safeSegAudio)
            .on('end', res)
            .on('error', (e, stdout, stderr) => rej(new Error(e.message + (stderr ? '\nstderr: ' + stderr : ''))))
            .run();
        });
      } catch (recreateErr) {
        throw new Error(`Failed to create segment audio: ${recreateErr.message}`);
      }

      try {
        // Verify the file exists and has content
        const stats = fs.statSync(safeSegAudio);
        if (stats.size < 2000) {
          throw new Error(`Segment audio file too small (${stats.size} bytes), likely corrupted or boundaries out of range`);
        }
      } catch (statErr) {
        throw new Error(`Cannot access segment audio file: ${statErr.message}`);
      }

      try {
        const singleBg = selected[0];
        await new Promise((res, rej) => {
          const fallbackFilters = [
            `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p[vscaled]`
          ];
          if (subtitlePath) {
            if (isSubtitleVideo) {
              fallbackFilters.push(`[vscaled][1:v]overlay=0:0:eof_action=pass:format=auto[vout]`);
            } else {
              const escaped = this._escapeSubtitlePathForFilter(subtitlePath);
              const ext = path.extname(subtitlePath).toLowerCase();
              if (ext === '.ass') {
                fallbackFilters.push(`[vscaled]${this._buildAssFilterArgs(subtitlePath, subtitleOptions)}[vout]`);
              } else {
                const forceStyle = this._buildSrtForceStyle(subtitleOptions);
                fallbackFilters.push(`[vscaled]subtitles='${escaped}':charenc=UTF-8:force_style='${forceStyle}'[vout]`);
              }
            }
          } else {
            // `copy` is not a valid filter; use no-op pass-through.
            fallbackFilters.push(`[vscaled]null[vout]`);
          }

          const cmd = ffmpeg()
            .input(singleBg)
            .inputOptions(['-stream_loop', '-1']);
          if (isSubtitleVideo) cmd.input(subtitlePath);
          cmd.input(safeSegAudio);

          const audioMapIndex = isSubtitleVideo ? 2 : 1;
          cmd.complexFilter(fallbackFilters)
            .outputOptions([
              '-t', String(duration),
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-c:a', 'aac', '-b:a', '192k',
              '-map', '[vout]',
              '-map', `${audioMapIndex}:a:0`,
              '-shortest',
              '-movflags', '+faststart'
            ])
            .output(outFile)
            .on('progress', progressHandler)
            .on('end', () => res())
            .on('error', (e, stdout, stderr) => rej(new Error(`Fallback failed: ${e.message}` + (stderr ? '\nstderr: ' + stderr : ''))))
            .run();
        });
      } finally {
        try { fs.unlinkSync(safeSegAudio); } catch {}
      }
    } finally {
      try { fs.unlinkSync(segAudio); } catch {}
    }

    return outFile;
  }

  _sanitizeFileName(name) {
    const base = String(name || 'output')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '');

    const normalized = base || 'output';
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
    const safe = reserved.test(normalized) ? `_${normalized}` : normalized;
    return safe.slice(0, 180);
  }
}

module.exports = { MediaProcessor };
