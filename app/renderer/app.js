// ===== STATE =====
let settings = { apiProvider: 'openrouter', apiKeys: [], nvidiaApiKeys: [], airforceApiKeys: [], proxy: null };
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
let uiLang = 'en';
let subtitlePreviewInterval = null;
let subtitlePreviewChunks = [];
let subtitlePreviewChunkIndex = 0;

function getSelectedKaraokeEffects() {
  const effects = [];
  if ($('#karaoke-mode-highlight')?.checked) effects.push('highlight');
  if ($('#karaoke-mode-box')?.checked) effects.push('box');
  if ($('#karaoke-mode-caps')?.checked) effects.push('caps');
  return effects;
}

function setSelectedKaraokeEffects(effects) {
  const set = new Set(Array.isArray(effects) ? effects : []);
  if (set.has('underline')) set.add('box');
  if ($('#karaoke-mode-highlight')) $('#karaoke-mode-highlight').checked = set.has('highlight');
  if ($('#karaoke-mode-box')) $('#karaoke-mode-box').checked = set.has('box');
  if ($('#karaoke-mode-caps')) $('#karaoke-mode-caps').checked = set.has('caps');
}

function legacyModeFromEffects(effects) {
  const set = new Set(Array.isArray(effects) ? effects : []);
  if (set.has('highlight') && set.has('box')) return 'both';
  if (set.has('box')) return 'underline';
  if (set.has('caps')) return 'caps';
  return 'highlight';
}

const I18N = {
  en: {
    tabs: { generator: '⚡ Generator', settings: '⚙ Settings' },
    status: { ready: 'Ready', processing: 'Processing…', done: 'Complete', error: 'Error', idle: 'Ready' },
    buttons: { generate: '⚡ Generate Videos ⚡', cancel: 'Cancel', add: 'Add', resetStats: 'Reset Statistics' },
    warnings: { noKeys: 'Add at least one OpenRouter API key in Settings before generating.', noKeysNvidia: 'Add at least one NVIDIA NIM API key in Settings before generating.', noKeysAirforce: 'Add at least one api.airforce API key in Settings before generating.' },
    labels: {
      sourceTitle: 'Source Video (with stories)',
      bgTitle: 'Background Videos Folder',
      outputTitle: 'Output Folder',
      sourcePlaceholder: 'Click to select the source video file…',
      bgPlaceholder: 'Click to select the ADHD background videos folder…',
      outputPlaceholder: 'Click to select where to save generated videos…',
      appLangTitle: 'App Language',
      interfaceLangLabel: 'Interface Language',
      apiProviderTitle: 'API Provider',
      providerOpenRouter: 'OpenRouter',
      providerNvidia: 'NVIDIA NIM',
      providerAirforce: 'api.airforce',
      apiKeysTitle: 'OpenRouter API Keys',
      nvidiaKeysTitle: 'NVIDIA NIM API Keys',
      airforceKeysTitle: 'api.airforce API Keys',
      keysHint: 'Add at least one OpenRouter API key to use the generator. Keys rotate automatically on rate-limit errors.',
      nvidiaKeysHint: 'Add at least one NVIDIA NIM API key to use the generator. Keys rotate automatically on rate-limit errors.',
      airforceKeysHint: 'Add at least one api.airforce API key to use the generator. Keys rotate automatically on rate-limit errors.',
      nvidiaPlaceholder: 'nvapi-… paste NVIDIA NIM key here',
      airforcePlaceholder: 'paste api.airforce key here',
      proxyTitle: 'Proxy Configuration',
      enable: 'Enable',
      proxyType: 'Type',
      proxyHost: 'Host',
      proxyPort: 'Port',
      proxyUser: 'Username (optional)',
      proxyPass: 'Password (optional)',
      subtitlesTitle: 'Subtitles (Whisper AI)',
      subStyle: 'Style Preset',
      subModel: 'Model Quality',
      subLanguage: 'Language',
      subCase: 'Case',
      subPosition: 'Position',
      subWords: 'Words Per Subtitle',
      subMaxMs: 'Max Line Duration (ms)',
      subFont: 'Font Size',
      subFontFamily: 'Font Family',
      subMargin: 'Vertical Margin',
      subOffset: 'Subtitle Offset',
      subOffsetHint: 'Positive values make subtitles appear earlier (fixes lag), negative values make them appear later.',
      subKaraoke: 'Karaoke Mode',
      subKaraokeWord: 'Word highlight',
      subKaraokeMode: 'Karaoke Effect',
      subHint: 'Transcription uses Groq Whisper API. Add your Groq API key above.',
      groqKeyTitle: 'Groq API Key',
      groqKeyHint: 'Required for subtitle transcription via Groq Whisper API.',
      statsTitle: 'Statistics',
      statTotal: 'Total Videos',
      statTime: 'Total Render Time',
      statAvg: 'Avg Per Video',
      statLast: 'Last Run',
      eta: {
        remaining: 'Remaining',
        waiting: 'Waiting for response…'
      }
    }
  },
  ru: {
    tabs: { generator: '⚡ Генератор', settings: '⚙ Настройки' },
    status: { ready: 'Готово', processing: 'Обработка…', done: 'Завершено', error: 'Ошибка', idle: 'Готово' },
    buttons: { generate: '⚡ Создать видео ⚡', cancel: 'Отмена', add: 'Добавить', resetStats: 'Сбросить статистику' },
    warnings: { noKeys: 'Добавь хотя бы один OpenRouter API ключ во вкладке настроек перед запуском.', noKeysNvidia: 'Добавь хотя бы один NVIDIA NIM API ключ во вкладке настроек перед запуском.', noKeysAirforce: 'Добавь хотя бы один api.airforce API ключ во вкладке настроек перед запуском.' },
    labels: {
      sourceTitle: 'Исходное видео (с историями)',
      bgTitle: 'Папка с фоновыми видео',
      outputTitle: 'Папка для вывода',
      sourcePlaceholder: 'Нажми, чтобы выбрать исходный видеофайл…',
      bgPlaceholder: 'Нажми, чтобы выбрать папку с ADHD-фонами…',
      outputPlaceholder: 'Нажми, чтобы выбрать папку сохранения…',
      appLangTitle: 'Язык приложения',
      interfaceLangLabel: 'Язык интерфейса',
      apiProviderTitle: 'Провайдер API',
      providerOpenRouter: 'OpenRouter',
      providerNvidia: 'NVIDIA NIM',
      providerAirforce: 'api.airforce',
      apiKeysTitle: 'OpenRouter API ключи',
      nvidiaKeysTitle: 'NVIDIA NIM API ключи',
      airforceKeysTitle: 'api.airforce API ключи',
      keysHint: 'Добавь хотя бы один OpenRouter API ключ для работы генератора. При лимитах ключи переключаются автоматически.',
      nvidiaKeysHint: 'Добавь хотя бы один NVIDIA NIM API ключ для работы генератора. При лимитах ключи переключаются автоматически.',
      airforceKeysHint: 'Добавь хотя бы один api.airforce API ключ для работы генератора. При лимитах ключи переключаются автоматически.',
      nvidiaPlaceholder: 'nvapi-… вставь NVIDIA NIM ключ сюда',
      airforcePlaceholder: 'вставь api.airforce ключ сюда',
      proxyTitle: 'Настройки прокси',
      enable: 'Включить',
      proxyType: 'Тип',
      proxyHost: 'Хост',
      proxyPort: 'Порт',
      proxyUser: 'Логин (необязательно)',
      proxyPass: 'Пароль (необязательно)',
      subtitlesTitle: 'Субтитры (Whisper AI)',
      subStyle: 'Стиль',
      subModel: 'Качество модели',
      subLanguage: 'Язык',
      subCase: 'Регистр',
      subPosition: 'Позиция',
      subWords: 'Слов за субтитр',
      subMaxMs: 'Макс. длительность строки (мс)',
      subFont: 'Размер шрифта',
      subFontFamily: 'Шрифт',
      subMargin: 'Вертикальный отступ',
      subOffset: 'Смещение субтитров',
      subOffsetHint: 'Положительные значения сдвигают субтитры назад (раньше), отрицательные — вперед (позже).',
      subKaraoke: 'Караоке режим',
      subKaraokeWord: 'Подсветка слов',
      subKaraokeMode: 'Эффект караоке',
      subHint: 'Транскрипция через Groq Whisper API. Добавь Groq API ключ выше.',
      groqKeyTitle: 'Groq API ключ',
      groqKeyHint: 'Нужен для транскрипции субтитров через Groq Whisper API.',
      statsTitle: 'Статистика',
      statTotal: 'Всего видео',
      statTime: 'Общее время рендера',
      statAvg: 'Среднее на видео',
      statLast: 'Последний запуск',
      eta: {
        remaining: 'Осталось',
        waiting: 'Осталось: ожидание ответа…'
      }
    }
  }
};

function t(path) {
  const langPack = I18N[uiLang] || I18N.en;
  return path.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : null), langPack) ?? path;
}

function applyTranslations() {
  const tabs = $$('.nav-tab');
  if (tabs[0]) tabs[0].textContent = t('tabs.generator');
  if (tabs[1]) tabs[1].textContent = t('tabs.settings');
  const st = $('#status-text');
  if (st && (!st.textContent || st.textContent === 'Ready' || st.textContent === 'Готово')) st.textContent = t('status.ready');
  $('#btn-generate').textContent = t('buttons.generate');
  $('#btn-cancel').textContent = t('buttons.cancel');
  $('#btn-add-key').textContent = t('buttons.add');
  $('#btn-reset-stats').textContent = t('buttons.resetStats');
  $('#no-keys-warning').textContent = t('warnings.noKeys');
  const sTitle = $('#txt-source-title'); if (sTitle) sTitle.textContent = t('labels.sourceTitle');
  const bTitle = $('#txt-bg-title'); if (bTitle) bTitle.textContent = t('labels.bgTitle');
  const oTitle = $('#txt-output-title'); if (oTitle) oTitle.textContent = t('labels.outputTitle');
  const alTitle = $('#txt-app-lang-title'); if (alTitle) alTitle.textContent = t('labels.appLangTitle');
  const alLabel = $('#txt-interface-lang-label'); if (alLabel) alLabel.textContent = t('labels.interfaceLangLabel');
  const apt = $('#txt-api-provider-title'); if (apt) apt.textContent = t('labels.apiProviderTitle');
  const ap = $('#api-provider');
  if (ap) {
    if (ap.options[0]) ap.options[0].text = t('labels.providerOpenRouter');
    if (ap.options[1]) ap.options[1].text = t('labels.providerNvidia');
    if (ap.options[2]) ap.options[2].text = t('labels.providerAirforce');
  }
  const g = $('#txt-api-keys-title'); if (g) g.textContent = t('labels.apiKeysTitle');
  const nkt = $('#txt-nvidia-keys-title'); if (nkt) nkt.textContent = t('labels.nvidiaKeysTitle');
  const akt = $('#txt-airforce-keys-title'); if (akt) akt.textContent = t('labels.airforceKeysTitle');
  const kh = $('#keys-hint'); if (kh) kh.textContent = t('labels.keysHint');
  const nkh = $('#nvidia-keys-hint'); if (nkh) nkh.textContent = t('labels.nvidiaKeysHint');
  const akh = $('#airforce-keys-hint'); if (akh) akh.textContent = t('labels.airforceKeysHint');
  const aki = $('#airforce-key-input'); if (aki) aki.placeholder = t('labels.airforcePlaceholder');
  const nkw = $('#no-keys-warning');
  if (nkw) {
    nkw.textContent = settings.apiProvider === 'nvidia'
      ? t('warnings.noKeysNvidia')
      : settings.apiProvider === 'airforce'
        ? t('warnings.noKeysAirforce')
        : t('warnings.noKeys');
  }
  const pt = $('#txt-proxy-title'); if (pt) pt.textContent = t('labels.proxyTitle');
  const ep = $('#txt-enable-proxy'); if (ep) ep.textContent = t('labels.enable');
  const es = $('#txt-enable-subtitles'); if (es) es.textContent = t('labels.enable');
  const pty = $('#txt-proxy-type'); if (pty) pty.textContent = t('labels.proxyType');
  const ph = $('#txt-proxy-host'); if (ph) ph.textContent = t('labels.proxyHost');
  const pp = $('#txt-proxy-port'); if (pp) pp.textContent = t('labels.proxyPort');
  const pu = $('#txt-proxy-user'); if (pu) pu.textContent = t('labels.proxyUser');
  const ppa = $('#txt-proxy-pass'); if (ppa) ppa.textContent = t('labels.proxyPass');
  const stt = $('#txt-subtitles-title'); if (stt) stt.textContent = t('labels.subtitlesTitle');
  const ss = $('#txt-sub-style'); if (ss) ss.textContent = t('labels.subStyle');
  const sm = $('#txt-sub-model'); if (sm) sm.textContent = t('labels.subModel');
  const sl = $('#txt-sub-language'); if (sl) sl.textContent = t('labels.subLanguage');
  const sc = $('#txt-sub-case'); if (sc) sc.textContent = t('labels.subCase');
  const sp = $('#txt-sub-position'); if (sp) sp.textContent = t('labels.subPosition');
  const sw = $('#txt-sub-words'); if (sw) sw.textContent = t('labels.subWords');
  const smax = $('#txt-sub-maxms'); if (smax) smax.textContent = t('labels.subMaxMs');
  const sf = $('#txt-sub-font'); if (sf) sf.textContent = t('labels.subFont');
  const sff = $('#txt-sub-font-family'); if (sff) sff.textContent = t('labels.subFontFamily');
  const svm = $('#txt-sub-margin'); if (svm) svm.textContent = t('labels.subMargin');
  const sof = $('#txt-sub-offset'); if (sof) sof.textContent = t('labels.subOffset');
  const sofh = $('#txt-sub-offset-hint'); if (sofh) sofh.textContent = t('labels.subOffsetHint');
  const sk = $('#txt-sub-karaoke'); if (sk) sk.textContent = t('labels.subKaraoke');
  const skw = $('#txt-sub-karaoke-word'); if (skw) skw.textContent = t('labels.subKaraokeWord');
  const skm = $('#txt-sub-karaoke-mode'); if (skm) skm.textContent = t('labels.subKaraokeMode');
  const sh = $('#txt-sub-hint'); if (sh) sh.textContent = t('labels.subHint');
  const gkt = $('#txt-groq-key'); if (gkt) gkt.textContent = t('labels.groqKeyTitle');
  const gkh = $('#groq-key-hint'); if (gkh) gkh.textContent = t('labels.groqKeyHint');
  const sTitle2 = $('#txt-stats-title'); if (sTitle2) sTitle2.textContent = t('labels.statsTitle');
  const st1 = $('#txt-stat-total'); if (st1) st1.textContent = t('labels.statTotal');
  const st2 = $('#txt-stat-time'); if (st2) st2.textContent = t('labels.statTime');
  const st3 = $('#txt-stat-avg'); if (st3) st3.textContent = t('labels.statAvg');
  const st4 = $('#txt-stat-last'); if (st4) st4.textContent = t('labels.statLast');

  if (!sourcePath) $('#source-label').textContent = t('labels.sourcePlaceholder');
  if (!bgFolderPath) $('#bg-label').textContent = t('labels.bgPlaceholder');
  if (!outputFolderPath) $('#output-label').textContent = t('labels.outputPlaceholder');
  updateSubtitlePreview();
}

async function loadSettings() {
  try {
    settings = await window.api.getSettings() || { apiKeys: [], proxy: null };
    settings = {
      apiProvider: 'openrouter',
      apiKeys: [],
      nvidiaApiKeys: [],
      airforceApiKeys: [],
      proxy: null,
      subtitlesEnabled: false,
      subtitleStyle: 'Classic',
      subtitleModel: 'whisper-large-v3',
      subtitleLanguage: 'ru',
      subtitlePosition: 'bottom',
      subtitleWordsPerLine: 3,
      subtitleMaxLineMs: 1200,
      subtitleFontSize: 20,
      subtitleFontFamily: 'Inter',
      subtitleMarginV: 40,
      subtitleOffsetMs: 0,
      subtitleKaraoke: false,
      subtitleKaraokeMode: 'highlight',
      subtitleKaraokeEffects: ['highlight'],
      groqApiKey: '',
      appLanguage: 'en',
      ...settings
    };
    if (!settings.apiKeys) settings.apiKeys = [];
    if (!settings.nvidiaApiKeys) settings.nvidiaApiKeys = [];
    if (!settings.airforceApiKeys) settings.airforceApiKeys = [];
    if (!settings.groqApiKey) settings.groqApiKey = '';
    // Legacy cleanup: remove old Gemini keys (starting with AIzaSy)
    settings.apiKeys = settings.apiKeys.filter(k => !k.startsWith('AIzaSy'));
    settings.nvidiaApiKeys = settings.nvidiaApiKeys.filter(k => !k.startsWith('AIzaSy'));
  } catch (err) {
    console.error('Failed to load settings:', err);
    settings = {
      apiProvider: 'openrouter',
      apiKeys: [],
      nvidiaApiKeys: [],
      airforceApiKeys: [],
      proxy: null,
      subtitlesEnabled: false,
      subtitleStyle: 'Classic',
      subtitleModel: 'whisper-large-v3',
      subtitleLanguage: 'ru',
      subtitlePosition: 'bottom',
      subtitleWordsPerLine: 3,
      subtitleMaxLineMs: 1200,
      subtitleFontSize: 20,
      subtitleFontFamily: 'Inter',
      subtitleMarginV: 40,
      subtitleOffsetMs: 0,
      subtitleKaraoke: false,
      subtitleKaraokeMode: 'highlight',
      subtitleKaraokeEffects: ['highlight']
      ,groqApiKey: ''
      ,appLanguage: 'en'
    };
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

function currentProviderKeys() {
  if (settings.apiProvider === 'nvidia') return settings.nvidiaApiKeys;
  if (settings.apiProvider === 'airforce') return settings.airforceApiKeys;
  return settings.apiKeys;
}

function updateNoKeysWarning() {
  const keysEmpty = currentProviderKeys().length === 0;
  $('#no-keys-warning').style.display = keysEmpty ? '' : 'none';
}

function renderKeys() {
  const list = $('#key-list');
  list.innerHTML = '';
  settings.apiKeys.forEach((key, i) => {
    const tag = document.createElement('span');
    tag.className = 'key-tag';
    tag.textContent = `${key.slice(0,8)}…${key.slice(-4)} `;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove';
    removeBtn.title = 'Remove key';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeKey(i));
    tag.appendChild(removeBtn);
    list.appendChild(tag);
  });
  $('#keys-hint').style.display = settings.apiKeys.length > 0 ? 'none' : '';
  updateKeyCount();
  updateNoKeysWarning();
}

// ===== SETTINGS: NVIDIA API KEYS =====
$('#nvidia-key-input').addEventListener('input', () => {
  $('#btn-add-nvidia-key').disabled = !$('#nvidia-key-input').value.trim();
});

$('#nvidia-key-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addNvidiaKey();
});

$('#btn-add-nvidia-key').addEventListener('click', addNvidiaKey);

function addNvidiaKey() {
  const val = $('#nvidia-key-input').value.trim();
  if (!val || settings.nvidiaApiKeys.includes(val)) return;
  settings.nvidiaApiKeys.push(val);
  saveSettings();
  $('#nvidia-key-input').value = '';
  $('#btn-add-nvidia-key').disabled = true;
  renderNvidiaKeys();
  updateGenerateBtn();
}

function removeNvidiaKey(index) {
  settings.nvidiaApiKeys.splice(index, 1);
  saveSettings();
  renderNvidiaKeys();
  updateGenerateBtn();
}

function renderNvidiaKeys() {
  const list = $('#nvidia-key-list');
  list.innerHTML = '';
  settings.nvidiaApiKeys.forEach((key, i) => {
    const tag = document.createElement('span');
    tag.className = 'key-tag';
    tag.textContent = `${key.slice(0,8)}…${key.slice(-4)} `;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove';
    removeBtn.title = 'Remove key';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeNvidiaKey(i));
    tag.appendChild(removeBtn);
    list.appendChild(tag);
  });
  $('#nvidia-keys-hint').style.display = settings.nvidiaApiKeys.length > 0 ? 'none' : '';
  updateKeyCount();
  updateNoKeysWarning();
}

// ===== SETTINGS: API.AIRFORCE API KEYS =====
$('#airforce-key-input').addEventListener('input', () => {
  $('#btn-add-airforce-key').disabled = !$('#airforce-key-input').value.trim();
});

$('#airforce-key-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addAirforceKey();
});

$('#btn-add-airforce-key').addEventListener('click', addAirforceKey);

function addAirforceKey() {
  const val = $('#airforce-key-input').value.trim();
  if (!val || settings.airforceApiKeys.includes(val)) return;
  settings.airforceApiKeys.push(val);
  saveSettings();
  $('#airforce-key-input').value = '';
  $('#btn-add-airforce-key').disabled = true;
  renderAirforceKeys();
  updateGenerateBtn();
}

function removeAirforceKey(index) {
  settings.airforceApiKeys.splice(index, 1);
  saveSettings();
  renderAirforceKeys();
  updateGenerateBtn();
}

function renderAirforceKeys() {
  const list = $('#airforce-key-list');
  list.innerHTML = '';
  settings.airforceApiKeys.forEach((key, i) => {
    const tag = document.createElement('span');
    tag.className = 'key-tag';
    tag.textContent = `${key.slice(0,8)}…${key.slice(-4)} `;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove';
    removeBtn.title = 'Remove key';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeAirforceKey(i));
    tag.appendChild(removeBtn);
    list.appendChild(tag);
  });
  $('#airforce-keys-hint').style.display = settings.airforceApiKeys.length > 0 ? 'none' : '';
  updateKeyCount();
  updateNoKeysWarning();
}

// ===== SETTINGS: GROQ API KEY =====
$('#groq-key-input').addEventListener('input', () => {
  $('#btn-add-groq-key').disabled = !$('#groq-key-input').value.trim();
});

$('#groq-key-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addGroqKey();
});

$('#btn-add-groq-key').addEventListener('click', addGroqKey);

function addGroqKey() {
  const val = $('#groq-key-input').value.trim();
  if (!val) return;
  settings.groqApiKey = val;
  saveSettings();
  $('#groq-key-input').value = '';
  $('#btn-add-groq-key').disabled = true;
  renderGroqKey();
}

function removeGroqKey() {
  settings.groqApiKey = '';
  saveSettings();
  renderGroqKey();
}

function renderGroqKey() {
  const list = $('#groq-key-list');
  const hint = $('#groq-key-hint');
  const input = $('#groq-key-input');
  list.innerHTML = '';

  if (settings.groqApiKey) {
    const key = settings.groqApiKey;
    const tag = document.createElement('span');
    tag.className = 'key-tag';
    tag.textContent = `${key.slice(0, 6)}…${key.slice(-4)} `;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove';
    removeBtn.title = 'Remove key';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', removeGroqKey);
    tag.appendChild(removeBtn);
    list.appendChild(tag);
    hint.style.display = 'none';
    input.placeholder = 'gsk_… replace Groq API key';
  } else {
    hint.style.display = '';
    hint.textContent = t('labels.groqKeyHint');
    input.placeholder = 'gsk_… paste Groq API key here';
  }
}

// ===== API PROVIDER SWITCH =====
$('#api-provider').addEventListener('change', () => {
  settings.apiProvider = $('#api-provider').value;
  updateProviderUI();
  saveSettings();
  applyTranslations();
});

function updateProviderUI() {
  const provider = settings.apiProvider;
  $('#keys-section-openrouter').style.display = provider === 'openrouter' ? '' : 'none';
  $('#keys-section-nvidia').style.display = provider === 'nvidia' ? '' : 'none';
  $('#keys-section-airforce').style.display = provider === 'airforce' ? '' : 'none';
  updateNoKeysWarning();
  updateKeyCount();
  updateGenerateBtn();
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

const SUBTITLE_STYLE_FONT_SIZES = {
  Classic: 20,
  Minimal: 18,
  Highlight: 22,
  TikTokBold: 24,
  HeavyShadow: 24,
  SoftBox: 20
};

function syncSubtitleStyleFontSize() {
  // Apply preset default font size ONLY if the user hasn't customized it yet
  // (current value matches some other preset's default). This avoids silently
  // overriding a manually chosen font size.
  const style = $('#subtitle-style')?.value || 'Classic';
  const presetSize = SUBTITLE_STYLE_FONT_SIZES[style];
  if (!presetSize) return;
  const currentSize = Number($('#subtitle-font-size')?.value || 0);
  const presetValues = new Set(Object.values(SUBTITLE_STYLE_FONT_SIZES));
  const looksLikePresetDefault = presetValues.has(currentSize);
  if (looksLikePresetDefault && currentSize !== presetSize) {
    $('#subtitle-font-size').value = String(presetSize);
    settings.subtitleFontSize = presetSize;
  }
}

// ===== SETTINGS: SUBTITLES =====
function setSubtitleFieldsExpanded(on) {
  const fields = $('#subtitle-fields');
  if (!fields) return;
  fields.style.display = '';
  fields.style.opacity = on ? '1' : '0.4';
  fields.style.pointerEvents = on ? 'auto' : 'none';
}

$('#subtitles-toggle').addEventListener('change', () => {
  const on = $('#subtitles-toggle').checked;
  setSubtitleFieldsExpanded(on);
  settings.subtitlesEnabled = on;
  settings.subtitleStyle = $('#subtitle-style').value;
  settings.subtitleModel = $('#subtitle-model').value;
  settings.subtitleLanguage = $('#subtitle-language').value;
  settings.subtitlePosition = $('#subtitle-position').value;
  settings.subtitleWordsPerLine = Number($('#subtitle-words-per-line').value || 3);
  settings.subtitleMaxLineMs = Number($('#subtitle-max-line-ms').value || 1200);
  settings.subtitleFontSize = Number($('#subtitle-font-size').value || 20);
  settings.subtitleFontFamily = $('#subtitle-font-family').value || 'Inter';
  settings.subtitleMarginV = Number($('#subtitle-margin-v').value || 40);
  settings.subtitleOffsetMs = Number($('#subtitle-offset').value || 0);
  settings.subtitleKaraoke = !!$('#subtitle-karaoke').checked;
  settings.subtitleKaraokeEffects = getSelectedKaraokeEffects();
  settings.subtitleKaraokeMode = legacyModeFromEffects(settings.subtitleKaraokeEffects);
  // New: store case setting for karaoke
  settings.subtitleCase = $('#subtitle-case').value || 'sentence';
  saveSettings();
  updateSubtitlePreview();
});

['subtitle-style', 'subtitle-model', 'subtitle-language', 'subtitle-font-family', 'subtitle-case'].forEach(id => {
  $(`#${id}`).addEventListener('change', () => {
    settings.subtitleStyle = $('#subtitle-style').value;
    settings.subtitleModel = $('#subtitle-model').value;
    settings.subtitleLanguage = $('#subtitle-language').value;
    settings.subtitleFontFamily = $('#subtitle-font-family').value || 'Inter';
    settings.subtitleKaraokeEffects = getSelectedKaraokeEffects();
    settings.subtitleKaraokeMode = legacyModeFromEffects(settings.subtitleKaraokeEffects);
    settings.subtitleCase = $('#subtitle-case').value || 'sentence';
    if (id === 'subtitle-style') {
      syncSubtitleStyleFontSize();
    }
    saveSettings();
    updateSubtitlePreview();
  });
});
['subtitle-position', 'subtitle-words-per-line', 'subtitle-max-line-ms', 'subtitle-font-size', 'subtitle-margin-v'].forEach(id => {
  $(`#${id}`).addEventListener('input', () => {
    settings.subtitlePosition = $('#subtitle-position').value;
    settings.subtitleWordsPerLine = Number($('#subtitle-words-per-line').value || 3);
    settings.subtitleMaxLineMs = Number($('#subtitle-max-line-ms').value || 1200);
    settings.subtitleFontSize = Number($('#subtitle-font-size').value || 20);
    settings.subtitleMarginV = Number($('#subtitle-margin-v').value || 40);
    saveSettings();
    updateSubtitlePreview();
  });
});
$('#subtitle-offset').addEventListener('input', () => {
  const val = $('#subtitle-offset').value;
  $('#subtitle-offset-value').textContent = val > 0 ? `+${val} ms` : `${val} ms`;
  settings.subtitleOffsetMs = Number(val);
  saveSettings();
});
$('#subtitle-karaoke').addEventListener('change', () => {
  settings.subtitleKaraoke = !!$('#subtitle-karaoke').checked;
  settings.subtitleKaraokeEffects = getSelectedKaraokeEffects();
  settings.subtitleKaraokeMode = legacyModeFromEffects(settings.subtitleKaraokeEffects);
  saveSettings();
  updateSubtitlePreview();
});
['karaoke-mode-highlight', 'karaoke-mode-box', 'karaoke-mode-caps'].forEach(id => {
  $(`#${id}`)?.addEventListener('change', () => {
    settings.subtitleKaraokeEffects = getSelectedKaraokeEffects();
    settings.subtitleKaraokeMode = legacyModeFromEffects(settings.subtitleKaraokeEffects);
    saveSettings();
    updateSubtitlePreview();
  });
});
$('#app-language').addEventListener('change', () => {
  settings.appLanguage = $('#app-language').value;
  uiLang = settings.appLanguage || 'en';
  applyTranslations();
  saveSettings();
});


function updateKeyCount() {
  const count = currentProviderKeys().length;
  $('#key-count').textContent = `${count} API key${count !== 1 ? 's' : ''} configured`;
}

function updateGenerateBtn() {
  const keysOk = currentProviderKeys().length > 0;
  const canStart = sourcePath && bgFolderPath && outputFolderPath && keysOk && !isProcessing;
  $('#btn-generate').disabled = !canStart;
}

$('#btn-generate').addEventListener('click', startGeneration);
$('#btn-cancel').addEventListener('click', cancelGeneration);

async function startGeneration() {
  isProcessing = true;
  setControlsDisabled(true);
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
      outputFolder: outputFolderPath,
      subtitlesEnabled: !!settings.subtitlesEnabled,
      subtitleStyle: settings.subtitleStyle || 'Classic',
      subtitleModel: settings.subtitleModel || 'whisper-large-v3',
      subtitleLanguage: settings.subtitleLanguage || 'ru',
      subtitlePosition: settings.subtitlePosition || 'bottom',
      subtitleWordsPerLine: Number(settings.subtitleWordsPerLine || 3),
      subtitleMaxLineMs: Number(settings.subtitleMaxLineMs || 1200),
      subtitleFontSize: Number(settings.subtitleFontSize || 20),
      subtitleFontFamily: settings.subtitleFontFamily || 'Inter',
      subtitleMarginV: Number(settings.subtitleMarginV || 40),
      subtitleOffsetMs: Number(settings.subtitleOffsetMs || 0),
      subtitleKaraoke: !!settings.subtitleKaraoke,
      subtitleKaraokeMode: settings.subtitleKaraokeMode || 'highlight',
      subtitleKaraokeEffects: Array.isArray(settings.subtitleKaraokeEffects) ? settings.subtitleKaraokeEffects : ['highlight'],
      subtitleCase: settings.subtitleCase || 'sentence'
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
    setControlsDisabled(false);
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
  setControlsDisabled(false);
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
function setControlsDisabled(disabled) {
  const selectors = [
    '#pick-source', '#pick-background', '#pick-output',
    '#api-provider',
    '#key-input', '#btn-add-key',
    '#nvidia-key-input', '#btn-add-nvidia-key',
    '#airforce-key-input', '#btn-add-airforce-key',
    '#proxy-toggle',
    '#proxy-type', '#proxy-host', '#proxy-port', '#proxy-user', '#proxy-pass',
    '#subtitles-toggle', '#subtitle-style', '#subtitle-model', '#subtitle-language',
    '#subtitle-position', '#subtitle-words-per-line', '#subtitle-max-line-ms', '#subtitle-font-size', '#subtitle-font-family', '#subtitle-margin-v', '#subtitle-karaoke',
    '#karaoke-mode-highlight', '#karaoke-mode-box', '#karaoke-mode-caps',
    '#btn-reset-stats'
  ];

  selectors.forEach(sel => {
    const el = $(sel);
    if (!el) return;
    
    if (['INPUT', 'SELECT', 'BUTTON'].includes(el.tagName)) {
      el.disabled = disabled;
    } else {
      // For div pickers (source, background, output)
      el.style.pointerEvents = disabled ? 'none' : 'auto';
      el.style.opacity = disabled ? '0.5' : '1';
    }
  });

  // Also disable remove buttons for keys
  $$('.key-tag .remove').forEach(btn => {
    btn.disabled = disabled;
    btn.style.pointerEvents = disabled ? 'none' : 'auto';
    btn.style.opacity = disabled ? '0.5' : '1';
  });
}

function setStatus(state, text) {
  const dot = $('#status-dot');
  dot.className = `status-dot ${state}`;
  const mapped = {
    Ready: t('status.ready'),
    'Processing…': t('status.processing'),
    Complete: t('status.done'),
    Error: t('status.error')
  };
  $('#status-text').textContent = mapped[text] || text;
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
        $('#progress-eta').textContent = `${t('labels.eta.remaining')}: ${formatDuration(remaining)}`;
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
    $('#progress-eta').textContent = t('labels.eta.waiting');
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
    $('#progress-eta').textContent = `${t('labels.eta.remaining')}: ${formatDuration(remaining)}`;
  }
}

function hideProgress() {
  $('#progress-container').style.display = 'none';
  $('#progress-eta').style.display = 'none';
}

function buildPreviewChunks(phrase, wordsPerLine) {
  const words = String(phrase || '').trim().split(/\s+/).filter(Boolean);
  const size = Math.max(1, Number(wordsPerLine || 3));
  const chunks = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(words.slice(i, i + size).join(' '));
  }
  return chunks.length ? chunks : [phrase];
}

function renderPreviewChunk(textEl, phrase, karaoke, karaokeEffects = ['highlight'], caseName = 'sentence') {
  const current = subtitlePreviewChunks[subtitlePreviewChunkIndex % subtitlePreviewChunks.length] || phrase;
  const effects = new Set(Array.isArray(karaokeEffects) ? karaokeEffects : []);
  const applyCase = (value) => {
    const v = String(value || '');
    if (caseName === 'uppercase') return v.toUpperCase();
    if (caseName === 'lowercase') return v.toLowerCase();
    if (!v) return v;
    return v.charAt(0).toUpperCase() + v.slice(1);
  };
  if (karaoke) {
    const words = applyCase(current).split(' ');
    const highlightIndex = words.length > 1 ? Math.floor(words.length / 2) : 0;
    const escaped = words.map((w, i) => {
      if (i !== highlightIndex) return w;
      const classes = ['subtitle-preview-word'];
      if (effects.has('highlight')) classes.push('mode-highlight');
      if (effects.has('box')) classes.push('mode-box');
      const value = (effects.has('caps') && caseName !== 'uppercase') ? w.toUpperCase() : w;
      return `<span class="${classes.join(' ')}">${value}</span>`;
    });
    textEl.innerHTML = escaped.join(' ');
  } else {
    textEl.textContent = applyCase(current);
  }
}

function updateSubtitlePreview() {
  const stage = $('#subtitle-preview-stage');
  const frame = $('#subtitle-preview-frame');
  const overlay = $('#subtitle-preview-overlay');
  const text = $('#subtitle-preview-text');
  if (!stage || !overlay || !text) return;

  const enabled = !!$('#subtitles-toggle')?.checked;
  // Real ASS values (PlayRes 1080x1920). Preview uses these directly inside
  // a 1080x1920 frame that is scaled down via CSS transform — so visual
  // proportions match the exported video exactly.
  const realFontSize = Math.max(12, Number($('#subtitle-font-size')?.value || 20));
  const marginV = Math.max(10, Number($('#subtitle-margin-v')?.value || 40));
  const marginH = 40; // matches ASS_STYLES.*.marginH default
  const wordsPerLine = Math.max(1, Number($('#subtitle-words-per-line')?.value || 3));
  const lineMs = Math.max(300, Number($('#subtitle-max-line-ms')?.value || 1200));
  const fontFamily = $('#subtitle-font-family')?.value || 'Inter';
  const karaoke = !!$('#subtitle-karaoke')?.checked;
  const karaokeEffects = getSelectedKaraokeEffects();
  const caseName = $('#subtitle-case')?.value || 'sentence';
  const stylePreset = $('#subtitle-style')?.value || 'Classic';
  const position = $('#subtitle-position')?.value || 'bottom';
  const phrase = uiLang === 'ru'
    ? 'Это пример предпросмотра отображения субтитров в вашем стиле'
    : 'This is a live subtitle preview phrase in your design style';

  // Apply ASS-equivalent values directly (px == ASS unit thanks to scaled frame).
  overlay.style.fontFamily = `'${fontFamily}', sans-serif`;
  overlay.style.fontSize = `${realFontSize}px`;
  overlay.style.opacity = enabled ? '1' : '0.45';
  overlay.style.left = `${marginH}px`;
  overlay.style.right = `${marginH}px`;
  overlay.classList.remove(
    'preview-style-classic',
    'preview-style-minimal',
    'preview-style-highlight',
    'preview-style-tiktokbold',
    'preview-style-heavyshadow',
    'preview-style-softbox'
  );
  if (stylePreset === 'Minimal') {
    overlay.classList.add('preview-style-minimal');
  } else if (stylePreset === 'Highlight') {
    overlay.classList.add('preview-style-highlight');
  } else if (stylePreset === 'TikTokBold') {
    overlay.classList.add('preview-style-tiktokbold');
  } else if (stylePreset === 'HeavyShadow') {
    overlay.classList.add('preview-style-heavyshadow');
  } else if (stylePreset === 'SoftBox') {
    overlay.classList.add('preview-style-softbox');
  } else {
    overlay.classList.add('preview-style-classic');
  }

  subtitlePreviewChunks = buildPreviewChunks(phrase, wordsPerLine);
  subtitlePreviewChunkIndex = subtitlePreviewChunkIndex % subtitlePreviewChunks.length;
  renderPreviewChunk(text, phrase, karaoke, karaokeEffects, caseName);

  if (subtitlePreviewInterval) clearInterval(subtitlePreviewInterval);
  subtitlePreviewInterval = setInterval(() => {
    subtitlePreviewChunkIndex = (subtitlePreviewChunkIndex + 1) % subtitlePreviewChunks.length;
    renderPreviewChunk(text, phrase, karaoke, karaokeEffects, caseName);
  }, lineMs);

  // Position: apply to preview overlay in real ASS coordinates.
  // ASS Alignment 8 (top): MarginV from top. ASS Alignment 2 (bottom): MarginV from bottom.
  // ASS Alignment 5 (middle): vertically centered, MarginV ignored.
  overlay.style.top = '';
  overlay.style.bottom = '';
  overlay.style.transform = '';
  if (position === 'top') {
    overlay.style.top = `${marginV}px`;
    overlay.style.bottom = 'auto';
  } else if (position === 'middle') {
    overlay.style.top = '50%';
    overlay.style.transform = 'translateY(-50%)';
    overlay.style.bottom = 'auto';
  } else {
    overlay.style.bottom = `${marginV}px`;
    overlay.style.top = 'auto';
  }

  // Fit the 1080x1920 frame inside the stage by scaling it.
  // Use min(width, height) ratio so the frame always fits inside the stage
  // (the stage can be height-constrained by its own max-height or by the
  // parent card max-height, which would otherwise clip the bottom text).
  if (frame) {
    const stageWidth = stage.clientWidth || 1;
    const stageHeight = stage.clientHeight || 1;
    const scale = Math.min(stageWidth / 1080, stageHeight / 1920);
    frame.style.transform = `scale(${scale})`;
  }

  // Collapse preview when subtitles are disabled, otherwise expand
  if (!enabled) {
    if (stage) stage.style.display = 'none';
    const card = document.querySelector('.subtitle-preview-card');
    if (card) card.classList.add('collapsed');
  } else {
    if (stage) stage.style.display = '';
    const card = document.querySelector('.subtitle-preview-card');
    if (card) card.classList.remove('collapsed');
  }
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
  renderNvidiaKeys();
  renderAirforceKeys();
  renderGroqKey();
  $('#api-provider').value = settings.apiProvider || 'openrouter';
  updateProviderUI();
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

  $('#subtitles-toggle').checked = !!settings.subtitlesEnabled;
  $('#app-language').value = settings.appLanguage || 'en';
  uiLang = settings.appLanguage || 'en';
  applyTranslations();
  setSubtitleFieldsExpanded(!!settings.subtitlesEnabled);
  $('#subtitle-style').value = settings.subtitleStyle;
  $('#subtitle-model').value = settings.subtitleModel;
  $('#subtitle-language').value = settings.subtitleLanguage;
  $('#subtitle-position').value = settings.subtitlePosition;
  $('#subtitle-words-per-line').value = String(settings.subtitleWordsPerLine);
  $('#subtitle-max-line-ms').value = String(settings.subtitleMaxLineMs);
  $('#subtitle-font-size').value = String(settings.subtitleFontSize);
  $('#subtitle-font-family').value = settings.subtitleFontFamily || 'Inter';
  $('#subtitle-margin-v').value = String(settings.subtitleMarginV);
  const savedOffset = settings.subtitleOffsetMs || 0;
  $('#subtitle-offset').value = String(savedOffset);
  $('#subtitle-offset-value').textContent = savedOffset > 0 ? `+${savedOffset} ms` : `${savedOffset} ms`;
  $('#subtitle-karaoke').checked = !!settings.subtitleKaraoke;
  const savedEffects = Array.isArray(settings.subtitleKaraokeEffects)
    ? settings.subtitleKaraokeEffects
      : (settings.subtitleKaraokeMode === 'both'
      ? ['highlight', 'box']
      : settings.subtitleKaraokeMode === 'underline'
        ? ['box']
        : settings.subtitleKaraokeMode === 'caps'
          ? ['caps']
          : ['highlight']);
  setSelectedKaraokeEffects(savedEffects);
  $('#subtitle-case').value = settings.subtitleCase || 'sentence';
  updateSubtitlePreview();
  // Recompute preview scale on window resize so the 1080x1920 frame keeps
  // fitting the available stage width.
  let __subPreviewResizeRaf = 0;
  window.addEventListener('resize', () => {
    if (__subPreviewResizeRaf) cancelAnimationFrame(__subPreviewResizeRaf);
    __subPreviewResizeRaf = requestAnimationFrame(() => {
      const stage = document.getElementById('subtitle-preview-stage');
      const frame = document.getElementById('subtitle-preview-frame');
      if (!stage || !frame) return;
      const w = stage.clientWidth || 1;
      const h = stage.clientHeight || 1;
      const scale = Math.min(w / 1080, h / 1920);
      frame.style.transform = `scale(${scale})`;
    });
  });
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
  if (subtitlePreviewInterval) {
    clearInterval(subtitlePreviewInterval);
    subtitlePreviewInterval = null;
  }
});
