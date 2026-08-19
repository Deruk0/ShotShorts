const test = require('node:test');
const assert = require('node:assert/strict');
const { GroqStoryAnalyzer } = require('../app/services/groq-story-analyzer');

class FakeStoryAnalyzer extends GroqStoryAnalyzer {
  constructor(responses) {
    super(['test-key']);
    this.responses = [...responses];
    this.prompts = [];
  }

  async _requestWindowWithRetry(prompt) {
    this.prompts.push(prompt);
    const response = this.responses.shift();
    if (!response) throw new Error('Missing fake response');
    return response;
  }
}

class JsonRecoveryAnalyzer extends GroqStoryAnalyzer {
  constructor() {
    super(['test-key']);
    this.calls = [];
  }

  async _requestWindow(apiKey, prompt, reasoningEffort, signal, requestOptions) {
    this.calls.push({ reasoningEffort, requestOptions });
    if (this.calls.length <= 2) {
      const err = new Error('Failed to validate JSON');
      err.response = {
        status: 400,
        data: { error: { code: 'json_validate_failed', message: 'Failed to validate JSON', failed_generation: '' } }
      };
      throw err;
    }
    return { stories: [] };
  }
}

test('story analysis grounds boundaries in block ids and refines the ending', async () => {
  const analyzer = new FakeStoryAnalyzer([
    {
      stories: [{
        title: 'Поездка домой',
        start_block_id: 1,
        end_block_id: 2,
        has_setup: true,
        has_resolution: false,
        end_may_continue: true,
        confidence: 0.7
      }]
    },
    {
      story: {
        title: 'Поездка домой',
        start_block_id: 1,
        end_block_id: 3,
        has_setup: true,
        has_resolution: true,
        starts_mid_thought: false,
        ends_mid_thought: false,
        complete: true,
        confidence: 0.95
      }
    }
  ]);
  const segments = [
    { start: 0, end: 5, text: 'Я опоздал на последний поезд.' },
    { start: 5, end: 10, text: 'Тогда водитель автобуса решил помочь.' },
    { start: 10, end: 15, text: 'В итоге я добрался домой вовремя.' },
    { start: 15, end: 20, text: 'После этого началась другая тема.' }
  ];

  const result = await analyzer.analyzeTranscript(segments, 20);

  assert.equal(result.blocks.length, 4);
  assert.equal(result.stories.length, 1);
  assert.equal(result.stories[0].startBlockId, 1);
  assert.equal(result.stories[0].endBlockId, 3);
  assert.equal(result.stories[0].start, 0);
  assert.equal(result.stories[0].end, 15);
  assert.match(analyzer.prompts[0], /start_block_id/);
  assert.match(analyzer.prompts[1], /Move the boundaries when necessary/);
});

test('first pass rejects a boundary block that was not visible to the model', () => {
  const analyzer = new GroqStoryAnalyzer(['test-key']);
  analyzer._allBlocks = analyzer.buildTranscriptBlocks([
    { start: 0, end: 5, text: 'Первый блок.' },
    { start: 5, end: 10, text: 'Второй блок.' },
    { start: 10, end: 15, text: 'Скрытый блок.' }
  ]);
  const window = {
    coreStart: 0,
    coreEnd: 1,
    windowStart: 0,
    windowEnd: 1,
    blocks: analyzer._allBlocks.slice(0, 2)
  };

  const stories = analyzer._sanitizeWindowStories([
    { title: 'Плохая граница', start_block_id: 1, end_block_id: 3 }
  ], window, 15);

  assert.deepEqual(stories, []);
});

test('quality gate rejects a candidate that still has no resolution after refinement', async () => {
  const analyzer = new FakeStoryAnalyzer([
    {
      stories: [{
        title: 'Без финала',
        start_block_id: 1,
        end_block_id: 2,
        has_setup: true,
        has_resolution: false,
        end_may_continue: true
      }]
    },
    {
      story: {
        title: 'Без финала',
        start_block_id: 1,
        end_block_id: 2,
        has_setup: true,
        has_resolution: false,
        starts_mid_thought: false,
        ends_mid_thought: true,
        complete: false
      }
    }
  ]);

  await assert.rejects(
    analyzer.analyzeTranscript([
      { start: 0, end: 5, text: 'История только начинается.' },
      { start: 5, end: 10, text: 'А дальше запись обрывается.' }
    ], 10),
    /none had both a complete setup and resolution/
  );
});

test('JSON validation errors fall back to non-reasoning and local parsing modes', async () => {
  const analyzer = new JsonRecoveryAnalyzer();

  const result = await analyzer._requestWindowWithRetry('Return JSON only', null, 'test');

  assert.deepEqual(result, { stories: [] });
  assert.deepEqual(
    analyzer.calls.map((call) => [call.reasoningEffort, call.requestOptions.useJsonMode]),
    [['default', true], ['none', true], ['none', false]]
  );
  assert.ok(analyzer.calls.every((call) => call.requestOptions.maxCompletionTokens === 4096));
});
