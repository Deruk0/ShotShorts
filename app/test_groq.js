/**
 * Test script: Groq API connectivity + transcription
 * Run: node app/test_groq.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const API_KEY = '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';

// === STEP 1: Simple connectivity test ===
async function testConnectivity(proxy) {
  console.log('\n=== STEP 1: Connectivity test ===');
  console.log(`Proxy: ${proxy ? `${proxy.type}://${proxy.host}:${proxy.port}` : 'none'}`);

  const config = { timeout: 15000 };
  const agent = buildProxyAgent(proxy);
  if (agent) config.httpsAgent = agent;

  try {
    const res = await axios.get('https://api.groq.com/openai/v1/models', {
      ...config,
      headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    const whisperModels = res.data.data.filter(m => m.id.includes('whisper'));
    console.log(`SUCCESS: Connected to Groq API (${res.data.data.length} models total)`);
    console.log('Whisper models:');
    whisperModels.forEach(m => console.log(`  - ${m.id} (active: ${m.active})`));
    return true;
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    if (err.code) console.log(`Error code: ${err.code}`);
    if (err.response) console.log(`HTTP status: ${err.response.status}`);
    return false;
  }
}

// === STEP 2: Generate a short test audio ===
function generateTestAudio() {
  console.log('\n=== STEP 2: Generate test audio ===');
  const testFile = path.join(os.tmpdir(), 'groq_test_audio.mp3');

  // Check if ffmpeg is available
  const { execSync } = require('child_process');
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
  } catch {
    console.log('ffmpeg not found, skipping audio generation');
    return null;
  }

  // Generate 3 seconds of silence + tone (a tiny mp3)
  try {
    execSync(
      `ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3" -codec:a libmp3lame -b:a 64k "${testFile}"`,
      { stdio: 'ignore' }
    );
    const size = fs.statSync(testFile).size;
    console.log(`Generated test audio: ${testFile} (${(size / 1024).toFixed(1)} KB)`);
    return testFile;
  } catch (err) {
    console.log(`Failed to generate test audio: ${err.message}`);
    return null;
  }
}

// === STEP 3: Transcribe test audio ===
async function testTranscription(audioPath, proxy) {
  console.log('\n=== STEP 3: Transcription test ===');
  console.log(`Audio file: ${audioPath} (${(fs.statSync(audioPath).size / 1024).toFixed(1)} KB)`);

  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath), {
    filename: 'test.mp3',
    contentType: 'audio/mpeg'
  });
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'ru');
  form.append('response_format', 'verbose_json');

  const config = {
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${API_KEY}`
    },
    timeout: 60000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  };

  const agent = buildProxyAgent(proxy);
  if (agent) config.httpsAgent = agent;

  try {
    const start = Date.now();
    const res = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      config
    );
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`SUCCESS in ${elapsed}s`);
    console.log(`Response: ${JSON.stringify(res.data).slice(0, 500)}`);
    return true;
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    if (err.code) console.log(`Error code: ${err.code}`);
    if (err.response) {
      console.log(`HTTP status: ${err.response.status}`);
      console.log(`Response: ${JSON.stringify(err.response.data).slice(0, 500)}`);
    }
    return false;
  }
}

function buildProxyAgent(proxy) {
  if (!proxy || !proxy.host) return null;
  const { type = 'http', host, port, username, password } = proxy;
  const cleanHost = host.replace(/^(https?|socks\d?):\/\//i, '');
  const encUser = username ? encodeURIComponent(String(username)) : '';
  const encPass = password ? encodeURIComponent(String(password)) : '';

  if (type === 'socks5') {
    const url = username
      ? `socks5://${encUser}:${encPass}@${cleanHost}:${port}`
      : `socks5://${cleanHost}:${port}`;
    return new SocksProxyAgent(url);
  }
  const proto = type === 'https' ? 'https' : 'http';
  const url = username
    ? `${proto}://${encUser}:${encPass}@${cleanHost}:${port}`
    : `${proto}://${cleanHost}:${port}`;
  return new HttpsProxyAgent(url);
}

// === MAIN ===
async function main() {
  console.log('=== Groq API Test ===');

  // Read proxy from electron-store
  let proxy = null;
  try {
    const Store = (await import('electron-store')).default;
    const store = new Store();
    proxy = store.get('proxy');
    console.log(`Proxy from settings: ${JSON.stringify(proxy)}`);
  } catch {
    // Try reading from settings file directly
    const settingsPath = path.join(os.homedir(), '.shotshorts', 'settings.json');
    try {
      if (fs.existsSync(settingsPath)) {
        const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        proxy = data.proxy;
        console.log(`Proxy from file: ${JSON.stringify(proxy)}`);
      }
    } catch {}
  }

  // Test 1: Without proxy
  console.log('\n--- WITHOUT PROXY ---');
  const ok1 = await testConnectivity(null);

  // Test 2: With proxy (if configured)
  if (proxy && proxy.host) {
    console.log('\n--- WITH PROXY ---');
    const ok2 = await testConnectivity(proxy);

    if (ok2) {
      const audio = generateTestAudio();
      if (audio) {
        await testTranscription(audio, proxy);
        try { fs.unlinkSync(audio); } catch {}
      }
    }
  } else {
    console.log('\n--- No proxy configured, skipping proxy test ---');
    if (ok1) {
      const audio = generateTestAudio();
      if (audio) {
        await testTranscription(audio, null);
        try { fs.unlinkSync(audio); } catch {}
      }
    }
  }
}

main().catch(err => console.error('Test failed:', err));
