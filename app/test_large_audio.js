const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const API_KEY = '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';
const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

async function testMethod(name, payload, isMultipart = false) {
  console.log(`\n=== ${name} ===`);
  try {
    let config = {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
      },
      timeout: 30000,
    };
    
    if (isMultipart) {
      config.headers = { ...config.headers, ...payload.getHeaders() };
    } else {
      config.headers['Content-Type'] = 'application/json';
    }

    const response = await axios.post(API_URL, payload, config);
    console.log('Status:', response.status);
    const msg = response.data.choices?.[0]?.message;
    const text = msg?.content || msg?.reasoning || msg?.reasoning_content || 'EMPTY';
    console.log('Response:', text.slice(0, 100));
    return true;
  } catch (err) {
    console.error('FAILED:', err.response?.status, err.response?.statusText);
    const msg = err.response?.data?.error?.message || err.message;
    console.error('Error:', msg.slice(0, 150));
    return false;
  }
}

(async () => {
  // Create 4-minute low-bitrate MP3
  const { execSync } = require('child_process');
  execSync('ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 240 -acodec libmp3lame -ab 32k -ac 1 -ar 16000 test_4min_32k.mp3 -y', { stdio: 'ignore' });
  
  const file = 'test_4min_32k.mp3';
  const base64 = fs.readFileSync(file).toString('base64');
  console.log(`File: ${file}, size: ${fs.statSync(file).size} bytes, base64: ${base64.length} chars`);

  // Variant 1: input_audio (JSON) — we know this fails on 4min
  await testMethod('Variant 1: input_audio (base64 JSON)', {
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this audio.' },
        { type: 'input_audio', input_audio: { data: base64, format: 'mp3' } }
      ]
    }],
    max_tokens: 50,
  });

  // Variant 2: audio_url with data URI (OpenAI GPT-4o style)
  await testMethod('Variant 2: audio_url with data URI', {
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this audio.' },
        { type: 'audio_url', audio_url: { url: `data:audio/mp3;base64,${base64}` } }
      ]
    }],
    max_tokens: 50,
  });

  // Variant 3: image_url with audio data (some backends accept any media through image_url)
  await testMethod('Variant 3: image_url with audio data URI', {
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this audio.' },
        { type: 'image_url', image_url: { url: `data:audio/mp3;base64,${base64}` } }
      ]
    }],
    max_tokens: 50,
  });

  // Variant 4: Proper multipart/form-data with file stream
  const form4 = new FormData();
  form4.append('model', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning');
  form4.append('messages', JSON.stringify([{ role: 'user', content: 'Describe this audio.' }]));
  form4.append('file', fs.createReadStream(file), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  form4.append('max_tokens', '50');
  await testMethod('Variant 4: multipart with file stream', form4, true);

  // Variant 5: Multipart with "audio" field name instead of "file"
  const form5 = new FormData();
  form5.append('model', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning');
  form5.append('messages', JSON.stringify([{ role: 'user', content: 'Describe this audio.' }]));
  form5.append('audio', fs.createReadStream(file), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  form5.append('max_tokens', '50');
  await testMethod('Variant 5: multipart with "audio" field', form5, true);

  // Variant 6: Try with URL reference instead of inline data
  await testMethod('Variant 6: audio_url with dummy HTTPS URL (will fail but check error)', {
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this audio.' },
        { type: 'audio_url', audio_url: { url: 'https://example.com/audio.mp3' } }
      ]
    }],
    max_tokens: 50,
  });

  console.log('\n=== SUMMARY ===');
  console.log('We need to find a format that NVIDIA accepts for large audio files (>3 min).');
  console.log('If all variants fail, NVIDIA NIM direct API may have a hard body size limit.');
})();
