const axios = require('axios');
const fs = require('fs');

const API_KEY = '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';
const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Use tiny 0.5s file
const base64 = fs.readFileSync('test_tiny.mp3').toString('base64');

const prompt = `Analyze this audio and identify stories with timestamps. Respond ONLY with JSON array: [{"index":1,"title":"...","start":0.0,"end":10.0}]`;

(async () => {
  // Test 1: max_tokens 16384
  console.log('=== Test 1: max_tokens=16384 ===');
  try {
    const r = await axios.post(API_URL, {
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'input_audio', input_audio: { data: base64, format: 'mp3' } }] }],
      temperature: 0.0,
      max_tokens: 16384,
    }, { headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' }, timeout: 60000 });
    
    const msg = r.data.choices[0].message;
    const text = msg?.content || msg?.reasoning || '';
    console.log('content len:', (msg?.content || '').length, '| reasoning len:', (msg?.reasoning || '').length);
    console.log('Starts with [:', text.trim().startsWith('['));
    console.log('Has JSON array:', /\[[\s\S]*\]/.test(text));
    console.log('Preview:', text.slice(0, 200).replace(/\n/g, '\\n'));
  } catch (err) {
    console.error('FAILED:', err.response?.status, err.message);
  }

  // Test 2: Add response_format
  console.log('\n=== Test 2: response_format=json_object ===');
  try {
    const r = await axios.post(API_URL, {
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'input_audio', input_audio: { data: base64, format: 'mp3' } }] }],
      temperature: 0.0,
      max_tokens: 8192,
      response_format: { type: 'json_object' },
    }, { headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' }, timeout: 60000 });
    
    const msg = r.data.choices[0].message;
    const text = msg?.content || '';
    console.log('content:', text.slice(0, 300));
    console.log('Has JSON array:', /\[[\s\S]*\]/.test(text));
  } catch (err) {
    console.error('FAILED:', err.response?.status, err.response?.data?.error?.message || err.message);
  }
})();
