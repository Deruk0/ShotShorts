const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createAbortError, runFfmpegCommand } = require('./cancellation');
const { buildBannerFilterStrings, buildInterstitialFilterGraph, planInterstitialSegments, resolveDisplayDimensions, hasAlphaPixFmt } = require('./banner-utils');

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
    this.activeCommands = new Set();
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

  cancel() {
    this.cancelled = true;
    for (const cmd of this.activeCommands) {
      try { cmd.kill('SIGKILL'); } catch {}
    }
  }

  reset() {
    this.cancelled = false;
    this.activeCommands.clear();
  }

  _throwIfCancelled() {
    if (this.cancelled) throw createAbortError();
  }

  _runCommand(cmd) {
    this._throwIfCancelled();
    return runFfmpegCommand(cmd, {
      onStart: (activeCmd) => this.activeCommands.add(activeCmd),
      formatError: (e, stdout, stderr) => new Error(e.message + (stderr ? '\nstderr: ' + stderr : ''))
    }).finally(() => {
      this.activeCommands.delete(cmd);
      this._throwIfCancelled();
    });
  }

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

    const cmd = ffmpeg(videoPath)
        .noVideo().audioCodec('pcm_s16le').audioChannels(2).audioFrequency(44100).format('wav').output(out)
        .on('progress', i => {
          if (!this.cancelled) {
            onProgress?.({ step: 'Extracting Audio', percent: 5 + Math.min(i.percent || 0, 100) * 0.15, message: `${Math.round(i.percent || 0)}%` });
          }
        });

    return this._runCommand(cmd).then(() => out);
  }

  downsampleAudioForAI(inputAudio, onProgress) {
    const out = path.join(os.tmpdir(), `ss_ai_${Date.now()}.wav`);
    const cmd = ffmpeg(inputAudio)
        .audioCodec('pcm_s16le').audioBitrate(16).audioChannels(1).audioFrequency(16000).format('wav').output(out)
        .on('progress', i => {
          if (!this.cancelled) {
            onProgress?.({ step: 'Analyzing Audio', percent: 22, message: `Optimizing for AI... ${Math.round(i.percent || 0)}%` });
          }
        });

    return this._runCommand(cmd).then(() => out);
  }


  getBackgroundVideos(folder) {
    const videos = [];
    const visit = (directory) => {
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (err) {
        console.warn(`[ShotShorts] Cannot read background directory "${directory}": ${err.message}`);
        return;
      }

      for (const entry of entries) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(filePath);
        } else if (entry.isFile() && VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
          videos.push(filePath);
        }
      }
    };

    visit(folder);
    console.log(`[ShotShorts] Found ${videos.length} background video(s) in "${folder}" (including subfolders).`);
    return videos;
  }

  getVideoDuration(file) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(file, (err, data) => {
        if (err) reject(err);
        else resolve(data.format.duration || 0);
      });
    });
  }

  getMediaDimensions(file) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(file, (err, data) => {
        if (err) return reject(err);
        const stream = (data.streams || []).find((s) => s.width && s.height);
        if (!stream) return reject(new Error('No readable video stream'));
        const dims = resolveDisplayDimensions(stream);
        if (!dims.width || !dims.height) return reject(new Error('No readable video stream'));
        const hasAudio = (data.streams || []).some((s) => s.codec_type === 'audio');
        const durationRaw = Number(data.format && data.format.duration);
        const durationSec = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;
        resolve({ ...dims, pixFmt: stream.pix_fmt || '', codecName: stream.codec_name || '', hasAudio, durationSec });
      });
    });
  }

  /**
   * Re-encode a banner video once into a clean, loop-friendly temp file:
   * rotation baked in, constant 30fps, even dimensions, audio stripped.
   * This makes every decodable container/codec play reliably as a looping
   * banner (edit lists, VFR, HDR, odd sizes, exotic timebases). GIFs are
   * skipped (they loop fine as-is) and failures fall back to the original.
   */
  async normalizeBannerVideo(srcPath, mediaInfo, onProgress) {
    const pixFmt = String((mediaInfo && mediaInfo.pixFmt) || '').toLowerCase();
    const width = Math.max(2, Number(mediaInfo && mediaInfo.width) || 0);

    // Cap huge sources at 1080px wide and force even dimensions (required
    // by yuv420p / vp9 encoders). Height keeps the aspect via -2.
    let evenW = Math.min(width, 1080);
    if (evenW % 2 !== 0) evenW -= 1;
    if (evenW < 2) evenW = 2;

    const hasAlpha = hasAlphaPixFmt(pixFmt);
    const out = path.join(os.tmpdir(), `ss_banner_norm_${Date.now()}.${hasAlpha ? 'webm' : 'mp4'}`);
    onProgress?.('Normalizing banner video for reliable playback…');

    const codecOptions = hasAlpha
      ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '30', '-b:v', '0', '-auto-alt-ref', '0']
      : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20'];

    const cmd = ffmpeg(srcPath)
      .outputOptions([
        '-vf', `scale=${evenW}:-2:flags=lanczos,fps=30,setsar=1,format=${hasAlpha ? 'yuva420p' : 'yuv420p'}`,
        ...codecOptions,
        '-an',
        '-t', '60'
      ])
      .output(out);

    await this._runCommand(cmd);

    const stats = fs.existsSync(out) ? fs.statSync(out) : null;
    if (!stats || stats.size < 1000) {
      try { if (stats) fs.unlinkSync(out); } catch {}
      throw new Error('normalized banner is empty');
    }
    return out;
  }

  /**
   * @param {string|null} subtitlePath  Optional path to subtitle file (.ass/.srt) to burn in.
   * @param {object|null} bannerOptions  Optional banner overlay: { path, isImage, layout: {x,y,width,height} }.
   */
  async assembleVideo(segment, audioPath, bgContext, outputDir, onProgress, subtitlePath = null, subtitleOptions = {}, bannerOptions = null) {
    this._throwIfCancelled();

    console.log(`[ShotShorts] assembleVideo called, subtitlePath: ${subtitlePath || 'null'}, banner: ${bannerOptions?.path || 'null'}`);

    const duration = segment.end - segment.start;
    const safeTitle = this._sanitizeFileName(segment.title || `Story ${segment.index}`);
    const outFileName = segment.partIndex
      ? this._sanitizeFileName(`Part ${segment.partIndex} - ${safeTitle}.mp4`)
      : this._sanitizeFileName(`${safeTitle}.mp4`);
    const outFile = path.join(outputDir, outFileName);
    const pId = segment.partIndex ? `${segment.index}_p${segment.partIndex}` : segment.index;
    const segAudio = path.join(os.tmpdir(), `ss_seg_${pId}_${Date.now()}.wav`);

    // Cut segment audio
    await this._runCommand(
      ffmpeg(audioPath).setStartTime(segment.start).setDuration(duration)
        .audioCodec('pcm_s16le').audioChannels(2).audioFrequency(44100).format('wav')
        .output(segAudio)
    );
    this._throwIfCancelled();

    // Build background list — add 5s safety margin to prevent video freezing
    // before audio ends due to PTS rounding in concat filter
    let totalDur = 0;
    const selected = [];
    const maxSafetyDur = duration + 5;
    const unusableBackgrounds = new Set();

    while (totalDur < maxSafetyDur) {
      if (bgContext.unused.length === 0) {
        const usableBackgrounds = bgContext.all.filter(bg => !unusableBackgrounds.has(bg));
        if (usableBackgrounds.length === 0) break;
        let nextBatch = [...usableBackgrounds].sort(() => Math.random() - 0.5);
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
        } else {
          unusableBackgrounds.add(bg);
          console.warn(`[ShotShorts] Skipping background with invalid duration: ${bg}`);
        }
      } catch (err) {
        unusableBackgrounds.add(bg);
        console.warn(`[ShotShorts] Skipping unreadable background "${bg}": ${err.message}`);
      }
    }

    this._throwIfCancelled();

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

        // Interstitial mode: freeze the main video + silence inside every
        // scheduled window while the banner video plays with its own audio.
        // Windows depend on this clip's duration, so the plan is built here.
        // Each window gets its own banner demuxer (one input per window):
        // a shared split-branched banner stream loses buffered frames when
        // the filtergraph reinitializes, leaving later windows empty.
        const interstitialActive = !!(bannerOptions && bannerOptions.interstitial && !bannerOptions.isImage);
        const interstitialPlanDef = interstitialActive
          ? planInterstitialSegments(duration, bannerOptions.interstitial.intervalSec, bannerOptions.interstitial.durationSec)
          : null;
        const interstitialWindows = interstitialPlanDef
          ? interstitialPlanDef.segments.filter((s) => s.type === 'window').length
          : 0;
        const interstitialPlan = interstitialPlanDef && interstitialWindows > 0
          ? buildInterstitialFilterGraph({
            baseLabel: 'vconcat',
            bannerIndexBase: selected.length + 1 + (isSubtitleVideo ? 1 : 0),
            audioInputIndex: selected.length,
            bannerHasAudio: !!bannerOptions.bannerHasAudio,
            layout: bannerOptions.layout,
            opacity: bannerOptions.opacity,
            segments: interstitialPlanDef.segments
          })
          : null;
        if (interstitialPlan) {
          // One banner input (video+audio) per interstitial window.
          for (let w = 0; w < interstitialWindows; w++) {
            cmd.input(bannerOptions.path);
          }
          filterStrings.push(...interstitialPlan.filters);
          console.log(`[ShotShorts] Interstitial banner: ${interstitialWindows} window(s) of ${bannerOptions.interstitial.durationSec}s every ${bannerOptions.interstitial.intervalSec}s`);
        } else if (bannerOptions) {
          cmd.input(bannerOptions.path);
          if (!bannerOptions.isImage) cmd.inputOptions(['-stream_loop', '-1']);
        }

        // Burn-in subtitles if provided
        if (subtitlePath) {
          const baseVideoLabel = interstitialPlan ? interstitialPlan.videoLabel : 'vconcat';
          console.log(`[ShotShorts] Applying subtitle: ${subtitlePath}, ext: ${path.extname(subtitlePath).toLowerCase()}`);
          if (isSubtitleVideo) {
            // Overlay pre-rendered subtitle video with alpha
            const subInputIndex = selected.length + 1;
            filterStrings.push(`[${baseVideoLabel}][${subInputIndex}:v]overlay=0:0:eof_action=pass:format=yuv420[vsub]`);
            console.log(`[ShotShorts] Using video overlay for subtitles`);
          } else {
            const escaped = this._escapeSubtitlePathForFilter(subtitlePath);
            const ext = path.extname(subtitlePath).toLowerCase();
            console.log(`[ShotShorts] Escaped subtitle path: ${escaped}`);
            if (ext === '.ass') {
              filterStrings.push(`[${baseVideoLabel}]${this._buildAssFilterArgs(subtitlePath, subtitleOptions)}[vsub]`);
            } else {
              const forceStyle = this._buildSrtForceStyle(subtitleOptions);
              filterStrings.push(`[${baseVideoLabel}]subtitles='${escaped}':charenc=UTF-8:force_style='${forceStyle}'[vsub]`);
            }
          }
        } else {
          // `copy` is not a valid filter; use no-op pass-through. In
          // interstitial mode the composed video arrives as [ivout].
          const passThroughBase = interstitialPlan ? interstitialPlan.videoLabel : 'vconcat';
          filterStrings.push(`[${passThroughBase}]null[vsub]`);
        }

        // Overlay the ad banner on top of everything (overlay mode only;
        // interstitial mode already composited its own [ivout] chain).
        if (bannerOptions && !interstitialPlan) {
          const bannerInputIndex = selected.length + 1 + (isSubtitleVideo ? 1 : 0);
          filterStrings.push(...buildBannerFilterStrings(bannerInputIndex, bannerOptions.layout, 'vsub', 'vout', bannerOptions.opacity));
          console.log(`[ShotShorts] Applying banner: ${bannerOptions.path} at ${bannerOptions.layout.x},${bannerOptions.layout.y} ${bannerOptions.layout.width}x${bannerOptions.layout.height} opacity=${bannerOptions.opacity ?? 1}`);
        } else {
          filterStrings.push(`[vsub]null[vout]`);
        }

        const audioInputIndex = selected.length;
        // Interstitial windows extend the clip: the main content pauses while
        // the banner plays, so the output runs longer than the audio chunk.
        const interstitialExtra = interstitialPlan
          ? interstitialPlanDef.segments
            .filter((s) => s.type === 'window')
            .reduce((sum, s) => sum + s.duration, 0)
          : 0;
        const audioMap = interstitialPlan ? `[iall]` : `${audioInputIndex}:a:0`;
        cmd.complexFilter(filterStrings)
          .outputOptions([
            '-t', String(duration + interstitialExtra),
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '192k',
            '-map', '[vout]', '-map', audioMap,
            '-shortest',
            '-movflags', '+faststart'
          ])
          .output(outFile)
          .on('progress', progressHandler);

        this._runCommand(cmd).then(res).catch(rej);
      });
    } catch (concatError) {
      this._throwIfCancelled();
      onProgress?.({ step: `Rendering Story ${segment.index}`, percent: 0, message: `Concat failed, trying safe fallback...` });
      
      // Fallback: Re-create segAudio with explicit format to avoid corruption
      const safeSegAudio = path.join(os.tmpdir(), `ss_seg_safe_${pId}_${Date.now()}.wav`);
      try {
        await this._runCommand(
          ffmpeg(audioPath)
            .setStartTime(segment.start)
            .setDuration(duration)
            .audioCodec('pcm_s16le')
            .audioChannels(2)
            .audioFrequency(44100)
            .format('wav')
            .output(safeSegAudio)
        );
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

          // Interstitial graph works the same way on the fallback path: the
          // paused frame comes from the scaled single background. One banner
          // demuxer per window (see the main-path comment).
          const fallbackInterstitial = bannerOptions && bannerOptions.interstitial && !bannerOptions.isImage
            ? planInterstitialSegments(duration, bannerOptions.interstitial.intervalSec, bannerOptions.interstitial.durationSec)
            : null;
          const fallbackWindows = fallbackInterstitial
            ? fallbackInterstitial.segments.filter((s) => s.type === 'window').length
            : 0;
          const fallbackPlan = fallbackInterstitial && fallbackWindows > 0
            ? buildInterstitialFilterGraph({
              baseLabel: 'vscaled',
              bannerIndexBase: isSubtitleVideo ? 3 : 2,
              audioInputIndex: isSubtitleVideo ? 2 : 1,
              bannerHasAudio: !!bannerOptions.bannerHasAudio,
              layout: bannerOptions.layout,
              opacity: bannerOptions.opacity,
              segments: fallbackInterstitial.segments
            })
            : null;
          if (fallbackPlan) {
            fallbackFilters.push(...fallbackPlan.filters);
            console.log(`[ShotShorts] Interstitial banner (fallback path): ${fallbackWindows} window(s)`);
          }

          if (subtitlePath) {
            const fallbackBase = fallbackPlan ? fallbackPlan.videoLabel : 'vscaled';
            if (isSubtitleVideo) {
              fallbackFilters.push(`[${fallbackBase}][1:v]overlay=0:0:eof_action=pass:format=yuv420[vsub]`);
            } else {
              const escaped = this._escapeSubtitlePathForFilter(subtitlePath);
              const ext = path.extname(subtitlePath).toLowerCase();
              if (ext === '.ass') {
                fallbackFilters.push(`[${fallbackBase}]${this._buildAssFilterArgs(subtitlePath, subtitleOptions)}[vsub]`);
              } else {
                const forceStyle = this._buildSrtForceStyle(subtitleOptions);
                fallbackFilters.push(`[${fallbackBase}]subtitles='${escaped}':charenc=UTF-8:force_style='${forceStyle}'[vsub]`);
              }
            }
          } else {
            // `copy` is not a valid filter; use no-op pass-through.
            const passBase = fallbackPlan ? fallbackPlan.videoLabel : 'vscaled';
            fallbackFilters.push(`[${passBase}]null[vsub]`);
          }

          const cmd = ffmpeg()
            .input(singleBg)
            .inputOptions(['-stream_loop', '-1']);
          if (isSubtitleVideo) cmd.input(subtitlePath);
          cmd.input(safeSegAudio);
          if (bannerOptions && fallbackPlan) {
            // One banner input (video+audio) per interstitial window.
            for (let w = 0; w < fallbackWindows; w++) {
              cmd.input(bannerOptions.path);
            }
          } else if (bannerOptions) {
            cmd.input(bannerOptions.path);
            if (!bannerOptions.isImage) cmd.inputOptions(['-stream_loop', '-1']);
          }

          const audioMapIndex = isSubtitleVideo ? 2 : 1;
          if (bannerOptions && !fallbackPlan) {
            fallbackFilters.push(...buildBannerFilterStrings(audioMapIndex + 1, bannerOptions.layout, 'vsub', 'vout', bannerOptions.opacity));
          } else {
            // With a fallbackPlan [vsub] already comes from [ivout] (either
            // via the subtitle burn or the null pass-through above).
            fallbackFilters.push(`[vsub]null[vout]`);
          }

          const interstitialExtraFb = fallbackPlan
            ? fallbackInterstitial.segments
              .filter((s) => s.type === 'window')
              .reduce((sum, s) => sum + s.duration, 0)
            : 0;
          const fallbackAudioMap = fallbackPlan ? `[iall]` : `${audioMapIndex}:a:0`;

          cmd.complexFilter(fallbackFilters)
            .outputOptions([
              '-t', String(duration + interstitialExtraFb),
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-c:a', 'aac', '-b:a', '192k',
              '-map', '[vout]',
              '-map', fallbackAudioMap,
              '-shortest',
              '-movflags', '+faststart'
            ])
            .output(outFile)
            .on('progress', progressHandler);

          this._runCommand(cmd).then(res).catch((err) => {
            if (this.cancelled) {
              rej(err);
            } else {
              rej(new Error(`Fallback failed: ${err.message}`));
            }
          });
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
