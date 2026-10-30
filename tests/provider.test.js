const test = require('node:test');
const assert = require('node:assert/strict');
const { chatCompletion, providerInfo, OPENAI_BASE_URL, GPT_6_1_SOL_MODEL } = require('../src/provider');

test('local OpenAI-compatible providers do not require an API key', () => {
  assert.deepEqual(providerInfo({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2:3b' }), {
    configured: true,
    local: true,
    model: 'llama3.2:3b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'auto'
  });
});

test('OpenAI GPT-6.1 Sol uses the Responses API when configured explicitly', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, async json() { return { output_text: 'Hello from GPT-6.1 Sol.' }; } };
  };
  try {
    const result = await chatCompletion({ baseUrl: OPENAI_BASE_URL, model: GPT_6_1_SOL_MODEL, protocol: 'responses', apiKey: 'test-key' }, [{ role: 'user', content: 'hello' }]);
    assert.deepEqual(result, { ok: true, reply: 'Hello from GPT-6.1 Sol.' });
    assert.equal(request.url, `${OPENAI_BASE_URL}/responses`);
    assert.equal(request.options.headers.authorization, 'Bearer test-key');
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, GPT_6_1_SOL_MODEL);
    assert.deepEqual(body.input, [{ role: 'user', content: 'hello' }]);
    assert.equal(body.max_output_tokens, 512);
  } finally {
    global.fetch = originalFetch;
  }
});

test('chatCompletion sends a bounded request to a local provider', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, async json() { return { choices: [{ message: { content: 'Hello from the local model.' } }] }; } };
  };
  try {
    const result = await chatCompletion({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.2:3b' }, [{ role: 'user', content: 'hello' }]);
    assert.deepEqual(result, { ok: true, reply: 'Hello from the local model.' });
    assert.equal(request.url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(request.options.headers.authorization, undefined);
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, 'llama3.2:3b');
    assert.equal(body.max_tokens, 512);
  } finally {
    global.fetch = originalFetch;
  }
});
