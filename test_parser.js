const { BaseAudioClient } = require('./app/services/base-audio-client');

// Simulate the real NVIDIA response from earlier
const nvidiaResponse = `[
  {"index": 1, "very short title), start and end timestamps.

But we don't have the audio content. The user gave a description of the task, but not the actual audio. So we cannot determine the stories. However, maybe the audio is described in the context? Let's read the context again:

"You are an audio analyst. This audio file contains multiple stories narrated one after another. Your task: 1. Listen to the entire audio carefully from start to finish. 2. Identify EVERY individual story. Do NOT skip any story. Do NOT merge stories together. 3. For each story, provide the START timestamp and END timestamp in seconds (decimal, e.g. 123.45). 4. Give each story a VERY SHORT title (maximum 3-4 words) that captures the meaning of the FIRST SENTENCE of the story. The title MUST be in Russian language. IMPORTANT RULES: - The first story starts at 0.0 seconds (or close to it after any intro). - The last story ends at the end of the audio. - Every story MUST be in the output. Do not omit any story. - Do NOT merge multiple stories into one entry. - Be precise with timestamps. - The title MUST be very short (max 3-4 words). - Respond ONLY with valid JSON array, no markdown, no explanation. Response format: [ {"index": 1, "title": "Короткое название на русском", "start": 0.0, "end": 125.3}, {"index": 2, "title": "Короткое название на русском", "start": 127.8, "end": 298.1} ]"

But there is no audio content provided. So we cannot answer. However, maybe the audio is described in the context? Let's read the context again:

"You are an audio analyst. This audio file contains multiple stories narrated one after another. Your task: 1. Listen to the entire audio carefully from start to finish. 2. Identify EVERY individual story. Do NOT skip any story. Do NOT merge stories together. 3. For each story, provide the START timestamp and END timestamp in seconds (decimal, e.g. 123.45). 4. Give each story a VERY SHORT title (maximum 3-4 words) that captures the meaning of the FIRST SENTENCE of the story. The title MUST be in Russian language.  IMPORTANT RULES: - The first story starts at 0.0 seconds (or close to it after any intro). - The last story ends at the end of the audio. - Every story MUST be in the output. Do not omit any story. - Do NOT merge multiple stories into one entry. - Be precise with timestamps. - The title MUST be very short (max 3-4 words). - Respond ONLY with valid JSON array, no markdown, no explanation. . . . . . . . Response format: [ {"index": 1, "title": "Короткое название на русском", "start": 0.0, "end": 125.3}, {"index": 2, "title": "Короткое название на русском", "start": 127.8, "end": 298.1} ]"

But there is no audio content. So maybe the audio is described in . Maybe the audio is described in the context? Let's read the context again:

"You are an audio analyst. This audio file contains multiple stories narrated one after another. Your task: 1. Listen to the entire audio carefully from start to finish. 2. Identify EVERY individual story. Do NOT skip any story. Do NOT merge stories together. 3. For each story, provide the START timestamp and END timestamp in seconds (decimal, e.g. 123.45). 4. Give each story a VERY SHORT title (maximum 3-4 words) that captures the meaning of the FIRST SENTENCE of the story. The title MUST be in Russian language. IMPORTANT RULES: - The first story starts at 0.0 seconds (or close to it after any intro). - The last story ends at the end of the audio. - Every story MUST be in the output. Do not omit any story. - Do NOT merge multiple stories into one entry. - Be precise with timestamps. - The title MUST be very short (max 3-4 words). - Respond ONLY with valid JSON array, no markdown, no explanation. Response format: [ {"index": 1, "title": "Короткое название на русском", "start": 0.0, "end": 125.3}, {"index": 2, "title": "Короткое название на русском", "start": 127.8, "end": 298.1} ]"

But there is no audio content. So maybe the audio is described in . Maybe the audio is described in the context? Let's read the context again:

"You are an audio analyst. This audio file contains multiple stories narrated one after another. Your task: 1. Listen to the entire audio carefully from start to finish. 2. Identify EVERY individual story. Do NOT skip any story. Do NOT merge stories together. 3. For each story, provide the START timestamp and END"},{"index": 2, "title": "Короткое название на русском", "start": 0.0, "end": 125.3},
  {"index": 2, "title": "Короткое название на русском", "start": 127.8, "end": 298.1}]

[
  {"index": 1, "title": "Короткое название на русском", "start": 0.0, "end": 125.3},
  {"index": 2, "title": "Короткое название на русском", "start": 127.8, "end": 298.1}]
}`;

// Test the parser
const client = new BaseAudioClient(['test'], null);
const result = client._extractJsonArray(nvidiaResponse);
console.log('Parsed:', JSON.stringify(result, null, 2));
