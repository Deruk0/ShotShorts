const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');

const API_KEY = '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';
const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Create test audio in different formats
const formats = [
  { ext: 'mp3', cmd: '-acodec libmp3lame -ab 128k -ac 1 -ar 16000', mime: 'audio/mpeg' },
  { ext: 'wav', cmd: '-acodec pcm_s16le -ac 1 -ar 16000', mime: 'audio/wav' },
  { ext: 'ogg', cmd: '-acodec libopus -ac 1 -ar 16000', mime: 'audio/ogg' },
  { ext: 'm4a', cmd: '-acodec aac -ab 128k -ac 1 -ar 16000', mime: 'audio/mp4' },
];

// Generate 2-second silent audio in each format
for (const fmt of formats) {
  const outFile = `test_audio.${fmt.ext}`;
  if (!fs.existsSync(outFile)) {
    execSync(`ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 2 ${fmt.cmd} ${outFile} -y`, { stdio: 'ignore' });
  }
}

async function testFormat(fmt) {
  const file = `test_audio.${fmt.ext}`;
  const base64 = fs.readFileSync(file).toString('base64');
  
  console.log(`\n=== Testing ${fmt.ext.toUpperCase()} (${fs.statSync(file).size} bytes) ===`);
  
  // Test 1: input_audio with format field
  try {
    const r1 = await axios.post(API_URL, {
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this audio.' },
          { type: 'input_audio', input_audio: { data: base64, format: fmt.ext } }
        ]
      }],
      max_tokens: 50,
    }, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    console.log('  input_audio:', r1.status, '- Content:', r1.data.choices?.[0]?.message?.content?.slice(0, 50));
    return true;
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.log('  input_audio: FAILED -', msg.slice(0, 100));
  }

  // Test 2: Try with mime type as format
  try {
    const r2 = await axios.post(API_URL, {
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this audio.' },
          { type: 'input_audio', input_audio: { data: base64, format: fmt.mime } }
        ]
      }],
      max_tokens: 50,
    }, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    console.log('  mime_type:', r2.status, '- Content:', r2.data.choices?.[0]?.message?.content?.slice(0, 50));
    return true;
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.log('  mime_type: FAILED -', msg.slice(0, 100));
  }

  return false;
}

(async () => {
  let anySuccess = false;
  for (const fmt of formats) {
    const ok = await testFormat(fmt);
    if (ok) anySuccess = true;
  }
  
  console.log('\n=== SUMMARY ===');
  if (anySuccess) {
    console.log('Found working format!');
  } else {
    console.log('No format worked. NVIDIA NIM does not support inline base64 audio.');
    console.log('Current code sends: MP3, 128kbps, mono, 16000Hz');
    console.log('NVIDIA likely requires a different API endpoint or file upload mechanism.');
  }
})();
