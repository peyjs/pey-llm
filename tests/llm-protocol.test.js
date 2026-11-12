// Unit tests for lib/llm-protocol.js — the pure OpenAI-protocol helpers:
// option building, 400 classification, finish-reason normalization and the
// SSE parser's edge states. The service tests cover them only incidentally;
// these rules get their own gate here.

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOptions, classifyBadRequest, createSseParser, normalizeFinishReason } from '../lib/llm-protocol.js';
import { ERROR_CODES, FINISH_REASONS } from '../lib/constants.js';

// --- buildOptions ---------------------------------------------------------

test('should_return_an_empty_body_when_options_are_absent', () => {
  assert.deepEqual(buildOptions(undefined), {});
  assert.deepEqual(buildOptions(null), {});
  assert.deepEqual(buildOptions({}), {});
});

test('should_refuse_non_object_options_when_options_are_not_an_object', () => {
  for (const bad of ['json', 42, []]) {
    assert.throws(() => buildOptions(bad), (error) => error.code === ERROR_CODES.INPUT_INVALID);
  }
});

test('should_map_json_mode_to_the_response_format_when_requested', () => {
  assert.deepEqual(buildOptions({ json: true }), { response_format: { type: 'json_object' } });
  // A malformed flag is a loud input error like maxTokens/temperature — a
  // silent "off" would hand the caller raw text instead of JSON.
  for (const bad of ['yes', 1, { deep: true }]) {
    assert.throws(
      () => buildOptions({ json: bad }),
      (error) => error.code === 'LLM_INPUT_INVALID',
    );
  }
  assert.deepEqual(buildOptions({ json: false }), {});
});

test('should_reject_invalid_max_tokens_and_temperature_when_out_of_range', () => {
  for (const bad of [0, -1, 'x', Infinity]) {
    assert.throws(() => buildOptions({ maxTokens: bad }), (error) => error.code === ERROR_CODES.INPUT_INVALID);
  }
  for (const bad of [-0.1, 2.1, 'warm']) {
    assert.throws(() => buildOptions({ temperature: bad }), (error) => error.code === ERROR_CODES.INPUT_INVALID);
  }
  assert.deepEqual(buildOptions({ maxTokens: 100, temperature: 2 }), { max_tokens: 100, temperature: 2 });
});

// --- classifyBadRequest ---------------------------------------------------

test('should_classify_json_mode_failures_when_the_provider_message_names_json_mode', () => {
  assert.equal(classifyBadRequest({ error: { message: 'response_format is not supported' } }), ERROR_CODES.JSON_UNSUPPORTED);
  assert.equal(classifyBadRequest({ error: { message: 'JSON mode unavailable' } }), ERROR_CODES.JSON_UNSUPPORTED);
});

test('should_classify_context_and_model_failures_when_the_provider_message_names_them', () => {
  assert.equal(classifyBadRequest({ error: { message: 'context length exceeded' } }), ERROR_CODES.CONTEXT_TOO_LONG);
  assert.equal(classifyBadRequest({ error: { message: 'Input is too long for this model' } }), ERROR_CODES.CONTEXT_TOO_LONG);
  assert.equal(classifyBadRequest({ error: { message: 'The model does not exist' } }), ERROR_CODES.MODEL_NOT_FOUND);
  assert.equal(classifyBadRequest({ error: { message: 'unknown model: x' } }), ERROR_CODES.MODEL_NOT_FOUND);
});

test('should_fall_back_to_request_failed_when_the_400_body_is_unreadable', () => {
  assert.equal(classifyBadRequest(null), ERROR_CODES.REQUEST_FAILED);
  assert.equal(classifyBadRequest({}), ERROR_CODES.REQUEST_FAILED);
  assert.equal(classifyBadRequest({ error: { message: 'something else' } }), ERROR_CODES.REQUEST_FAILED);
});

// --- normalizeFinishReason ------------------------------------------------

test('should_pass_declared_finish_reasons_through_when_reading_and_null_absence', () => {
  for (const reason of FINISH_REASONS) {
    assert.equal(normalizeFinishReason(reason), reason);
  }
  // Absence defaults downstream to 'stop'; any PRESENT value outside the
  // declared set (an unknown string or garbage) is an unreadable response
  // and throws instead (round 10).
  assert.equal(normalizeFinishReason(undefined), null);
  assert.equal(normalizeFinishReason(null), null);
  assert.throws(
    () => normalizeFinishReason('weird_reason'),
    (error) => error.code === 'LLM_INVALID_RESPONSE',
  );
  assert.throws(
    () => normalizeFinishReason(42),
    (error) => error.code === 'LLM_INVALID_RESPONSE',
  );
});

// --- createSseParser ------------------------------------------------------

function makeSink() {
  const sink = { texts: [] };
  sink.onText = (text) => sink.texts.push(text);
  return sink;
}

test('should_feed_deltas_across_chunk_boundaries_when_chunks_carry_partial_lines_until_the_end_marker', () => {
  const sink = makeSink();
  const feed = createSseParser(sink);

  feed('data: {"choices":[{"delta":{"content":"س"}}]}\n\ndata: {"choices":[{"del');
  feed('ta":{"content":"وم"}}]}\n\ndata: [DONE]\n\n');
  feed('data: {"choices":[{"delta":{"content":"دیررس"}}]}\n\n');

  assert.deepEqual(sink.texts, ['س', 'وم'], 'a partial line is completed from the next chunk');
  assert.equal(sink.done, true, 'the end marker closes the parser');
});

test('should_ignore_empty_data_lines_when_the_payload_is_blank', () => {
  const sink = makeSink();
  const feed = createSseParser(sink);

  feed('data:\n\ndata: {"choices":[{"delta":{"content":"سلام"}}]}\n\ndata: \ndata: [DONE]\n\n');

  assert.deepEqual(sink.texts, ['سلام']);
  assert.equal(sink.done, true);
});

test('should_mark_the_stream_invalid_when_an_event_is_unreadable', () => {
  const sink = makeSink();
  const feed = createSseParser(sink);

  feed('data: not-json\n\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\n');

  assert.equal(sink.invalid, true, 'the unparseable event invalidates the stream');
  assert.deepEqual(sink.texts, [], 'nothing after an invalid event is consumed');
});

test('should_carry_the_finish_reason_and_usage_when_the_provider_sends_them', () => {
  const sink = makeSink();
  const feed = createSseParser(sink);

  feed('data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"total_tokens":7}}\n\ndata: [DONE]\n\n');

  assert.equal(sink.finishReason, 'length');
  assert.deepEqual(sink.usage, { total_tokens: 7 });
  assert.equal(sink.done, true);
});

test('should_join_multi_line_data_fields_into_one_event_when_the_event_terminates', () => {
  // Round-12: the SSE spec lets one event carry SEVERAL `data:` lines,
  // joined with `\n` and dispatched at the blank-line terminator. The old
  // line-at-a-time parser parsed each line alone — a provider splitting
  // one JSON payload across two lines invalidated the WHOLE stream.
  const sink = makeSink();
  const feed = createSseParser(sink);
  const event = { choices: [{ delta: { content: 'چندسطری' } }], usage: { total_tokens: 3 } };
  const json = JSON.stringify(event);
  // The split point must be a TOP-LEVEL boundary: a newline inside a JSON
  // string literal is invalid JSON, and the SSE join would (correctly)
  // refuse a provider that breaks its payload mid-literal.
  const cut = json.indexOf('"usage"');

  feed(`data: ${json.slice(0, cut)}\ndata: ${json.slice(cut)}\n\ndata: [DONE]\n\n`);

  assert.deepEqual(sink.texts, ['چندسطری'], 'the joined payload parses as one event');
  assert.deepEqual(sink.usage, { total_tokens: 3 });
  assert.equal(sink.invalid, undefined, 'the stream is never marked unreadable');
  assert.equal(sink.done, true);
});

test('should_dispatch_the_pending_event_at_stream_end_when_flush_is_called', () => {
  // EOF is an event terminator too: a final event with no trailing blank
  // line still dispatches through the flush the service calls at a normal
  // close — including a final line held behind a lone trailing CR.
  const sink = makeSink();
  const feed = createSseParser(sink);

  feed(`data: ${JSON.stringify({ choices: [{ delta: { content: 'پایان' } }] })}\r\n\r\ndata: [DONE]\r`);
  assert.equal(sink.done, undefined, 'nothing dispatches before the terminator');
  feed.flush();

  assert.deepEqual(sink.texts, ['پایان']);
  assert.equal(sink.done, true);
});

test('should_stop_dispatching_within_the_same_feed_when_the_handler_throws_on_the_first_delta', () => {
  // Round-14: the round-13 version of this test set `handlerFailed` BY HAND
  // before feeding, so only the entry guard was exercised and the REAL
  // scenario (the wrapper's catch sets the flag MID-DISPATCH, and the
  // remaining events of the same chunk must not be parsed or delivered)
  // had no locking test. This is the real path: a throwing onText wrapped
  // exactly like the service wraps it, on a three-delta chunk.
  const sink = makeSink();
  let calls = 0;
  sink.onText = (text) => {
    try {
      calls += 1;
      if (calls === 1) {
        throw new Error('handler gave up');
      }
      void text;
    } catch {
      sink.handlerFailed = true;
    }
  };
  const feed = createSseParser(sink);
  const delta = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

  feed(`${delta('یک')}${delta('دو')}${delta('سه')}`);
  assert.equal(calls, 1, 'exactly one delivery — the remaining deltas of the chunk never dispatch');
});
