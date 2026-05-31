const { BaseAudioClient } = require('./base-audio-client');

class OpenRouterClient extends BaseAudioClient {
  get apiUrl() {
    return 'https://openrouter.ai/api/v1/chat/completions';
  }

  get model() {
    return 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
  }

  get providerName() {
    return 'OpenRouter';
  }

  _buildHeaders(apiKey) {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://shotshorts.app',
      'X-Title': 'ShotShorts',
    };
  }
}

module.exports = { OpenRouterClient };
