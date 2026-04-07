// ===== STATE =====
let settings = { apiKeys: [], proxy: null };
let stats = { totalVideos: 0, totalRenderTimeMs: 0, lastRun: null };
let sourcePath = null;
let bgFolderPath = null;
let outputFolderPath = null;
let isProcessing = false;
let progressCleanup = null;
let processStartTime = null;
let etaInterval = null;
let progressSamples = [];
let lastProgressPercent = 0;
let lastProgressTime = 0;

async function loadSettings() {
  try {
    settings = await window.api.getSettings() || { apiKeys: [], proxy: null };
    if (!settings.apiKeys) settings.apiKeys = [];
  } catch (err) {
    console.error('Failed to load settings:', err);
    settings = { apiKeys: [], proxy: null };
  }
}

async function saveSettings() {
  try {
    await window.api.saveSettings(settings);
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

// ===== DOM REFS =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ===== TABS =====
$$('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.nav-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    $('#tab-generator').style.display = target === 'generator' ? '' : 'none';
    $('#tab-settings').style.display = target === 'settings' ? '' : 'none';
  });
});

// ===== WINDOW CONTROLS =====
$('#btn-minimize').addEventListener('click', () => window.api.minimizeWindow());
$('#btn-maximize').addEventListener('click', () => window.api.maximizeWindow());
$('#btn-close').addEventListener('click', () => window.api.closeWindow());

// ===== FILE PICKERS =====
$('#pick-source').addEventListener('click', async () => {
  const p = await window.api.openFile([{ name: 'Video Files', extensions: ['mp4','mkv','avi','mov','webm'] }]);
  if (p) { sourcePath = p; $('#source-label').textContent = p; $('#source-label').className = 'path'; }
  updateGenerateBtn();
});

$('#pick-background').addEventListener('click', async () => {
  const p = await window.api.openFolder();
  if (p) { bgFolderPath = p; $('#bg-label').textContent = p; $('#bg-label').className = 'path'; }
  updateGenerateBtn();
});

$('#pick-output').addEventListener('click', async () => {
  const p = await window.api.selectOutputFolder();
  if (p) { outputFolderPath = p; $('#output-label').textContent = p; $('#output-label').className = 'path'; }
  updateGenerateBtn();
});

// ===== SETTINGS: API KEYS =====
$('#key-input').addEventListener('input', () => {
  $('#btn-add-key').disabled = !$('#key-input').value.trim();
});

$('#key-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addKey();
});

$('#btn-add-key').addEventListener('click', addKey);

function addKey() {
  const val = $('#key-input').value.trim();
  if (!val || settings.apiKeys.includes(val)) return;
  settings.apiKeys.push(val);
  saveSettings();
  $('#key-input').value = '';
  $('#btn-add-key').disabled = true;
  renderKeys();
  updateGenerateBtn();
}

function removeKey(index) {
  settings.apiKeys.splice(index, 1);
  saveSettings();
  renderKeys();
  updateGenerateBtn();
}

function renderKeys() {
  const list = $('#key-list');
  list.innerHTML = '';
  settings.apiKeys.forEach((key, i) => {
    const tag = document.createElement('span');
    tag.className = 'key-tag';
    tag.innerHTML = `${key.slice(0,8)}…${key.slice(-4)} <button class="remove" title="Remove key">✕</button>`;
    tag.querySelector('.remove').addEventListener('click', () => removeKey(i));
    list.appendChild(tag);
  });
  $('#keys-hint').style.display = settings.apiKeys.length > 0 ? 'none' : '';
  $('#key-count').textContent = `${settings.apiKeys.length} API key${settings.apiKeys.length !== 1 ? 's' : ''} configured`;
  $('#no-keys-warning').style.display = settings.apiKeys.length === 0 ? '' : 'none';
}

// ===== SETTINGS: PROXY =====
$('#proxy-toggle').addEventListener('change', () => {
  const on = $('#proxy-toggle').checked;
  $('#proxy-fields').style.opacity = on ? '1' : '0.4';
  $('#proxy-fields').style.pointerEvents = on ? 'auto' : 'none';
  updateProxySettings();
});

['proxy-host', 'proxy-port', 'proxy-user', 'proxy-pass'].forEach(id => {
  $(`#${id}`).addEventListener('input', updateProxySettings);
});
$('#proxy-type').addEventListener('change', updateProxySettings);

function updateProxySettings() {
  if ($('#proxy-toggle').checked) {
    settings.proxy = {
      type: $('#proxy-type').value,
      host: $('#proxy-host').value,
      port: $('#proxy-port').value,
      username: $('#proxy-user').value,
      password: $('#proxy-pass').value
    };
  } else {
    settings.proxy = null;
  }
  saveSettings();
}

// ===== GENERATE =====
function updateGenerateBtn() {
  const canStart = sourcePath && bgFolderPath && outputFolderPath && settings.apiKeys.length > 0 && !isProcessing;
  $('#btn-generate').disabled = !canStart;
}

$('#btn-generate').addEventListener('click', startGeneration);
$('#btn-cancel').addEventListener('click', cancelGeneration);

async function startGeneration() {
  isProcessing = true;
  processStartTime = Date.now();
  progressSamples = [];
  lastProgressPercent = 0;
  lastProgressTime = Date.now();
  updateGenerateBtn();
  setStatus('processing', 'Processing…');
  showProgress('Initializing…', 0, 'Starting pipeline');
  $('#btn-generate').style.display = 'none';
  $('#btn-cancel').style.display = '';

  etaInterval = setInterval(updateEta, 1000);

  progressCleanup = window.api.onProgress((data) => {
    showProgress(data.step, data.percent, data.message);
  });

  try {
    const result = await window.api.startProcessing({
      sourceVideo: sourcePath,
      backgroundFolder: bgFolderPath,
      outputFolder: outputFolderPath
    });

    const renderTimeMs = Date.now() - processStartTime;

    if (result.success) {
      const count = result.outputFiles?.length || 0;
      setStatus('done', 'Complete');
      showProgress('Done!', 100, `Created ${count} video(s)`);
      stats.totalVideos += count;
      stats.totalRenderTimeMs += renderTimeMs;
      stats.lastRun = new Date().toLocaleString();
      saveStats();
      renderStats();
    } else {
      setStatus('error', 'Error');
      showProgress('Error', 0, result.error || 'Unknown error');
    }
  } catch (err) {
    setStatus('error', 'Error');
    showProgress('Error', 0, String(err));
  } finally {
    isProcessing = false;
    processStartTime = null;
    progressSamples = [];
    if (etaInterval) { clearInterval(etaInterval); etaInterval = null; }
    if (progressCleanup) progressCleanup();
    $('#btn-generate').style.display = '';
    $('#btn-cancel').style.display = 'none';
    updateGenerateBtn();
  }
}

function cancelGeneration() {
  window.api.cancelProcessing();
  isProcessing = false;
  processStartTime = null;
  progressSamples = [];
  if (etaInterval) { clearInterval(etaInterval); etaInterval = null; }
  if (progressCleanup) progressCleanup();
  setStatus('idle', 'Ready');
  hideProgress();
  $('#btn-generate').style.display = '';
  $('#btn-cancel').style.display = 'none';
  updateGenerateBtn();
}

// ===== UI HELPERS =====
function setStatus(state, text) {
  const dot = $('#status-dot');
  dot.className = `status-dot ${state}`;
  $('#status-text').textContent = text;
}

function showProgress(step, percent, message) {
  $('#progress-container').style.display = '';
  $('#progress-step').textContent = step;
  $('#progress-message').textContent = message;
  $('#progress-fill').style.width = `${percent}%`;
  $('#progress-percent').textContent = `${Math.round(percent)}%`;

  if (percent > 0 && processStartTime) {
    const now = Date.now();
    progressSamples.push({ time: now, percent });
    lastProgressPercent = percent;
    lastProgressTime = now;

    const WINDOW_MS = 15000;
    const cutoff = now - WINDOW_MS;
    while (progressSamples.length > 1 && progressSamples[0].time < cutoff) {
      progressSamples.shift();
    }

    if (progressSamples.length >= 2) {
      const first = progressSamples[0];
      const last = progressSamples[progressSamples.length - 1];
      const dp = last.percent - first.percent;
      const dt = last.time - first.time;
      if (dp > 0.5 && dt > 1000) {
        const speed = dp / dt;
        const remaining = (100 - last.percent) / speed;
        $('#progress-eta').style.display = '';
        $('#progress-eta').textContent = `Осталось: ${formatDuration(remaining)}`;
      }
    }
  }
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '--:--';
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

function updateEta() {
  if (!processStartTime) return;

  const stalledMs = Date.now() - lastProgressTime;
  if (stalledMs > 10000 && lastProgressPercent > 0 && lastProgressPercent < 100) {
    $('#progress-eta').style.display = '';
    $('#progress-eta').textContent = 'Осталось: ожидание ответа…';
    return;
  }

  if (progressSamples.length < 2) return;

  const now = Date.now();
  const WINDOW_MS = 15000;
  const cutoff = now - WINDOW_MS;
  while (progressSamples.length > 1 && progressSamples[0].time < cutoff) {
    progressSamples.shift();
  }

  const first = progressSamples[0];
  const last = progressSamples[progressSamples.length - 1];
  const dp = last.percent - first.percent;
  const dt = last.time - first.time;
  if (dp > 0.5 && dt > 1000) {
    const speed = dp / dt;
    const remaining = (100 - last.percent) / speed;
    $('#progress-eta').textContent = `Осталось: ${formatDuration(remaining)}`;
  }
}

function hideProgress() {
  $('#progress-container').style.display = 'none';
  $('#progress-eta').style.display = 'none';
}

// ===== STATS =====
async function loadStats() {
  try {
    const s = await window.api.getStats();
    if (s) stats = { ...stats, ...s };
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

async function saveStats() {
  try {
    await window.api.saveStats(stats);
  } catch (err) {
    console.error('Failed to save stats:', err);
  }
}

function renderStats() {
  $('#stat-total').textContent = stats.totalVideos;
  const totalMin = Math.round(stats.totalRenderTimeMs / 60000);
  if (totalMin < 60) {
    $('#stat-time').textContent = `${totalMin}m`;
  } else {
    const hr = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    $('#stat-time').textContent = `${hr}h ${min}m`;
  }
  if (stats.totalVideos > 0) {
    const avgSec = Math.round(stats.totalRenderTimeMs / stats.totalVideos / 1000);
    if (avgSec < 60) {
      $('#stat-avg').textContent = `${avgSec}s`;
    } else {
      const min = Math.floor(avgSec / 60);
      const sec = avgSec % 60;
      $('#stat-avg').textContent = `${min}m ${sec}s`;
    }
  } else {
    $('#stat-avg').textContent = '0s';
  }
  $('#stat-last').textContent = stats.lastRun || '—';
}

async function resetStats() {
  stats = { totalVideos: 0, totalRenderTimeMs: 0, lastRun: null };
  await saveStats();
  renderStats();
}

$('#btn-reset-stats').addEventListener('click', resetStats);

// ===== INIT =====
async function init() {
  await loadSettings();
  await loadStats();
  renderKeys();
  renderStats();
  updateGenerateBtn();

  if (settings.proxy) {
    $('#proxy-toggle').checked = true;
    $('#proxy-fields').style.opacity = '1';
    $('#proxy-fields').style.pointerEvents = 'auto';
    $('#proxy-type').value = settings.proxy.type || 'http';
    $('#proxy-host').value = settings.proxy.host || '';
    $('#proxy-port').value = settings.proxy.port || '';
    $('#proxy-user').value = settings.proxy.username || '';
    $('#proxy-pass').value = settings.proxy.password || '';
  }
}

init();

// ===== GLITCH TITLE ANIMATION =====
const glitchTitle = document.querySelector('.titlebar-label');
const prefixText = 'PROGRAM';
const glitchChars = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`';

let glitchInterval = setInterval(() => {
  let glitchedSuffix = '';
  const len = Math.floor(Math.random() * 4) + 5; 
  for (let i = 0; i < len; i++) {
    glitchedSuffix += glitchChars[Math.floor(Math.random() * glitchChars.length)];
  }
  glitchTitle.innerHTML = `<span class="dot"></span> ${prefixText} ${glitchedSuffix}`;
}, 60);

window.addEventListener('beforeunload', () => {
  if (glitchInterval) {
    clearInterval(glitchInterval);
    glitchInterval = null;
  }
});
