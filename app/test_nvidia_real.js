const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const API_KEY = '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';
const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

async function testMultipart() {
  console.log('=== TEST: Multipart form-data with real MP3 ===');
  try {
    const form = new FormData();
    form.append('model', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning');
    form.append('messages', JSON.stringify([
      { role: 'user', content: 'Describe this audio.' }
    ]));
    form.append('file', fs.createReadStream('test_silent.mp3'), {
      filename: 'audio.mp3',
      contentType: 'audio/mpeg',
    });
    form.append('max_tokens', '50');

    const response = await axios.post(API_URL, form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${API_KEY}`,
      },
      timeout: 30000,
    });

    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(response.data, null, 2));
  } catch (err) {
    console.error('FAILED:', err.response?.status, err.response?.statusText);
    console.error('Error:', JSON.stringify(err.response?.data, null, 2));
  }
}

async function testRealBase64() {
  console.log('\n=== TEST: Real MP3 as base64 input_audio ===');
  try {
    const mp3Buffer = fs.readFileSync('test_silent.mp3');
    const base64 = mp3Buffer.toString('base64');
    console.log('MP3 size:', mp3Buffer.length, 'bytes, base64 length:', base64.length);

    const response = await axios.post(API_URL, {
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this audio.' },
          { type: 'input_audio', input_audio: { data: base64, format: 'mp3' } }
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

    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(response.data, null, 2));
  } catch (err) {
    console.error('FAILED:', err.response?.status, err.response?.statusText);
    console.error('Error:', JSON.stringify(err.response?.data, null, 2));
  }
}

(async () => {
  await testMultipart();
  await testRealBase64();
})();
