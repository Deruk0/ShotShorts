const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBaseUrl,
  isCustomModelKey,
  parseModelKey,
  normalizeCustomProviders,
  normalizeCustomModels,
  findCustomProvider,
  findCustomModel,
  normalizeModelKeyList,
  resolveModelChain,
  migrateLegacyModels
} = require('../app/services/model-registry');

test('normalizeBaseUrl trims trailing slashes and rejects non-http values', () => {
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(normalizeBaseUrl('  http://localhost:1234/v1  '), 'http://localhost:1234/v1');
  assert.equal(normalizeBaseUrl('api.openai.com/v1'), '');
  assert.equal(normalizeBaseUrl('ftp://x'), '');
  assert.equal(normalizeBaseUrl(''), '');
});

test('parseModelKey distinguishes custom and unknown keys', () => {
  assert.deepEqual(parseModelKey('custom:cm-123'), { provider: 'custom', value: 'cm-123' });
  assert.deepEqual(parseModelKey('whisper-large-v3'), { provider: 'none', value: 'whisper-large-v3' });
  assert.deepEqual(parseModelKey(''), { provider: 'none', value: '' });
  assert.equal(isCustomModelKey('custom:x'), true);
  assert.equal(isCustomModelKey('whisper-large-v3'), false);
});

test('normalizeCustomProviders drops invalid entries and fills defaults', () => {
  const providers = normalizeCustomProviders([
    { id: 'a', name: '', baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-1' },
    { id: 'b', baseUrl: 'https://x', apiKey: '' },          // no key -> dropped
    { baseUrl: 'not-a-url', apiKey: 'sk' },                 // bad url -> dropped
    { id: 'a', name: 'dup', baseUrl: 'https://y', apiKey: 'sk' }, // duplicate id -> dropped
    null
  ]);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, 'a');
  assert.equal(providers[0].name, 'https://api.openai.com/v1'); // name defaults to base url
  assert.equal(providers[0].baseUrl, 'https://api.openai.com/v1');
});

test('normalizeCustomModels requires a known provider and fills defaults', () => {
  const providers = [{ id: 'p1', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk' }];
  const models = normalizeCustomModels([
    { id: 'm1', providerId: 'p1', name: '', modelId: 'whisper-large-v3' },
    { id: 'm2', providerId: 'missing', modelId: 'x' }, // unknown provider -> dropped
    { id: 'm3', providerId: 'p1', modelId: '' },       // no model id -> dropped
    { id: 'm1', providerId: 'p1', modelId: 'dup' },    // duplicate id -> dropped
    null
  ], providers);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'm1');
  assert.equal(models[0].name, 'whisper-large-v3'); // name defaults to model id
  assert.equal(models[0].providerId, 'p1');
});

test('findCustomProvider and findCustomModel match by id', () => {
  const providers = [{ id: 'p1', name: 'N', baseUrl: 'https://x', apiKey: 'k' }];
  const models = [{ id: 'm1', providerId: 'p1', name: 'M', modelId: 'mm' }];
  assert.equal(findCustomProvider(providers, 'p1').baseUrl, 'https://x');
  assert.equal(findCustomProvider(providers, 'p2'), null);
  assert.equal(findCustomModel(models, 'm1', providers).modelId, 'mm');
  assert.equal(findCustomModel(models, 'm2', providers), null);
});

test('normalizeModelKeyList keeps only unique custom keys', () => {
  assert.deepEqual(
    normalizeModelKeyList(['custom:a', 'custom:a', 'plain', '', 'custom:b']),
    ['custom:a', 'custom:b']
  );
});

test('resolveModelChain resolves full entries and skips broken keys', () => {
  const providers = [
    { id: 'p1', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk-1' }
  ];
  const models = [
    { id: 'm1', providerId: 'p1', name: 'Whisper', modelId: 'whisper-large-v3' },
    { id: 'm2', providerId: 'p1', name: 'Qwen', modelId: 'qwen/qwen3.6-27b' }
  ];
  const chain = resolveModelChain(models, providers, ['custom:m1', 'custom:m2']);
  assert.equal(chain.length, 2);
  assert.deepEqual(chain[0], {
    id: 'm1',
    name: 'Whisper',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'gsk-1',
    modelId: 'whisper-large-v3'
  });

  // Unknown model / non-custom key / empty list are all skipped.
  assert.equal(resolveModelChain(models, providers, ['custom:gone', 'plain']).length, 0);
  assert.equal(resolveModelChain(models, providers, []).length, 0);
  // Model without provider cannot resolve.
  assert.equal(resolveModelChain(models, [], ['custom:m1']).length, 0);
});

test('migrateLegacyModels converts one-model-per-key settings to providers and chains', () => {
  const migrated = migrateLegacyModels({
    customModels: [
      { id: 'a', name: 'Groq Whisper', baseUrl: 'https://api.groq.com/openai/v1/', apiKey: 'gsk-1', modelId: 'whisper-large-v3' },
      { id: 'b', name: 'Groq Qwen', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk-1', modelId: 'qwen/qwen3.6-27b' }
    ],
    subtitleModel: 'custom:a',
    analysisModelKey: 'custom:b'
  });

  assert.ok(migrated);
  // Same base URL + key -> one shared provider.
  assert.equal(migrated.customProviders.length, 1);
  assert.equal(migrated.customProviders[0].baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(migrated.customModels.length, 2);
  const byId = new Map(migrated.customModels.map((m) => [m.id, m]));
  assert.equal(byId.get('a').providerId, migrated.customProviders[0].id);
  assert.equal(byId.get('b').modelId, 'qwen/qwen3.6-27b');

  // Legacy single picks seed the chains.
  assert.deepEqual(migrated.transcriptionChain, ['custom:a']);
  assert.deepEqual(migrated.analysisChain, ['custom:b']);

  // The migrated shape resolves through the chain resolver.
  const resolved = resolveModelChain(migrated.customModels, migrated.customProviders, migrated.transcriptionChain);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].modelId, 'whisper-large-v3');
});

test('migrateLegacyModels returns null for already-new settings and empty input', () => {
  assert.equal(migrateLegacyModels(null), null);
  assert.equal(migrateLegacyModels({}), null);
  const fresh = {
    customProviders: [{ id: 'p1', name: 'N', baseUrl: 'https://x', apiKey: 'k' }],
    customModels: [{ id: 'm1', providerId: 'p1', name: 'M', modelId: 'mm' }],
    transcriptionChain: ['custom:m1'],
    analysisChain: ['custom:m1']
  };
  assert.equal(migrateLegacyModels(fresh), null);
});

test('migrateLegacyModels migrates models even when providers already exist', () => {
  const migrated = migrateLegacyModels({
    customProviders: [{ id: 'p1', name: 'New', baseUrl: 'https://x', apiKey: 'k' }],
    customModels: [
      { id: 'new1', providerId: 'p1', name: 'New model', modelId: 'nm' },
      { id: 'old1', baseUrl: 'https://old', apiKey: 'k2', modelId: 'om' }
    ],
    subtitleModel: 'custom:old1',
    analysisModelKey: 'custom:new1'
  });
  assert.ok(migrated);
  assert.equal(migrated.customProviders.length, 2);
  assert.equal(migrated.customModels.length, 2);
  assert.ok(migrated.transcriptionChain.includes('custom:old1'));
  assert.ok(migrated.analysisChain.includes('custom:new1'));
});
