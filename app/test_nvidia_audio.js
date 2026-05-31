const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_KEY = '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';
const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Read a tiny real MP3 file or create a minimal valid one
function getRealMp3Base64() {
  // We'll try to find any mp3 in the project first
  const possiblePaths = [
    path.join(__dirname, '..', 'resources', '*.mp3'),
  ];
  
  // Just use a known minimal valid MP3 frame as base64
  // This is a 1-second silent MP3 (mono, 16kHz)
  const minimalMp3Base64 = '//uQxAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//uQxAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
  return minimalMp3Base64;
}

async function testVariant(name, payload) {
  console.log(`\n=== ${name} ===`);
  try {
    const response = await axios.post(API_URL, payload, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    console.log('Status:', response.status);
    const content = response.data.choices?.[0]?.message?.content;
    console.log('Content:', content ? content.slice(0, 100) : 'null');
    return true;
  } catch (err) {
    console.error('FAILED:', err.response?.status, err.response?.statusText);
    console.error('Error:', JSON.stringify(err.response?.data, null, 2));
    return false;
  }
}

(async () => {
  const audioBase64 = getRealMp3Base64();
  const prompt = 'Listen to this audio and tell me if you hear anything.';

  // Variant 1: OpenAI format (input_audio) — already failed, but let's confirm
  await testVariant('Variant 1: input_audio (OpenAI format)', {
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'input_audio', input_audio: { data: audioBase64, format: 'mp3' } }
      ]
    }],
    max_tokens: 50,
  });

  // Variant 2: audio_url with data URI
  await testVariant('Variant 2: audio_url with data URI', {
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'audio_url', audio_url: { url: `data:audio/mp3;base64,${audioBase64}` } }
      ]
    }],
    max_tokens: 50,
  });

  // Variant 3: image_url with audio data (sometimes used for multimodal)
  await testVariant('Variant 3: image_url (data URI hack)', {
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:audio/mp3;base64,${audioBase64}` } }
      ]
    }],
    max_tokens: 50,
  });

  // Variant 4: Try without model prefix (just the name)
  await testVariant('Variant 4: input_audio without nvidia/ prefix', {
    model: 'nemotron-3-nano-omni-30b-a3b-reasoning',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'input_audio', input_audio: { data: audioBase64, format: 'mp3' } }
      ]
    }],
    max_tokens: 50,
  });

  // Variant 5: Check if NVIDIA uses different endpoint for audio
  console.log('\n=== Variant 5: Check /audio/transcriptions endpoint ===');
  try {
    const response = await axios.post('https://integrate.api.nvidia.com/v1/audio/transcriptions', {
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
      file: 'dummy',
    }, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      timeout: 10000,
    });
    console.log('Status:', response.status);
  } catch (err) {
    console.error('Transcriptions endpoint:', err.response?.status, err.response?.statusText);
  }

  console.log('\n=== Summary ===');
  console.log('NVIDIA NIM text API works fine.');
  console.log('Audio input requires a different approach than OpenRouter.');
  console.log('Possible solutions:');
  console.log('  1. NVIDIA may require uploading audio to a temporary URL first');
  console.log('  2. The model may not support base64 inline audio via chat completions');
  console.log('  3. Different API endpoint or different audio format required');
})();
