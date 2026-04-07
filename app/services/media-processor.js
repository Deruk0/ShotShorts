const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v']);

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

  extractAudio(videoPath, onProgress) {
    const out = path.join(os.tmpdir(), `rsg_audio_${Date.now()}.mp3`);
    onProgress?.({ step: 'Extracting Audio', percent: 5, message: 'Separating audio track…' });

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo().audioCodec('libmp3lame').audioBitrate(128).output(out)
        .on('progress', i => onProgress?.({ step: 'Extracting Audio', percent: 5 + Math.min(i.percent || 0, 100) * 0.15, message: `${Math.round(i.percent || 0)}%` }))
        .on('end', () => resolve(out))
        .on('error', (e, stdout, stderr) => reject(new Error(e.message + (stderr ? '\nstderr: ' + stderr : ''))))
        .run();
    });
  }

  downsampleAudioForAI(inputAudio, onProgress) {
    const out = path.join(os.tmpdir(), `rsg_ai_${Date.now()}.mp3`);
    return new Promise((resolve, reject) => {
      ffmpeg(inputAudio)
        .audioCodec('libmp3lame').audioBitrate(16).audioChannels(1).output(out)
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

  async assembleVideo(segment, audioPath, bgContext, outputDir, onProgress) {
    if (this.cancelled) throw new Error('Cancelled');

    const duration = segment.end - segment.start;
    const safeTitle = segment.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
    const outFileName = segment.partIndex 
      ? `Part ${segment.partIndex} | ${safeTitle}.mp4`
      : `${safeTitle}.mp4`;
    const outFile = path.join(outputDir, outFileName);
    const pId = segment.partIndex ? `${segment.index}_p${segment.partIndex}` : segment.index;
    const segAudio = path.join(os.tmpdir(), `rsg_seg_${pId}_${Date.now()}.mp3`);

    // Cut segment audio
    await new Promise((res, rej) => {
      ffmpeg(audioPath).setStartTime(segment.start).setDuration(duration)
        .audioCodec('libmp3lame').audioBitrate(128).format('mp3')
        .output(segAudio)
        .on('end', res)
        .on('error', (e, stdout, stderr) => rej(new Error(e.message + (stderr ? '\nstderr: ' + stderr : ''))))
        .run();
    });
    if (this.cancelled) throw new Error('Cancelled');

    // Build background list
    let totalDur = 0;
    const selected = [];
    const maxSafetyDur = duration;

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

        const filterStrings = [];
        const concatInputs = [];
        selected.forEach((bg, index) => {
          filterStrings.push(`[${index}:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p[v${index}]`);
          concatInputs.push(`[v${index}]`);
        });
        filterStrings.push(`${concatInputs.join('')}concat=n=${selected.length}:v=1:a=0[vout]`);

        cmd.complexFilter(filterStrings)
          .outputOptions([
            '-t', String(duration),
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '192k',
            '-map', '[vout]', '-map', `${selected.length}:a:0`,
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
      const safeSegAudio = path.join(os.tmpdir(), `rsg_seg_safe_${pId}_${Date.now()}.mp3`);
      try {
        await new Promise((res, rej) => {
          ffmpeg(audioPath)
            .setStartTime(segment.start)
            .setDuration(duration)
            .audioCodec('libmp3lame')
            .audioBitrate(128)
            .audioChannels(2)
            .format('mp3')
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
        if (stats.size < 100) {
          throw new Error(`Segment audio file too small (${stats.size} bytes), likely corrupted`);
        }
      } catch (statErr) {
        throw new Error(`Cannot access segment audio file: ${statErr.message}`);
      }

      try {
        const singleBg = selected[0];
        await new Promise((res, rej) => {
          ffmpeg()
            .input(singleBg)
            .inputOptions(['-stream_loop', '-1', '-re'])
            .input(safeSegAudio)
            .complexFilter([
              `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p[vout]`
            ])
            .outputOptions([
              '-t', String(duration),
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-c:a', 'aac', '-b:a', '192k',
              '-map', '[vout]',
              '-map', '1:a:0',
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
}

module.exports = { MediaProcessor };
