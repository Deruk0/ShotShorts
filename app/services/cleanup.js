const fs = require('fs');
const path = require('path');
const os = require('os');

function runCleanup() {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir);

    const patterns = [/^rsg_audio_/, /^rsg_seg_/, /^rsg_bglist_/, /^rsg_ai_/];
    
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
      console.log(`[RSG Cleanup] Removed ${deletedCount} temporary file(s).`);
    } else {
      console.log(`[RSG Cleanup] No temporary files found to clean up.`);
    }
  } catch (err) {
    console.error('[RSG Cleanup] Error during cleanup:', err);
  }
}

module.exports = { runCleanup };
