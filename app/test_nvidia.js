const axios = require('axios');

const API_KEY = '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';
const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

async function testText() {
  console.log('=== TEST 1: Simple text request ===');
  try {
    const response = await axios.post(API_URL, {
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      messages: [
        { role: 'user', content: 'Say hello in one word.' }
      ],
      max_tokens: 10,
      temperature: 0.1,
    }, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(response.data, null, 2));
    return true;
  } catch (err) {
    console.error('Text test FAILED:', err.response?.status, err.response?.statusText);
    console.error('Error data:', JSON.stringify(err.response?.data, null, 2));
    console.error('Error message:', err.message);
    return false;
  }
}

async function testAudio() {
  console.log('\n=== TEST 2: Audio input request ===');
  try {
    // Create a tiny fake MP3 base64 (just to test the payload structure)
    const fakeMp3Base64 = 'SUQzBAAAAAABAFRYWFgAAAASAAADbWFqb3JfYnJhbmQAbXA0MgBUWFZYAAAAEQAAA21pbm9yX3ZlcnNpb24AMABUWFZYAAAAHAAAA2NvbXBhdGlibGVfYnJhbmRzAGlzb21tcDQyAP/7UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    const response = await axios.post(API_URL, {
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Count to three.' },
            {
              type: 'input_audio',
              input_audio: {
                data: fakeMp3Base64,
                format: 'mp3',
              },
            },
          ],
        },
      ],
      max_tokens: 50,
      temperature: 0.1,
    }, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(response.data, null, 2));
    return true;
  } catch (err) {
    console.error('Audio test FAILED:', err.response?.status, err.response?.statusText);
    console.error('Error data:', JSON.stringify(err.response?.data, null, 2));
    console.error('Error message:', err.message);
    return false;
  }
}

async function testModels() {
  console.log('\n=== TEST 3: Check available models ===');
  try {
    const response = await axios.get('https://integrate.api.nvidia.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
      },
      timeout: 15000,
    });
    const models = response.data.data || [];
    const nemotronModels = models.filter(m => m.id && m.id.includes('nemotron'));
    console.log('Nemotron models found:', nemotronModels.map(m => m.id));
    return nemotronModels.length > 0;
  } catch (err) {
    console.error('Models test FAILED:', err.response?.status, err.message);
    return false;
  }
}

(async () => {
  const textOk = await testText();
  const audioOk = await testAudio();
  const modelsOk = await testModels();

  console.log('\n=== SUMMARY ===');
  console.log('Text request:', textOk ? 'OK' : 'FAILED');
  console.log('Audio request:', audioOk ? 'OK' : 'FAILED');
  console.log('Models list:', modelsOk ? 'OK' : 'FAILED');
})();
