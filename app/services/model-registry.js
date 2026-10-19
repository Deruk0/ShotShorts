/**
 * Model registry helpers: custom OpenAI-compatible providers, models bound to
 * providers and the 'custom:<id>' model-key scheme used across settings and UI.
 * A provider holds the shared Base URL + API key, so several models can reuse
 * the same credentials. Roles (transcription / analysis) use ordered fallback
 * chains of model keys.
 */

const GROQ_TRANSCRIPTION_BASE = 'https://api.groq.com/openai/v1';
const GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3';

function normalizeBaseUrl(url) {
  const raw = String(url || '').trim().replace(/\/+$/, '');
  if (!raw || !/^https?:\/\//i.test(raw)) return '';
  return raw;
}

function isCustomModelKey(key) {
  return String(key || '').startsWith('custom:');
}

function parseModelKey(key) {
  const k = String(key || '');
  if (isCustomModelKey(k)) {
    return { provider: 'custom', value: k.slice('custom:'.length) };
  }
  return { provider: 'none', value: k };
}

function createEntityId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * Sanitize the stored provider list. Entries missing a valid base URL or API
 * key are dropped; ids and names get defaults.
 */
function normalizeCustomProviders(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const baseUrl = normalizeBaseUrl(entry.baseUrl);
    const apiKey = String(entry.apiKey || '').trim();
    if (!baseUrl || !apiKey) return;
    const id = String(entry.id || '').trim() || createEntityId('prov');
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      name: String(entry.name || '').trim() || baseUrl,
      baseUrl,
      apiKey
    });
  });
  return out;
}

/**
 * Sanitize the stored model list. Models must reference an existing provider
 * (from the providers list passed in) and carry a non-empty model id.
 */
function normalizeCustomModels(list, providers = []) {
  if (!Array.isArray(list)) return [];
  const providerIds = new Set(normalizeCustomProviders(providers).map((p) => p.id));
  const seen = new Set();
  const out = [];
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const providerId = String(entry.providerId || '').trim();
    const modelId = String(entry.modelId || '').trim();
    if (!providerId || !modelId) return;
    if (!providerIds.has(providerId)) return;
    const id = String(entry.id || '').trim() || createEntityId('cm');
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      providerId,
      name: String(entry.name || '').trim() || modelId,
      modelId
    });
  });
  return out;
}

function findCustomProvider(list, id) {
  const target = String(id || '');
  return normalizeCustomProviders(list).find((entry) => entry.id === target) || null;
}

function findCustomModel(list, id, providers = []) {
  const target = String(id || '');
  return normalizeCustomModels(list, providers).find((entry) => entry.id === target) || null;
}

function normalizeModelKeyList(keys) {
  if (!Array.isArray(keys)) return [];
  const seen = new Set();
  const out = [];
  keys.forEach((key) => {
    const k = String(key || '').trim();
    if (!isCustomModelKey(k) || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  });
  return out;
}

/**
 * Resolve an ordered chain of model keys against the stored models and
 * providers. Returns fully-resolvable entries shaped for the API clients:
 * { id, name, baseUrl, apiKey, modelId }. Keys that no longer resolve
 * (deleted model/provider) are skipped, so a broken chain entry never
 * breaks the pipeline.
 */
function resolveModelChain(models, providers, keys) {
  const providerList = normalizeCustomProviders(providers);
  const modelList = normalizeCustomModels(models, providerList);
  const out = [];
  normalizeModelKeyList(keys).forEach((key) => {
    const parsed = parseModelKey(key);
    if (parsed.provider !== 'custom') return;
    const model = modelList.find((entry) => entry.id === parsed.value);
    if (!model) return;
    const provider = providerList.find((entry) => entry.id === model.providerId);
    if (!provider) return;
    out.push({
      id: model.id,
      name: model.name || model.modelId,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      modelId: model.modelId
    });
  });
  return out;
}

/**
 * Legacy one-model-per-key settings (customModels entries carrying their own
 * baseUrl/apiKey, plus single subtitleModel / analysisModelKey picks) are
 * migrated to providers + models + chains. Returns null when there is
 * nothing to migrate.
 */
function migrateLegacyModels(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const legacyModels = Array.isArray(raw.customModels) ? raw.customModels : [];
  const hasLegacyModels = legacyModels.some((entry) => entry && typeof entry === 'object' && entry.baseUrl);
  const legacyProviders = Array.isArray(raw.customProviders) ? raw.customProviders : [];
  const models = Array.isArray(raw.customModels) ? raw.customModels : [];
  const newShape = models.every((entry) => entry && typeof entry === 'object' && entry.providerId);
  if (!hasLegacyModels && newShape) return null;

  const providers = normalizeCustomProviders(legacyProviders);
  const providerByKey = new Map();
  const normalizedModels = [];

  legacyModels.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const baseUrl = normalizeBaseUrl(entry.baseUrl);
    const apiKey = String(entry.apiKey || '').trim();
    const modelId = String(entry.modelId || '').trim();
    const providerId = String(entry.providerId || '').trim();
    if (providerId && modelId) {
      // Already provider-linked (possibly mixed with legacy entries).
      normalizedModels.push({
        id: String(entry.id || '').trim() || createEntityId('cm'),
        providerId,
        name: String(entry.name || '').trim() || modelId,
        modelId
      });
      return;
    }
    if (!baseUrl || !apiKey || !modelId) return;
    const key = `${baseUrl}::${apiKey}`;
    if (!providerByKey.has(key)) {
      const provider = {
        id: createEntityId('prov'),
        name: String(entry.name || '').trim() || baseUrl,
        baseUrl,
        apiKey
      };
      providers.push(provider);
      providerByKey.set(key, provider);
    }
    const provider = providerByKey.get(key);
    normalizedModels.push({
      id: String(entry.id || '').trim() || createEntityId('cm'),
      providerId: provider.id,
      name: String(entry.name || '').trim() || modelId,
      modelId
    });
  });

  const normalizeChain = (keys) => normalizeModelKeyList(
    (Array.isArray(keys) ? keys : [keys]).map((key) => {
      const parsed = parseModelKey(key);
      return parsed.provider === 'custom' ? `custom:${parsed.value}` : '';
    })
  );

  const transcriptionChain = normalizeChain(raw.transcriptionChain)
    .concat(normalizeChain(raw.subtitleModel));
  const analysisChain = normalizeChain(raw.analysisChain)
    .concat(normalizeChain(raw.analysisModelKey));

  return {
    customProviders: normalizeCustomProviders(providers),
    customModels: normalizeCustomModels(normalizedModels, providers),
    transcriptionChain,
    analysisChain
  };
}

module.exports = {
  GROQ_TRANSCRIPTION_BASE,
  GROQ_TRANSCRIPTION_MODEL,
  normalizeBaseUrl,
  isCustomModelKey,
  parseModelKey,
  createEntityId,
  normalizeCustomProviders,
  normalizeCustomModels,
  findCustomProvider,
  findCustomModel,
  normalizeModelKeyList,
  resolveModelChain,
  migrateLegacyModels
};
