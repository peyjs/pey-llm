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
  createGate,
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

test('should_store_settings_and_report_status_without_the_key_when_saved', () => {
  const { service } = createService();

  const stored = service.setSettings(settings());
  const status = service.getSettingsStatus();

  assert.deepEqual(stored, { ok: true, hasApiKey: true });
  assert.deepEqual(status, { configured: true, baseUrl: 'https://api.example.com/v1', model: 'test-model', hasApiKey: true });
  assert.equal(JSON.stringify(status).includes('sk-test-key'), false);
});

test('should_skip_the_auth_header_when_settings_have_no_key', async () => {
  const { service, http } = createService();

  const stored = service.setSettings(settings({ apiKey: undefined }));
  await service.complete([userMessage('سلام')]);

  assert.deepEqual(stored, { ok: true, hasApiKey: false });
  assert.equal(http.calls[0].input.headers.authorization, undefined);
  assert.equal(service.getSettingsStatus().configured, true);
});

test('should_reject_surface_invalid_settings_when_a_field_is_malformed', () => {
  const { service } = createService();

  assert.throws(() => service.setSettings({ baseUrl: 'not a url', model: 'm' }), (error) => error.code === 'LLM_SETTINGS_INVALID');
  assert.throws(() => service.setSettings({ baseUrl: 'https://api.example.com', model: '' }), (error) => error.code === 'LLM_SETTINGS_INVALID');
  assert.throws(() => service.setSettings({ baseUrl: 'ftp://api.example.com', model: 'm' }), (error) => error.code === 'LLM_SETTINGS_INVALID');
  // A query or fragment would swallow /chat/completions into itself —
  // rejected at save time, while the dialog can still point at the field.
  assert.throws(() => service.setSettings({ baseUrl: 'https://api.example.com/v1?x=1', model: 'm' }), (error) => error.code === 'LLM_SETTINGS_INVALID');
  assert.throws(() => service.setSettings({ baseUrl: 'https://api.example.com/v1#frag', model: 'm' }), (error) => error.code === 'LLM_SETTINGS_INVALID');
  assert.throws(() => service.setSettings({ baseUrl: 'https://api.example.com', model: 'm', apiKey: '' }), (error) => error.code === 'LLM_SETTINGS_INVALID');
  assert.equal(service.getSettingsStatus().configured, false);
});

test('should_clear_settings_and_publish_the_change_event_without_data_when_cleared', () => {
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

test('should_return_text_finish_reason_and_usage_when_complete_succeeds', async () => {
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

test('should_join_the_base_url_identically_when_it_carries_trailing_slashes', async () => {
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

test('should_map_provider_statuses_to_categorized_codes_when_the_provider_refuses', async () => {
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

test('should_map_a_too_long_input_response_to_its_own_category_when_the_provider_reports_it', async () => {
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

test('should_map_a_json_mode_refusal_to_its_own_category_when_json_mode_is_unsupported', async () => {
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

test('should_map_other_error_statuses_to_request_failed_without_leaking_text_when_no_category_fits', async () => {
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

test('should_reject_unsupported_content_parts_explicitly_when_a_part_is_not_text', async () => {
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

test('should_forward_transport_network_and_timeout_codes_unchanged_when_delivery_fails', async () => {
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

test('should_honor_json_and_sampling_options_when_call_options_are_given', async () => {
  const { service, http } = createService();
  service.setSettings(settings());

  await service.complete([userMessage('سلام')], { json: true, maxTokens: 100, temperature: 0.5 });

  const body = wireBody(http.calls[0]);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_tokens, 100);
  assert.equal(body.temperature, 0.5);
});

test('should_keep_the_settings_snapshot_of_an_in_flight_request_when_settings_change_mid_call', async () => {
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

test('should_deliver_stream_text_in_order_and_report_completion_when_the_stream_ends', async () => {
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

test('should_reassemble_a_multibyte_character_when_it_is_torn_between_stream_chunks', async () => {
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

test('should_map_a_cut_transport_stream_to_the_llm_cut_code_when_the_stream_breaks', async () => {
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

test('should_stop_delivering_text_after_cancellation_and_report_cancelled_when_cancelled_mid_stream', async () => {
  const received = [];
  const gates = [createGate(), createGate(), createGate()];
  let resolveFirst = null;
  const firstDelivered = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(
      handlers,
      [
        encode(`data: ${JSON.stringify(deltaEvent('اول'))}\n\n`),
        encode(`data: ${JSON.stringify(deltaEvent('دوم'))}\n\n`),
        encode('data: [DONE]\n\n'),
      ],
      { gates },
    ),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, {
    onText: (text) => {
      received.push(text);
      resolveFirst?.();
    },
  });
  // Open the first gate so exactly one delta is delivered, then cancel
  // before the second gate opens — fully deterministic, no timers.
  gates[0].open();
  await firstDelivered;
  handle.cancel();
  gates[1].open();
  gates[2].open();
  const final = await handle.done;

  assert.equal(final.ending, 'cancelled');
  assert.deepEqual(received, ['اول'], 'exactly the first delta may arrive before the cancel');
});

test('should_reject_stream_without_an_on_text_handler_when_handlers_are_incomplete', async () => {
  const { service } = createService();
  service.setSettings(settings());

  await assert.rejects(
    () => service.stream([userMessage('سلام')], undefined, {}),
    (error) => error.code === 'LLM_INPUT_INVALID',
  );
});

test('should_end_an_in_flight_stream_as_interrupted_when_deactivated', async () => {
  const gates = [createGate(), createGate()];
  const { service, deactivate } = createService({
    stream: (input, handlers) => makeStreamHandle(
      handlers,
      [encode(`data: ${JSON.stringify(deltaEvent('اول'))}\n\n`), encode(`data: ${JSON.stringify(deltaEvent('دوم'))}\n\n`)],
      { gates },
    ),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: () => {} });
  deactivate();
  gates[0].open();
  gates[1].open();
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SERVICE_UNAVAILABLE');
  await assert.rejects(() => service.complete([userMessage('سلام')]), (error) => error.code === 'SERVICE_UNAVAILABLE');
});

test('should_never_leak_the_key_through_stream_calls_when_a_key_is_configured', async () => {
  const { service, http } = createService();
  service.setSettings(settings({ apiKey: 'sk-stream-secret' }));

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: () => {} });
  const final = await handle.done;

  assert.equal(http.calls[0].input.headers.authorization, 'Bearer sk-stream-secret');
  assert.equal(JSON.stringify(final).includes('sk-stream-secret'), false);
});

test('should_map_provider_error_status_in_stream_when_provider_rejects', async () => {
  // pey.http delivers a non-2xx status as an ordinary completed result;
  // the categorized code must survive into the stream ending.
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, [], {
      finalEnding: { ending: 'completed', status: 401, headers: {}, body: encode(JSON.stringify(errorBody('bad key'))) },
    }),
  });
  service.setSettings(settings());

  const final = await (await service.stream([userMessage('سلام')], undefined, { onText: () => {} })).done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'LLM_UNAUTHORIZED');
  assert.ok(!JSON.stringify(final.error).includes('bad key'), 'the provider text must not leak');
});

test('should_end_stream_as_request_failed_when_the_on_text_handler_throws', async () => {
  const gates = [createGate()];
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(
      handlers,
      [encode(`data: ${JSON.stringify(deltaEvent('اول'))}\n\n`)],
      { gates },
    ),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, {
    onText: () => {
      throw new Error('consumer bug');
    },
  });
  gates[0].open();
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'LLM_REQUEST_FAILED', 'a handler bug is not a stream interruption');
});

test('should_report_cancelled_complete_when_transport_cancels_the_request', async () => {
  const { service } = createService({
    request: () => ({ ending: 'cancelled' }),
  });
  service.setSettings(settings());

  await assert.rejects(
    () => service.complete([userMessage('سلام')]),
    (error) => error.code === 'LLM_REQUEST_FAILED',
  );
});

test('should_map_the_transport_rejection_when_the_call_is_refused_before_transfer', async () => {
  // pey.http can reject before any transfer runs (address policy,
  // validation): that rejection crosses the boundary through the delivery
  // mapping, never as an undeclared raw code.
  const { service } = createService({
    request: () => Promise.reject(Object.assign(new Error('forbidden'), {
      code: 'HTTP_URL_FORBIDDEN', source: 'pey.http', type: 'operational', timestamp: 't',
    })),
  });
  service.setSettings(settings({ baseUrl: 'http://myserver:8080/v1' }));

  await assert.rejects(
    () => service.complete([userMessage('سلام')]),
    (error) => error.code === 'LLM_REQUEST_FAILED' && error.source === 'pey.llm',
  );
});

test('should_map_the_stream_rejection_when_the_call_is_refused_before_transfer', async () => {
  // Same delivery mapping as complete: pey.http may reject the stream call
  // before any transfer runs, and the boundary never leaks the raw code.
  const { service } = createService({
    stream: () => Promise.reject(Object.assign(new Error('forbidden'), {
      code: 'HTTP_URL_FORBIDDEN', source: 'pey.http', type: 'operational', timestamp: 't',
    })),
  });
  service.setSettings(settings({ baseUrl: 'http://myserver:8080/v1' }));

  await assert.rejects(
    () => service.stream([userMessage('سلام')], undefined, { onText: () => {} }),
    (error) => error.code === 'LLM_REQUEST_FAILED' && error.source === 'pey.llm',
  );
});

test('should_report_unavailable_when_a_rejected_request_lands_after_deactivation', async () => {
  // The acquisition window with a REJECTING transport: deactivate during
  // the await must surface the standard unavailable error, never the
  // delivery-mapped transport code for a dead plugin.
  const gate = createGate();
  const { service, deactivate } = createService({
    request: () => new Promise((resolve, reject) => {
      // Held on a gate: deterministic rejection timing, no real timers.
      gate.wait().then(() => reject(Object.assign(new Error('network down'), {
        code: 'HTTP_NETWORK_FAILED', source: 'pey.http', type: 'operational', timestamp: 't',
      })));
    }),
  });
  service.setSettings(settings());

  const pending = service.complete([userMessage('سلام')]);
  deactivate();
  gate.open();
  await assert.rejects(
    () => pending,
    (error) => error.code === 'SERVICE_UNAVAILABLE' && error.source === 'pey.llm',
  );
});

test('should_refuse_the_settings_methods_when_called_after_deactivation', async () => {
  // The availability rule covers ALL five methods: a dead plugin neither
  // stores settings, clears them, reports them, nor publishes the
  // settings-changed event.
  const { service, deactivate, published } = createService();
  deactivate();

  assert.throws(() => service.setSettings(settings()), (error) => error.code === 'SERVICE_UNAVAILABLE');
  assert.throws(() => service.clearSettings(), (error) => error.code === 'SERVICE_UNAVAILABLE');
  assert.throws(() => service.getSettingsStatus(), (error) => error.code === 'SERVICE_UNAVAILABLE');
  assert.ok(!published.some((event) => event.type === 'llm:settings-changed'), 'no settings event for a dead plugin');
});

test('should_not_leak_a_raw_cancel_failure_when_a_window_or_the_handle_cancels_a_settling_transfer', async () => {
  // The windowed cancels and the returned handle use the same defensive
  // cancel as deactivate's cleanup loop: a throwing cancel on a settling
  // transfer never crosses the boundary raw.
  let cancelCalls = 0;
  const { service, deactivate } = createService({
    stream: () => ({
      cancel: () => {
        cancelCalls += 1;
        throw new Error('cancel exploded');
      },
      done: Promise.resolve({ ending: 'completed', status: 200, headers: {}, body: new Uint8Array() }),
    }),
  });
  service.setSettings(settings());

  const handlePromise = service.stream([userMessage('سلام')], undefined, { onText: () => {} });
  deactivate();
  const handle = await handlePromise;

  // Every cancel path is defensive: the acquisition window and the returned
  // handle both swallow a throwing cancel instead of leaking it raw (the
  // transport never registered in activeHandles here, so deactivate's
  // cleanup loop is not part of this count).
  assert.doesNotThrow(() => handle.cancel());
  assert.equal(cancelCalls, 2, 'the acquisition window and the handle both reached the cancel');
  const final = await handle.done;
  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SERVICE_UNAVAILABLE');
});

test('should_keep_the_read_loop_alive_when_the_handler_fails_and_the_cancel_throws', async () => {
  // A throwing onText handler cancels the transfer — and if that cancel
  // itself throws, the raw error must not escape into the transport's read
  // loop: the stream still ends as the structured handler interruption.
  let cancelCalls = 0;
  const gate = createGate();
  const { service } = createService({
    stream: (input, handlers) => {
      const transport = makeStreamHandle(handlers, [encode(`data: ${JSON.stringify(deltaEvent('اول'))}\n\n`)], {
        gates: [gate],
        finalEnding: { ending: 'completed', status: 200, headers: {}, body: new Uint8Array() },
      });
      transport.cancel = () => {
        cancelCalls += 1;
        throw new Error('cancel exploded');
      };
      return transport;
    },
  });
  service.setSettings(settings());

  const handlePromise = service.stream([userMessage('سلام')], undefined, {
    onText: () => {
      throw new Error('handler exploded');
    },
  });
  // The chunk must arrive only after the service has taken the transport
  // (that assignment is the sink's handle to cancel through).
  const handle = await handlePromise;
  gate.open();
  const final = await handle.done;

  assert.ok(cancelCalls >= 1, 'the handler-error path reached the cancel');
  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'LLM_REQUEST_FAILED');
  assert.equal(final.error.source, 'pey.llm');
});

test('should_refuse_the_result_when_the_completion_lands_after_deactivation', async () => {
  // The same guard stream applies: a transfer settling completed after
  // deactivation is never an ordinary answer for a dead plugin.
  const gate = createGate();
  const { service, deactivate } = createService({
    request: () => ({
      cancel: () => gate.open(),
      done: gate.wait().then(() => ({
        ending: 'completed', status: 200, headers: {}, body: encode(JSON.stringify(completionBody('پاسخ دیرهنگام'))),
      })),
    }),
  });
  service.setSettings(settings());

  const pending = service.complete([userMessage('سلام')]);
  deactivate();
  gate.open();

  await assert.rejects(
    () => pending,
    (error) => error.code === 'SERVICE_UNAVAILABLE',
  );
});

test('should_report_the_same_unavailable_error_when_a_non_2xx_completion_lands_after_deactivation', async () => {
  // One settlement rule for both methods: a non-2xx provider status that
  // settles after deactivation must surface as the standard unavailable
  // error, never as the categorized provider code.
  const gate = createGate();
  const { service, deactivate } = createService({
    request: () => ({
      cancel: () => gate.open(),
      done: gate.wait().then(() => ({
        ending: 'completed', status: 401, headers: {}, body: encode(JSON.stringify({ error: { message: 'nope' } })),
      })),
    }),
  });
  service.setSettings(settings());

  const pending = service.complete([userMessage('سلام')]);
  deactivate();
  gate.open();

  await assert.rejects(
    () => pending,
    (error) => error.code === 'SERVICE_UNAVAILABLE' && error.source === 'pey.llm',
  );
});

test('should_report_the_same_unavailable_error_when_an_interrupted_transfer_lands_after_deactivation', async () => {
  // stream: a transport interruption settling after deactivation must
  // surface as the standard unavailable error with source pey.llm — never
  // the raw transport code with source pey.http.
  const gate = createGate();
  const { service, deactivate } = createService({
    stream: () => makeStreamHandle(() => {}, [], {
      gates: [gate],
      finalEnding: {
        ending: 'interrupted',
        error: { code: 'HTTP_TIMEOUT', message: 'timed out', source: 'pey.http', type: 'operational', timestamp: 't' },
      },
    }),
  });
  service.setSettings(settings());

  const handlePromise = service.stream([userMessage('سلام')], undefined, { onText: () => {} });
  deactivate();
  gate.open();
  const handle = await handlePromise;
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(final.error.source, 'pey.llm');
});

test('should_report_unavailable_when_an_interrupted_complete_settles_after_deactivation', async () => {
  // The fourth combination of the one-rule matrix: a complete whose
  // transport ends interrupted after deactivation — previously the raw
  // HTTP_TIMEOUT with source pey.http leaked through.
  const gate = createGate();
  const { service, deactivate } = createService({
    request: () => ({
      cancel: () => gate.open(),
      done: gate.wait().then(() => ({
        ending: 'interrupted',
        error: { code: 'HTTP_TIMEOUT', message: 'timed out', source: 'pey.http', type: 'operational', timestamp: 't' },
      })),
    }),
  });
  service.setSettings(settings());

  const pending = service.complete([userMessage('سلام')]);
  deactivate();
  gate.open();

  await assert.rejects(
    () => pending,
    (error) => error.code === 'SERVICE_UNAVAILABLE' && error.source === 'pey.llm',
  );
});

test('should_report_unavailable_when_a_non_2xx_stream_settles_after_deactivation', async () => {
  // The other missing combination: a stream settling completed with a 401
  // after deactivation — previously the categorized LLM_UNAUTHORIZED
  // surfaced for a dead plugin.
  const gate = createGate();
  const { service, deactivate } = createService({
    stream: () => makeStreamHandle(() => {}, [], {
      gates: [gate],
      finalEnding: { ending: 'completed', status: 401, headers: {}, body: encode(JSON.stringify({ error: { message: 'nope' } })) },
    }),
  });
  service.setSettings(settings());

  const handlePromise = service.stream([userMessage('سلام')], undefined, { onText: () => {} });
  deactivate();
  gate.open();
  const handle = await handlePromise;
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(final.error.source, 'pey.llm');
});

test('should_report_unavailable_when_the_handler_fails_and_deactivation_lands_before_settlement', async () => {
  // The guard precedes the handlerFailed branch: a throwing onText plus a
  // deactivation in the same window reports the standard unavailable
  // error, never the delivery-shaped handler failure.
  const gate = createGate();
  const { service, deactivate } = createService({
    stream: () => makeStreamHandle(() => {
      throw new Error('handler exploded');
    }, [encode(`data: ${JSON.stringify(deltaEvent('اول'))}\n\n`)], { gates: [gate] }),
  });
  service.setSettings(settings());

  const handlePromise = service.stream([userMessage('سلام')], undefined, { onText: () => {} });
  deactivate();
  gate.open();
  const handle = await handlePromise;
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(final.error.source, 'pey.llm');
});

test('should_end_the_stream_as_unavailable_when_deactivation_lands_before_the_transport_resolves', async () => {
  const gates = [createGate()];
  let resolvedTransport = false;
  const { service, deactivate } = createService({
    stream: (input, handlers) => {
      resolvedTransport = true;
      return makeStreamHandle(handlers, [encode(`data: ${JSON.stringify(deltaEvent('اول'))}\n\n`)], { gates });
    },
  });
  service.setSettings(settings());

  const handlePromise = service.stream([userMessage('سلام')], undefined, { onText: () => {} });
  deactivate();
  gates[0].open();
  void resolvedTransport;
  const handle = await handlePromise;
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SERVICE_UNAVAILABLE', 'no fake completion for a dead plugin');
});

test('should_reject_with_invalid_response_when_a_complete_response_carries_an_unknown_finish_reason', async () => {
  // Round-11 regression: the helper-level rule (normalizeFinishReason
  // throws on an unknown PRESENT reason) must be locked at the SERVICE
  // wiring too — the complete path maps that throw to LLM_INVALID_RESPONSE.
  const { service } = createService({
    request: () => ({ ending: 'completed', status: 200, headers: {}, body: encode(JSON.stringify(completionBody('پاسخ', { finish: 'tool_calls' }))) }),
  });
  service.setSettings(settings());

  const error = await service.complete([userMessage('سلام')]).catch((caught) => caught);
  assert.equal(error?.code, 'LLM_INVALID_RESPONSE');
});

test('should_report_invalid_response_when_a_stream_event_carries_an_unknown_finish_reason', async () => {
  // Round-11 regression: the stream path's unknown-reason handling — the
  // SSE processor marks the stream invalid, the ending is interrupted with
  // LLM_INVALID_RESPONSE, and the text delivered BEFORE the unreadable
  // event stays with the caller (never an ordinary completion).
  const received = [];
  const text = `data: ${JSON.stringify(deltaEvent('متن', { finish_reason: 'tool_calls' }))}\n\ndata: [DONE]\n\n`;
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, [encode(text)]),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: (t) => received.push(t) });
  const final = await handle.done;

  assert.deepEqual(received, ['متن'], 'the text before the unreadable event was delivered');
  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'LLM_INVALID_RESPONSE');
});

test('should_settle_the_end_marker_without_a_trailing_newline_when_the_stream_closes_normally', async () => {
  // Round-11 regression: a final event with no trailing line break (minimal
  // OpenAI-compatible proxies) used to rot in the parser buffer forever —
  // the provider closed the stream normally yet the end marker never
  // landed, reporting an ordinary completion as STREAM_INTERRUPTED. The
  // done path flushes the parser's remainder with one synthetic line break.
  const received = [];
  const text = `data: ${JSON.stringify(deltaEvent('پایان'))}\n\ndata: [DONE]`;
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, [encode(text)]),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: (t) => received.push(t) });
  const final = await handle.done;

  assert.deepEqual(received, ['پایان']);
  assert.equal(final.ending, 'completed', 'the flushed end marker settles the stream normally');
  assert.equal(final.finishReason, 'stop');
});

test('should_split_lines_on_all_three_sse_separators_when_the_provider_uses_cr_only', async () => {
  // Round-11: bare CR is one of the SSE spec's three line terminators — a
  // CR-only stream used to yield ZERO events (nothing was ever split), so
  // even the end marker never landed.
  const received = [];
  const text = `data: ${JSON.stringify(deltaEvent('جدا'))}\r\rdata: [DONE]\r`;
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, [encode(text)]),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: (t) => received.push(t) });
  const final = await handle.done;

  assert.deepEqual(received, ['جدا']);
  assert.equal(final.ending, 'completed');
});

test('should_flush_nothing_after_deactivation_even_when_the_buffer_holds_a_delta', async () => {
  // Round-12 regression: the parser flush ran BEFORE the availability
  // guard, so a deactivation landing in the settle window could push the
  // buffered remainder — a complete text delta — into the caller's
  // handler after the plugin died. The flush now runs after every guard:
  // a dead plugin delivers nothing, and the ending reports unavailable.
  const received = [];
  const gate = createGate();
  const { service, deactivate } = createService({
    stream: (input, handlers) => makeStreamHandle(
      handlers,
      // A buffered delta with NO trailing line break and NO end marker:
      // without the guard reorder, the settle-window flush would have
      // delivered 'دیررس' here.
      [encode(`data: ${JSON.stringify(deltaEvent('دیررس'))}`)],
      { gates: [gate], finalEnding: { ending: 'completed', status: 200, headers: {}, body: new Uint8Array() } },
    ),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, { onText: (text) => received.push(text) });
  deactivate();
  gate.open();
  const final = await handle.done;

  assert.deepEqual(received, [], 'a dead plugin never flushes buffered text into the caller');
  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SERVICE_UNAVAILABLE');
});

test('should_report_request_failed_when_the_handler_throws_on_the_flushed_final_delta', async () => {
  // Round-13 regression: the flush runs AFTER every guard, so a delta it
  // dispatches can be the FIRST delivery to break the handler — the old
  // order checked `handlerFailed` only before the flush, and the ending
  // fell through to STREAM_INTERRUPTED ("closed without an end marker"),
  // blaming the framing for a caller bug.
  const received = [];
  // The second event has NO trailing blank line: only the flush delivers it.
  const chunks = [encode(`data: ${JSON.stringify(deltaEvent('نیمه'))}\n\n`), encode(`data: ${JSON.stringify(deltaEvent('دیررس'))}`)];
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, chunks),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, {
    onText: (t) => {
      if (t === 'دیررس') {
        throw new Error('handler breaks on the final delta');
      }
      received.push(t);
    },
  });
  const final = await handle.done;

  assert.deepEqual(received, ['نیمه']);
  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'LLM_REQUEST_FAILED', 'the handler stop keeps its own code, not a framing fault');
});

test('should_stop_the_stream_and_report_request_failed_when_an_async_handler_rejects_with_no_unhandled_rejection', async () => {
  // Round-15 P1 regression: an ASYNC receiving handler reports its failure
  // as a rejected Promise, not a throw. The wrapper used to discard the
  // return value — every rejection escaped as an unhandledRejection that
  // KILLS the host process under Node's default mode, the transfer carried
  // on delivering deltas, and the stream reported `completed`. A rejected
  // promise now takes the same handler-stop path as a throw.
  const unhandled = [];
  const previousListeners = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (reason) => unhandled.push(reason));
  try {
    const received = [];
    const chunks = [
      encode(`data: ${JSON.stringify(deltaEvent('یک'))}\n\n`),
      encode(`data: ${JSON.stringify(deltaEvent('دو'))}\n\n`),
      encode(`data: ${JSON.stringify(deltaEvent('سه'))}\n\n`),
      encode('data: [DONE]\n\n'),
    ];
    const { service } = createService({
      stream: (input, handlers) => makeStreamHandle(handlers, chunks),
    });
    service.setSettings(settings());

    const handle = await service.stream([userMessage('سلام')], undefined, {
      onText: async () => {
        throw new Error('async handler rejection');
      },
    });
    const final = await handle.done;
    // Let any stray rejection surface before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(received, [], 'a rejecting handler delivers nothing');
    assert.equal(final.ending, 'interrupted');
    assert.equal(final.error.code, 'LLM_REQUEST_FAILED', 'the async handler bug keeps the handler-stop code');
    assert.equal(unhandled.length, 0, 'no unhandledRejection may escape the plugin');
  } finally {
    process.removeAllListeners('unhandledRejection');
    for (const listener of previousListeners) {
      process.on('unhandledRejection', listener);
    }
  }
});

test('should_deliver_exactly_one_delta_when_an_async_handler_rejects_mid_chunk', async () => {
  // Round-16 P1 regression: the round-15 containment landed in a
  // MICROTASK while the parser's stop-guards are synchronous — the
  // remaining deltas of the SAME chunk dispatched before the flag was
  // seen (three calls, three rejections). Deliveries are serialized
  // through a chain now: the second queued delivery stops at its chain
  // step once the first rejection settles. This locks the real call
  // COUNT, which the round-15 test (asserting only the caller-side array)
  // never did.
  const unhandled = [];
  const previousListeners = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (reason) => unhandled.push(reason));
  try {
    let handlerCalls = 0;
    const chunks = [
      encode(`data: ${JSON.stringify(deltaEvent('یک'))}\n\ndata: ${JSON.stringify(deltaEvent('دو'))}\n\ndata: ${JSON.stringify(deltaEvent('سه'))}\n\n`),
      encode('data: [DONE]\n\n'),
    ];
    const { service } = createService({
      stream: (input, handlers) => makeStreamHandle(handlers, chunks),
    });
    service.setSettings(settings());

    const handle = await service.stream([userMessage('سلام')], undefined, {
      onText: async () => {
        handlerCalls += 1;
        throw new Error('async rejection on the first delta');
      },
    });
    const final = await handle.done;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(handlerCalls, 1, 'exactly one delivery — queued deliveries stop after the rejection settles');
    assert.equal(final.ending, 'interrupted');
    assert.equal(final.error.code, 'LLM_REQUEST_FAILED');
    assert.equal(unhandled.length, 0, 'no unhandledRejection may escape the plugin');
  } finally {
    process.removeAllListeners('unhandledRejection');
    for (const listener of previousListeners) {
      process.on('unhandledRejection', listener);
    }
  }
});

test('should_report_request_failed_when_an_async_handler_rejects_on_the_flushed_final_delta', async () => {
  // Round-16 P1 regression: the flush-path re-check is synchronous, but an
  // async handler's flag lands in a microtask — the old order read `false`
  // and the ending leaked as STREAM_INTERRUPTED (a framing verdict on a
  // handler bug), exactly the misreport the round-13 sync fix closed. The
  // done path awaits the delivery chain before re-checking.
  const chunks = [encode(`data: ${JSON.stringify(deltaEvent('نیمه'))}\n\n`), encode(`data: ${JSON.stringify(deltaEvent('دیررس'))}`)];
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, chunks),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, {
    onText: async (text) => {
      if (text === 'دیررس') {
        throw new Error('async rejection on the flushed delta');
      }
    },
  });
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'LLM_REQUEST_FAILED', 'the async handler bug on the flushed delta keeps the handler-stop code');
});

test('should_deliver_nothing_after_the_caller_cancels_when_deltas_are_queued_behind_a_slow_handler', async () => {
  // Round-17 P1 regression: the delivery chain's steps only saw
  // handlerFailed — deltas queued behind a slow async handler were still
  // delivered AFTER the caller cancelled (probe: ['دو','سه'] post-cancel),
  // breaking "no text is delivered after the cancel" (stated three times
  // in the contract). The chain steps see the cancel flag now.
  const received = [];
  let releaseFirst = null;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const chunks = [
    encode(`data: ${JSON.stringify(deltaEvent('اول'))}\n\ndata: ${JSON.stringify(deltaEvent('دوم'))}\n\ndata: ${JSON.stringify(deltaEvent('سوم'))}\n\n`),
    encode('data: [DONE]\n\n'),
  ];
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, chunks),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, {
    onText: async (text) => {
      received.push(text);
      if (text === 'اول') {
        await gate;
      }
    },
  });
  // Deltas two and three are queued behind the parked first delivery.
  await new Promise((resolve) => setImmediate(resolve));
  handle.cancel();
  releaseFirst();
  const final = await handle.done;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, ['اول'], 'only the delta delivered before the cancel reaches the handler');
  assert.equal(final.ending, 'cancelled');
});

test('should_deliver_nothing_after_deactivation_when_deltas_are_queued_behind_a_slow_handler', async () => {
  // Round-17 P1 regression (variant a): the round-12 rule ("a dead plugin
  // never flushes buffered text into the caller's handler") now covers the
  // delivery CHAIN too — deltas queued behind a slow handler are dropped
  // when the plugin dies, and the ending reports the standard unavailable.
  const received = [];
  let releaseFirst = null;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const chunks = [
    encode(`data: ${JSON.stringify(deltaEvent('اول'))}\n\ndata: ${JSON.stringify(deltaEvent('دوم'))}\n\n`),
    encode('data: [DONE]\n\n'),
  ];
  const { service, deactivate } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, chunks),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, {
    onText: async (text) => {
      received.push(text);
      if (text === 'اول') {
        await gate;
      }
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  deactivate();
  releaseFirst();
  const final = await handle.done;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, ['اول'], 'a dead plugin never runs the caller handler');
  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SERVICE_UNAVAILABLE');
});

test('should_report_unavailable_when_deactivation_lands_while_done_waits_on_the_delivery_chain', async () => {
  // Round-17 P1 regression (variant b): the settle window now includes the
  // whole handler processing time — a settlement landing after
  // deactivation reports the standard unavailable error, never a
  // completed ending for a dead plugin.
  const chunks = [
    encode(`data: ${JSON.stringify(deltaEvent('یک'))}\n\ndata: ${JSON.stringify(deltaEvent('دو'))}\n\n`),
    encode('data: [DONE]\n\n'),
  ];
  let releaseSecond = null;
  const gate = new Promise((resolve) => { releaseSecond = resolve; });
  const { service, deactivate } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, chunks),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, {
    onText: async (text) => {
      if (text === 'دو') {
        await gate;
      }
    },
  });
  const donePromise = handle.done;
  // The transport completed; done is parked awaiting the delivery chain.
  await new Promise((resolve) => setImmediate(resolve));
  deactivate();
  releaseSecond();
  const final = await donePromise;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'SERVICE_UNAVAILABLE', 'a settlement after death reports unavailable, never completed');
});

test('should_settle_done_as_cancelled_when_the_handler_never_settles_and_the_caller_cancels', async () => {
  // Round-17 P2 regression: with a never-settling handler promise and a
  // completed transport, `done` used to park on the delivery chain
  // FOREVER — cancel could not reach it. Cancel now breaks the chain wait
  // and settles the ending as cancelled ("done resolves to exactly one of
  // three endings", always).
  const chunks = [encode(`data: ${JSON.stringify(deltaEvent('یک'))}\n\n`), encode('data: [DONE]\n\n')];
  const { service } = createService({
    stream: (input, handlers) => makeStreamHandle(handlers, chunks),
  });
  service.setSettings(settings());

  const handle = await service.stream([userMessage('سلام')], undefined, {
    onText: () => new Promise(() => {}),
  });
  const donePromise = handle.done;
  await new Promise((resolve) => setImmediate(resolve));
  handle.cancel();
  const final = await donePromise;

  assert.equal(final.ending, 'cancelled');
});
