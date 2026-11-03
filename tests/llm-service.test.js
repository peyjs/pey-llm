// Verifies the pey.llm service against the acceptance criteria of
// docs/requirements.md — with a fake pey.http, never a real network.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLlmService } from '../lib/llm-service.js';
import {
  completionBody,
  createFakeHttp,
  deltaEvent,
  encode,
  errorBody,
  makeStreamHandle,
  settings,
  sleep,
  sseChunks,
} from './fakes.js';

function createService(map = {}) {
  const published = [];
  const http = createFakeHttp(map);
  const { service, deactivate } = createLlmService({ http, events: { publish: (type, data) => published.push({ type, data }) } });
  return { service, deactivate, http, published };
}

function wireBody(call) {
  return JSON.parse(call.input.body);
}

// --- settings ------------------------------------------------------------

test('should_store_settings_and_report_status_without_the_key', () => {
  const { service } = createService();

  const stored = service.setSettings(settings());
  const status = service.getSettingsStatus();

  assert.deepEqual(stored, { ok: true, hasApiKey: true });
  assert.deepEqual(status, { configured: true, baseUrl: 'https://api.example.com/v1', model: 'test-model', hasApiKey: true });
  assert.equal(JSON.stringify(status).includes('sk-test-key'), false);
});

test('should_accept_settings_without_a_key_and_skip_the_auth_header', async () => {
  const { service, http } = createService();

  const stored = service.setSettings(settings({ apiKey: undefined }));
  await service.complete([userMessage('سلام')]);

  assert.deepEqual(stored, { ok: true, hasApiKey: false });
  assert.equal(http.calls[0].input.headers.authorization, undefined);
  assert.equal(service.getSettingsStatus().configured, true);
});

test('should_reject_surface_invalid_settings', () => {
  const { service } = createService();

  assert.throws(() => service.setSettings({ baseUrl: 'not a url', model: 'm' }), (error) => error.code === 'LLM_SETTINGS_INVALID');
  assert.throws(() => service.setSettings({ baseUrl: 'https://api.example.com', model: '' }), (error) => error.code === 'LLM_SETTINGS_INVALID');
  assert.throws(() => service.setSettings({ baseUrl: 'ftp://api.example.com', model: 'm' }), (error) => error.code === 'LLM_SETTINGS_INVALID');
  assert.throws(() => service.setSettings({ baseUrl: 'https://api.example.com', model: 'm', apiKey: '' }), (error) => error.code === 'LLM_SETTINGS_INVALID');
  assert.equal(service.getSettingsStatus().configured, false);
});

test('should_clear_settings_and_publish_the_change_event_without_data', () => {
  const { service, published } = createService();

  service.setSettings(settings());
  service.clearSettings();

  assert.deepEqual(service.getSettingsStatus(), { configured: false, baseUrl: null, model: null, hasApiKey: false });
  assert.deepEqual(published, [
    { type: 'llm:settings-changed', data: undefined },
    { type: 'llm:settings-changed', data: undefined },
  ]);
});

test('should_reject_calls_when_not_configured', async () => {
  const { service } = createService();

  await assert.rejects(
    () => service.complete([userMessage('سلام')]),
    (error) => error.code === 'LLM_NOT_CONFIGURED',
  );
});

// --- complete ------------------------------------------------------------

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

test('should_return_text_finish_reason_and_usage_from_complete', async () => {
  const { service, http } = createService({
    request: () => ({
      ending: 'completed',
      status: 200,
      headers: {},
      body: encode(JSON.stringify(completionBody('پاسخ کامل', { finish: 'stop', usage: { total_tokens: 12 } }))),
    }),
  });
  service.setSettings(settings());

  const result = await service.complete([userMessage('سلام')]);

  assert.deepEqual(result, { text: 'پاسخ کامل', finishReason: 'stop', usage: { total_tokens: 12 } });
  const body = wireBody(http.calls[0]);
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'سلام' }] }]);
});

test('should_join_base_url_with_and_without_trailing_slash_identically', async () => {
  const { service, http } = createService();
  service.setSettings(settings({ baseUrl: 'https://api.example.com/v1/' }));
  await service.complete([userMessage('سلام')]);
  const withSlash = http.calls[0].input.url;

  const second = createService();
  second.service.setSettings(settings({ baseUrl: 'https://api.example.com/v1' }));
  await second.service.complete([userMessage('سلام')]);

  assert.equal(withSlash, second.http.calls[0].input.url);
  assert.equal(withSlash, 'https://api.example.com/v1/chat/completions');
});

test('should_send_authorization_header_only_when_a_key_exists', async () => {
  const { service, http } = createService();
  service.setSettings(settings({ apiKey: 'sk-live' }));
  await service.complete([userMessage('سلام')]);

  assert.equal(http.calls[0].input.headers.authorization, 'Bearer sk-live');
});

test('should_map_provider_statuses_to_categorized_codes', async () => {
  const cases = [
    [401, 'LLM_UNAUTHORIZED'],
    [403, 'LLM_UNAUTHORIZED'],
    [404, 'LLM_MODEL_NOT_FOUND'],
    [429, 'LLM_RATE_LIMITED'],
  ];
  for (const [status, expected] of cases) {
    const { service } = createService({
      request: () => ({ ending: 'completed', status, headers: {}, body: encode(JSON.stringify(errorBody('raw provider text'))) }),
    });
    service.setSettings(settings());
    await assert.rejects(
      () => service.complete([userMessage('سلام')]),
      (error) => error.code === expected && !JSON.stringify(error).includes('raw provider text'),
      String(status),
    );
  }
});

test('should_map_a_too_long_input_response_to_its_own_category', async () => {
  const { service } = createService({
    request: () => ({
      ending: 'completed',
      status: 400,
      headers: {},
      body: encode(JSON.stringify(errorBody("This model's maximum context length is 4096 tokens"))),
    }),
  });
  service.setSettings(settings());

  await assert.rejects(
    () => service.complete([userMessage('سلام')]),
    (error) => error.code === 'LLM_CONTEXT_TOO_LONG',
  );
});

test('should_map_a_json_mode_refusal_to_its_own_category', async () => {
  const { service } = createService({
    request: () => ({
      ending: 'completed',
      status: 400,
      headers: {},
      body: encode(JSON.stringify(errorBody("response_format type 'json_object' is not supported by this model"))),
    }),
  });
  service.setSettings(settings());

  await assert.rejects(
    () => service.complete([userMessage('سلام')], { json: true }),
    (error) => error.code === 'LLM_JSON_UNSUPPORTED',
  );
});

test('should_map_other_error_statuses_to_request_failed_without_leaking_text', async () => {
  const { service } = createService({
    request: () => ({ ending: 'completed', status: 500, headers: {}, body: encode('internal boom secret-value') }),
  });
  service.setSettings(settings({ apiKey: 'sk-secret' }));

  const error = await service.complete([userMessage('سلام')]).catch((caught) => caught);

  assert.equal(error.code, 'LLM_REQUEST_FAILED');
  assert.equal(JSON.stringify(error).includes('secret-value'), false);
  assert.equal(JSON.stringify(error).includes('sk-secret'), false);
});

test('should_report_invalid_response_when_body_is_unreadable', async () => {
  const { service } = createService({
    request: () => ({ ending: 'completed', status: 200, headers: {}, body: encode('not json at all') }),
  });
  service.setSettings(settings());

  await assert.rejects(
    () => service.complete([userMessage('سلام')]),
    (error) => error.code === 'LLM_INVALID_RESPONSE',
  );
});

test('should_reject_unsupported_content_parts_explicitly', async () => {
  const { service, http } = createService();
  service.setSettings(settings());

  await assert.rejects(
    () => service.complete([{ role: 'user', content: [{ type: 'image_url', imageUrl: 'x' }] }]),
    (error) => error.code === 'LLM_UNSUPPORTED_CONTENT',
  );
  await assert.rejects(
    () => service.complete([{ role: 'wizard', content: [{ type: 'text', text: 'x' }] }]),
    (error) => error.code === 'LLM_INPUT_INVALID',
  );
  await assert.rejects(
    () => service.complete([]),
    (error) => error.code === 'LLM_INPUT_INVALID',
  );
  assert.equal(http.calls.length, 0);
});

test('should_forward_transport_network_and_timeout_codes_unchanged', async () => {
  const { service } = createService({
    request: (input) => (input.url.includes('late')
      ? { ending: 'interrupted', error: { code: 'HTTP_TIMEOUT', message: 'timeout', source: 'pey.http', type: 'operational', timestamp: 't' } }
      : { ending: 'interrupted', error: { code: 'HTTP_NETWORK_FAILED', message: 'down', source: 'pey.http', type: 'operational', timestamp: 't' } }),
  });
  service.setSettings(settings());

  const first = await service.complete([userMessage('سلام')]).catch((caught) => caught);
  service.setSettings(settings({ baseUrl: 'https://late.example.com/v1' }));
  const second = await service.complete([userMessage('سلام')]).catch((caught) => caught);

  assert.equal(first.code, 'HTTP_NETWORK_FAILED');
  assert.equal(second.code, 'HTTP_TIMEOUT');
});

test('should_honor_json_and_sampling_options_in_the_request_body', async () => {
  const { service, http } = createService();
  service.setSettings(settings());

  await service.complete([userMessage('سلام')], { json: true, maxTokens: 100, temperature: 0.5 });

  const body = wireBody(http.calls[0]);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_tokens, 100);
  assert.equal(body.temperature, 0.5);
});

test('should_keep_the_settings_snapshot_of_an_in_flight_request', async () => {
  const { service, http } = createService({
    request: () => ({
      ending: 'completed',
      status: 200,
      headers: {},
      body: encode(JSON.stringify(completionBody('دیر'))),
    }),
  });
  service.setSettings(settings({ model: 'old-model' }));

  const pending = service.complete([userMessage('سلام')]);
  service.setSettings(settings({ model: 'new-model', baseUrl: 'https://other.example.com/v1' }));
  await pending;

  assert.equal(wireBody(http.calls[0]).model, 'old-model');
  assert.equal(http.calls[0].input.url, 'https://api.example.com/v1/chat/completions');
});

// --- stream --------------------------------------------------------------

test('should_deliver_stream_text_in_order_and_report_completion', async () => {
  const received = [];
  const { service, http } = createService();
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: (text) => received.push(text) });
  const final = await handle.done;

  assert.deepEqual(received, ['سلام', ' خوش', ' آمدید']);
  assert.equal(final.ending, 'completed');
  assert.equal(final.finishReason, 'stop');
  assert.equal(wireBody(http.calls[0]).stream, true);
});

test('should_reassemble_a_multibyte_character_torn_between_stream_chunks', async () => {
  const received = [];
  const full = encode(`data: ${JSON.stringify(deltaEvent('سلام'))}\n\ndata: [DONE]\n\n`);
  // The two bytes of "س" (0xD8 0xB3) are deliberately torn apart between
  // the raw chunks; the streaming decoder must reassemble them.
  const firstByte = full.indexOf(0xd8);
  const torn = [full.slice(0, firstByte + 1), full.slice(firstByte + 1, firstByte + 2), full.slice(firstByte + 2)];
  const { service } = createService({ streamChunks: torn });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: (text) => received.push(text) });
  const final = await handle.done;

  assert.equal(received.join(''), 'سلام');
  assert.equal(final.ending, 'completed');
});

test('should_report_interrupted_when_the_stream_closes_without_end_marker', async () => {
  const received = [];
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, sseChunks([deltaEvent('نیمه')], false)),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: (text) => received.push(text) });
  const final = await handle.done;

  assert.equal(received.length, 1);
  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'LLM_STREAM_INTERRUPTED');
});

test('should_report_invalid_response_when_a_stream_event_is_unreadable', async () => {
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, [encode('data: {broken json\n\n'), encode('data: [DONE]\n\n')]),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: () => {} });
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'LLM_INVALID_RESPONSE');
});

test('should_map_a_cut_transport_stream_to_the_llm_cut_code', async () => {
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, sseChunks([deltaEvent('نیمه')], false), {
      finalEnding: { ending: 'interrupted', error: { code: 'HTTP_STREAM_INTERRUPTED', message: 'cut', source: 'pey.http', type: 'operational', timestamp: 't' } },
    }),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: () => {} });
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'LLM_STREAM_INTERRUPTED');
});

test('should_stop_delivering_text_after_cancellation_and_report_cancelled', async () => {
  const received = [];
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(
      handlers,
      [
        encode(`data: ${JSON.stringify(deltaEvent('اول'))}\n\n`),
        encode(`data: ${JSON.stringify(deltaEvent('دوم'))}\n\n`),
        encode('data: [DONE]\n\n'),
      ],
      { delayMs: 15 },
    ),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: (text) => received.push(text) });
  await sleep(25);
  handle.cancel();
  const final = await handle.done;

  assert.equal(final.ending, 'cancelled');
  const countAtCancel = received.length;
  assert.ok(countAtCancel >= 1 && countAtCancel < 2, `chunks delivered before cancel: ${countAtCancel}`);
  await sleep(40);
  assert.equal(received.length, countAtCancel);
});

test('should_reject_stream_without_an_on_text_handler', async () => {
  const { service } = createService();
  service.setSettings(settings());

  await assert.rejects(
    () => service.stream([userMessage('سلام')], undefined, {}),
    (error) => error.code === 'LLM_INPUT_INVALID',
  );
});

test('should_end_an_in_flight_stream_as_interrupted_when_deactivated', async () => {
  const { service, deactivate } = createService({
    stream: (input, handlers) => makeStreamHandle(
      handlers,
      [encode(`data: ${JSON.stringify(deltaEvent('اول'))}\n\n`), encode(`data: ${JSON.stringify(deltaEvent('دوم'))}\n\n`)],
      { delayMs: 20 },
    ),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: () => {} });
  deactivate();
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SERVICE_UNAVAILABLE');
  await assert.rejects(() => service.complete([userMessage('سلام')]), (error) => error.code === 'SERVICE_UNAVAILABLE');
});

test('should_never_leak_the_key_through_stream_calls', async () => {
  const { service, http } = createService();
  service.setSettings(settings({ apiKey: 'sk-stream-secret' }));

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: () => {} });
  const final = await handle.done;

  assert.equal(http.calls[0].input.headers.authorization, 'Bearer sk-stream-secret');
  assert.equal(JSON.stringify(final).includes('sk-stream-secret'), false);
});
