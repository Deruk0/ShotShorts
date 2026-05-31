const axios = require('axios');
const fs = require('fs');

const API_KEY = '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';
const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const file = 'test_1s.mp3';
const base64 = fs.readFileSync(file).toString('base64');

const prompt = `You are an audio analyst. Identify each story with start/end timestamps in seconds and a short Russian title (3-4 words). Respond ONLY with valid JSON array, no markdown, no explanation. Format: [{"index":1,"title":"...","start":0.0,"end":125.3}]`;

(async () => {
  const models = [
    'nvidia/nemotron-3-nano-omni-30b-a3b',
    'nvidia/nemotron-3-nano-30b-a3b',
  ];
  
  for (const model of models) {
    console.log('\n=== Testing model:', model, '===');
    try {
      const r = await axios.post(API_URL, {
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'input_audio', input_audio: { data: base64, format: 'mp3' } }
          ]
        }],
        temperature: 0.1,
        max_tokens: 4096,
      }, {
        headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
        timeout: 60000,
      });
      
      const msg = r.data.choices[0].message;
      const text = msg?.content || msg?.reasoning || msg?.reasoning_content || '';
      console.log('content len:', (msg?.content || '').length, '| reasoning len:', (msg?.reasoning || '').length);
      console.log('Text first 200:', text.slice(0, 200));
      
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        try { JSON.parse(match[0]); console.log('JSON: PARSE OK'); }
        catch (e) { console.log('JSON: PARSE FAIL -', e.message); }
      } else {
        console.log('JSON: NO MATCH');
      }
    } catch (err) {
      console.error('FAILED:', err.response?.status, err.response?.data?.error?.message || err.message);
    }
  }
})();
