const { NvidiaClient } = require('./nvidia-client');

// api.airforce is an OpenAI-compatible aggregator that also serves the
// Nemotron omni model. It reuses NvidiaClient's chunking + audio handling;
// only the endpoint and display name differ.
class AirforceClient extends NvidiaClient {
  get apiUrl() {
    return 'https://api.airforce/v1/chat/completions';
  }

  // api.airforce exposes the model without the "nvidia/" vendor prefix.
  get model() {
    return 'nemotron-3-nano-omni-30b-a3b-reasoning';
  }

  get providerName() {
    return 'api.airforce';
  }
}

module.exports = { AirforceClient };
