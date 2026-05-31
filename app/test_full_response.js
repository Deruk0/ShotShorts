const axios = require('axios');
const fs = require('fs');

const API_KEY = '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';
const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

async function testFullResponse() {
  // Use MP3 (the format we currently use)
  const base64 = fs.readFileSync('test_audio.mp3').toString('base64');
  
  console.log('=== Full response from NVIDIA with audio input ===');
  try {
    const response = await axios.post(API_URL, {
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'This audio contains multiple stories. Identify each story with start and end timestamps in seconds.' },
          { type: 'input_audio', input_audio: { data: base64, format: 'mp3' } }
        ]
      }],
      max_tokens: 4096,
      temperature: 0.1,
    }, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });

    console.log('Status:', response.status);
    console.log('\nFull response data:');
    console.log(JSON.stringify(response.data, null, 2));
    
    const msg = response.data.choices?.[0]?.message;
    console.log('\nMessage fields:');
    console.log('  content:', msg?.content);
    console.log('  audio:', msg?.audio);
    console.log('  reasoning:', msg?.reasoning);
    console.log('  reasoning_content:', msg?.reasoning_content);
    console.log('  tool_calls:', msg?.tool_calls);
    
  } catch (err) {
    console.error('FAILED:', err.response?.status, err.response?.statusText);
    console.error('Error:', JSON.stringify(err.response?.data, null, 2));
  }
}

testFullResponse();
