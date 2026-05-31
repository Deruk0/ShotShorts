const axios = require('axios');
const fs = require('fs');

const API_KEY = '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';
const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

(async () => {
  // Use a real audio file if available, otherwise the 1-min silence
  const file = 'test_1s.mp3'; // small file for quick test
  const base64 = fs.readFileSync(file).toString('base64');
  
  const prompt = `You are an audio analyst. This audio file contains multiple stories narrated one after another.

Your task:
1. Listen to the entire audio carefully from start to finish.
2. Identify EVERY individual story. Do NOT skip any story. Do NOT merge stories together.
3. For each story, provide the START timestamp and END timestamp in seconds (decimal, e.g. 123.45).
4. Give each story a VERY SHORT title (maximum 3-4 words) that captures the meaning of the FIRST SENTENCE of the story. The title MUST be in Russian language.

IMPORTANT RULES:
- The first story starts at 0.0 seconds (or close to it after any intro).
- The last story ends at the end of the audio.
- Every story MUST be in the output. Do not omit any story.
- Do NOT merge multiple stories into one entry.
- Be precise with timestamps.
- The title MUST be very short (max 3-4 words).
- Respond ONLY with valid JSON array, no markdown, no explanation.

Response format:
[
  {"index": 1, "title": "Короткое название на русском", "start": 0.0, "end": 125.3},
  {"index": 2, "title": "Короткое название на русском", "start": 127.8, "end": 298.1}
]`;

  console.log('=== Testing NVIDIA NIM response format ===');
  console.log('File:', file, 'base64 length:', base64.length);
  
  try {
    const r = await axios.post(API_URL, {
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
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
    console.log('\n--- Full message ---');
    console.log(JSON.stringify(msg, null, 2));
    
    const text = msg?.content || msg?.reasoning || msg?.reasoning_content || '';
    console.log('\n--- Extracted text (first 500 chars) ---');
    console.log(text.slice(0, 500));
    console.log('\n--- Text length:', text.length);
    
    // Try to find JSON array
    const match = text.match(/\[[\s\S]*\]/);
    console.log('\n--- JSON match found:', !!match);
    if (match) {
      console.log('JSON snippet:', match[0].slice(0, 200));
    }
    
  } catch (err) {
    console.error('FAILED:', err.response?.status, err.message);
  }
})();
