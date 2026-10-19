// Run manually: node test/banner-ui-smoke.cjs. Uses an isolated Electron profile.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shotshorts-banner-ui-'));
  let electron;
  try {
    const banner = path.join(temp, 'green.mp4');
    const encoded = spawnSync(path.resolve(__dirname, '../app/resources/ffmpeg.exe'), ['-v', 'error', '-f', 'lavfi',
      '-i', 'color=0x00FF00:s=64x64:d=1', '-vf', 'drawbox=x=16:y=16:w=32:h=32:color=red:t=fill',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', banner], { timeout: 30000 });
    assert.equal(encoded.status, 0, encoded.stderr?.toString());
    const bootstrap = path.join(temp, 'main.cjs');
    await fs.writeFile(bootstrap, `const {app}=require('electron'); app.setPath('userData', ${JSON.stringify(temp)}); require(${JSON.stringify(path.resolve(__dirname, '../app/main.js'))});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    electron = await _electron.launch({ args: [bootstrap], env });
    const page = await electron.firstWindow();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.waitForFunction(() => !!window.api);
    await page.evaluate(async filePath => {
      await window.api.saveSettings({ bannerEnabled: true, bannerPath: filePath, bannerChromaKey: false, appLanguage: 'ru' });
    }, banner);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#banner-toggle').checked);
    assert.equal(await page.locator('#banner-chroma-key').isChecked(), false);
    await page.locator('#banner-chroma-key').evaluate(el => { el.checked = true; el.dispatchEvent(new Event('change')); });
    await page.waitForFunction(async () => (await window.api.getSettings()).bannerChromaKey === true);
    const colors = await page.evaluate(async filePath => {
      const sample = async options => {
        const result = await window.api.probeMedia(filePath, options);
        if (!result.success || !result.thumbnail) throw new Error(result.error || 'Missing thumbnail');
        const img = new Image(); img.src = result.thumbnail; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        return { corner: [...ctx.getImageData(5, 5, 1, 1).data], center: [...ctx.getImageData(180, 180, 1, 1).data] };
      };
      return { plain: await sample({}), keyed: await sample({ chromaKey: true }) };
    }, banner);
    assert.ok(colors.plain.corner[1] > 200 && colors.plain.corner[3] === 255);
    assert.equal(colors.keyed.corner[3], 0);
    assert.ok(colors.keyed.center[0] > 200 && colors.keyed.center[3] === 255);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#banner-chroma-key').checked);
    assert.match(await page.locator('#txt-banner-chroma-key').textContent(), /Автохромакей/);
    assert.deepEqual(errors, []);
    console.log('PASS: Electron saves and reloads chroma key; actual MP4 thumbnails remove green and preserve red.');
  } finally {
    if (electron) await electron.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
