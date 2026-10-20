const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

// A Chromium launcher can hand its profile to another process and exit before
// the browser window closes. Match the profile on the actual browser process.
function createProfileProbe({ run = promisify(execFile), env = process.env } = {}) {
  return async (profilePath, browser) => {
    if (!['msedge', 'chrome'].includes(browser)) throw new Error('studio_browser_invalid');
    const executable = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter "Name='${browser}.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\\s)--type=' } | Select-Object -ExpandProperty CommandLine | ConvertTo-Json -Compress`;
    try {
      const { stdout } = await run(executable, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
      const result = stdout.trim() ? JSON.parse(stdout) : [];
      const commands = Array.isArray(result) ? result : [result];
      if (commands.some(line => typeof line !== 'string')) throw new Error('invalid_process_state');
      return commands.some(line => {
        const match = /(?:"--user-data-dir=([^"]+)"|(?:^|\s)--user-data-dir=(?:"([^"]+)"|([^\s]+)))/.exec(line);
        const directory = match && (match[1] || match[2] || match[3]);
        return directory && path.win32.resolve(directory).toLowerCase() === path.win32.resolve(profilePath).toLowerCase();
      });
    } catch { throw new Error('studio_browser_state_unavailable'); }
  };
}

// Manual sign-in must use the installed browser without an automation connection.
function createLoginLauncher({ start = spawn, access = fs.access, env = process.env } = {}) {
  return async (profilePath, browser) => {
    if (!['msedge', 'chrome'].includes(browser)) throw new Error('studio_browser_invalid');
    const relative = browser === 'chrome'
      ? ['Google', 'Chrome', 'Application', 'chrome.exe']
      : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
    const unavailable = browser === 'chrome' ? 'studio_chrome_unavailable' : 'studio_edge_unavailable';
    let executable;
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      const candidate = path.join(root, ...relative);
      try { await access(candidate); executable = candidate; break; } catch {}
    }
    if (!executable) throw new Error(unavailable);
    return new Promise((resolve, reject) => {
      let running = true;
      let child;
      try {
        child = start(executable, [
          `--user-data-dir=${profilePath}`, '--no-first-run', '--no-default-browser-check',
          '--disable-background-mode', '--new-window', 'https://www.tiktok.com/tiktokstudio/upload'
        ], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
      } catch { reject(new Error(unavailable)); return; }
      child.once('error', () => { running = false; reject(new Error(unavailable)); });
      child.once('exit', () => { running = false; });
      child.once('spawn', () => {
        child.unref();
        resolve({ isRunning: () => running });
      });
    });
  };
}

module.exports = { createLoginLauncher, launchStudioLogin: createLoginLauncher(), createProfileProbe, isBrowserProfileOpen: createProfileProbe() };
