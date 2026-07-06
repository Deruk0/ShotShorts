const fs = require('fs');
const path = require('path');
const os = require('os');

function runCleanup() {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir);

    const patterns = [
      /^ss_audio_/,
      /^ss_seg_/,
      /^ss_seg_safe_/,
      /^ss_bglist_/,
      /^ss_ai_/,
      /^ss_whisper_/,
      /^ss_sub_/
    ];
    
    let deletedCount = 0;

    for (const file of files) {
      if (patterns.some(regex => regex.test(file))) {
        const filePath = path.join(tmpDir, file);
        try {
          fs.unlinkSync(filePath);
          deletedCount++;
        } catch (err) {
          console.error(`Failed to delete temp file ${filePath}:`, err);
        }
      }
    }
    
    if (deletedCount > 0) {
      console.log(`[ShotShorts Cleanup] Removed ${deletedCount} temporary file(s).`);
    } else {
      console.log(`[ShotShorts Cleanup] No temporary files found to clean up.`);
    }

    const subtitleTmpDir = path.join(tmpDir, 'shotshorts_subtitles');
    if (fs.existsSync(subtitleTmpDir)) {
      fs.rmSync(subtitleTmpDir, { recursive: true, force: true });
      console.log('[ShotShorts Cleanup] Removed temporary subtitle render directory.');
    }
  } catch (err) {
    console.error('[ShotShorts Cleanup] Error during cleanup:', err);
  }
}

module.exports = { runCleanup };
