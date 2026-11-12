// Pure OpenAI-protocol helpers for the pey.llm plugin.
//
// Everything here is deterministic and I/O-free: URL joining, wire-shaping
// of messages/options, provider error classification and the streaming SSE
// parser. Secrecy shape: none of these functions ever log or return the
// API key; provider error text is consumed only for classification.

import {
  CHAT_COMPLETIONS_PATH,
  ERROR_CODES,
  FINISH_REASONS,
  ROLES,
} from './constants.js';
import { createLlmError } from './error.js';

/**
 * Joins the user's base URL with the conversation path, tolerating any
 * number of trailing slashes on the base URL.
 * @param {string} baseUrl User-provided base URL.
 * @returns {string} Conversation endpoint URL.
 */
function conversationUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}${CHAT_COMPLETIONS_PATH}`;
}

/**
 * Builds the outgoing headers for one request: JSON content type plus the
 * Authorization header only when a key exists.
 * @param {object} snap Settings snapshot.
 * @returns {object} Headers.
 */
function requestHeaders(snap) {
  const headers = { 'content-type': 'application/json' };
  if (snap.apiKey !== null) {
    headers.authorization = `Bearer ${snap.apiKey}`;
  }
  return headers;
}

/**
 * Validates the surface shape of user-provided connection settings.
 * @param {unknown} raw Input.
 * @returns {object} Normalized settings.
 * @throws {object} LLM_SETTINGS_INVALID.
 */
function normalizeSettings(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw createLlmError(ERROR_CODES.SETTINGS_INVALID, 'Connection settings must be an object');
  }
  const { baseUrl, model, apiKey } = raw;
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw createLlmError(ERROR_CODES.SETTINGS_INVALID, 'The base URL must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw createLlmError(ERROR_CODES.SETTINGS_INVALID, 'The base URL must be a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createLlmError(ERROR_CODES.SETTINGS_INVALID, 'The base URL must be an http or https address');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    // The conversation path is appended after the base URL: a query or
    // fragment would swallow `/chat/completions` into itself and send every
    // request to the wrong address — reject the shape at save time, while
    // the settings dialog can still point at the field.
    throw createLlmError(ERROR_CODES.SETTINGS_INVALID, 'The base URL must not carry a query string or a fragment');
  }
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw createLlmError(ERROR_CODES.SETTINGS_INVALID, 'The model name must be a non-empty string');
  }
  if (apiKey !== undefined && apiKey !== null && (typeof apiKey !== 'string' || apiKey.length === 0)) {
    throw createLlmError(ERROR_CODES.SETTINGS_INVALID, 'The API key must be a non-empty string when given');
  }
  return {
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    apiKey: typeof apiKey === 'string' ? apiKey : null,
  };
}

/**
 * Validates the message list and shapes it into the OpenAI wire format.
 * Only text content parts exist in this first step; anything else is an
 * explicit error, never silently dropped.
 * @param {unknown} raw Caller messages.
 * @returns {Array} Wire messages.
 * @throws {object} LLM_INPUT_INVALID / LLM_UNSUPPORTED_CONTENT.
 */
function buildMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw createLlmError(ERROR_CODES.INPUT_INVALID, 'A non-empty message list is required');
  }
  const messages = [];
  for (const message of raw) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw createLlmError(ERROR_CODES.INPUT_INVALID, 'Each message must be an object');
    }
    if (!ROLES.includes(message.role)) {
      throw createLlmError(ERROR_CODES.INPUT_INVALID, 'Each message needs a system, user or assistant role');
    }
    if (!Array.isArray(message.content)) {
      throw createLlmError(ERROR_CODES.INPUT_INVALID, 'Message content must be a list of parts');
    }
    const parts = [];
    for (const part of message.content) {
      if (part === null || typeof part !== 'object') {
        throw createLlmError(ERROR_CODES.INPUT_INVALID, 'Each content part must be an object');
      }
      if (part.type !== 'text') {
        throw createLlmError(ERROR_CODES.UNSUPPORTED_CONTENT, 'Only text content parts are supported in this step');
      }
      if (typeof part.text !== 'string') {
        throw createLlmError(ERROR_CODES.INPUT_INVALID, 'A text part needs string text');
      }
      parts.push({ type: 'text', text: part.text });
    }
    if (parts.length === 0) {
      throw createLlmError(ERROR_CODES.INPUT_INVALID, 'A message needs at least one content part');
    }
    messages.push({ role: message.role, content: parts });
  }
  return messages;
}

/**
 * Builds the request body options: native JSON mode when asked, plus the
 * optional sampling knobs.
 * @param {object} options Caller options.
 * @returns {object} Body fragment.
 * @throws {object} LLM_INPUT_INVALID.
 */
function buildOptions(options) {
  const body = {};
  if (options === undefined || options === null) {
    return body;
  }
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw createLlmError(ERROR_CODES.INPUT_INVALID, 'Call options must be an object');
  }
  if (options.json !== undefined && options.json !== null && typeof options.json !== 'boolean') {
    // Same fail-loud policy as maxTokens/temperature: a malformed flag must
    // not silently switch JSON mode off and hand the caller raw text.
    throw createLlmError(ERROR_CODES.INPUT_INVALID, 'json must be a boolean');
  }
  if (options.json === true) {
    body.response_format = { type: 'json_object' };
  }
  if (options.maxTokens !== undefined && options.maxTokens !== null) {
    if (!Number.isFinite(options.maxTokens) || options.maxTokens <= 0) {
      throw createLlmError(ERROR_CODES.INPUT_INVALID, 'maxTokens must be a positive number');
    }
    body.max_tokens = options.maxTokens;
  }
  if (options.temperature !== undefined && options.temperature !== null) {
    if (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2) {
      throw createLlmError(ERROR_CODES.INPUT_INVALID, 'temperature must be a number between 0 and 2');
    }
    body.temperature = options.temperature;
  }
  return body;
}

/**
 * Decides whether a 400 provider response says "JSON mode unsupported" or
 * "input too long" or "model unknown", from its best-effort parsed body.
 * @param {object|null} body Parsed provider error body, or null.
 * @returns {string} LLM error code.
 */
function classifyBadRequest(body) {
  const text = typeof body?.error?.message === 'string' ? body.error.message.toLowerCase() : '';
  if (text.includes('response_format') || text.includes('json mode') || text.includes('json_object')) {
    return ERROR_CODES.JSON_UNSUPPORTED;
  }
  if (text.includes('context length') || text.includes('maximum context')
    || text.includes('too many tokens') || text.includes('input is too long')
    || text.includes('too large')) {
    return ERROR_CODES.CONTEXT_TOO_LONG;
  }
  if (text.includes('does not exist') || text.includes('unknown model') || text.includes('model not found')) {
    return ERROR_CODES.MODEL_NOT_FOUND;
  }
  return ERROR_CODES.REQUEST_FAILED;
}

/**
 * Maps one non-2xx provider status to the categorized LLM error code.
 * @param {number} status Provider HTTP status.
 * @param {object|null} body Best-effort parsed provider error body.
 * @returns {string} LLM error code.
 */
function mapProviderStatus(status, body) {
  if (status === 401 || status === 403) {
    return ERROR_CODES.UNAUTHORIZED;
  }
  if (status === 404) {
    return ERROR_CODES.MODEL_NOT_FOUND;
  }
  if (status === 429) {
    return ERROR_CODES.RATE_LIMITED;
  }
  if (status === 400) {
    return classifyBadRequest(body);
  }
  return ERROR_CODES.REQUEST_FAILED;
}

/**
 * Parses a response body as JSON, tolerating empty bodies.
 * @param {Uint8Array} body Raw response bytes.
 * @returns {object|null} Parsed body, or null when undecodable.
 */
function parseJsonBody(body) {
  try {
    const text = new TextDecoder().decode(body ?? new Uint8Array());
    if (text.trim().length === 0) {
      return null;
    }
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Normalizes a provider finish reason to the documented set.
 * @param {unknown} reason Raw finish reason.
 * @returns {string|null} Normalized reason, or null when absent.
 */
function normalizeFinishReason(reason) {
  if (reason === undefined || reason === null) {
    return null;
  }
  if (FINISH_REASONS.includes(reason)) {
    return reason;
  }
  // A PRESENT but unknown reason (a proxy's custom string, an unforwarded
  // tool_calls-like signal) is an unreadable response — never silently a
  // "stop", which would dress provider data the plugin cannot understand up
  // as an ordinary completion.
  throw createLlmError(ERROR_CODES.INVALID_RESPONSE, 'The provider response could not be understood');
}

/**
 * Creates a streaming SSE parser over decoded text chunks: it splits
 * lines, accumulates each event's `data:` fields, and dispatches the event
 * at its blank-line terminator (the SSE dispatch rule) — a provider
 * breaking one JSON payload across SEVERAL `data:` lines is therefore one
 * readable event, not an unreadable stream. The SSE line separators are
 * CRLF, LF and bare CR — all three are honored; a trailing lone `\r` is
 * HELD in the buffer because it may be the first half of a CRLF pair the
 * next chunk completes. A final event with NO trailing line break is
 * settled by the service feeding one synthetic `\n` at a normal close
 * (see the stream's done path) — without it the end marker rotted in the
 * buffer forever and a stream the provider closed normally reported as
 * interrupted.
 * @param {object} sink Collector for deltas, finish reason and usage.
 * @returns {(text: string) => void} Text feeder.
 */
function createSseParser(sink) {
  let buffer = '';
  let dataLines = [];
  // Dispatches one accumulated event: the `data:` lines join with `\n`
  // (the SSE rule), then the joined payload is trimmed so a single-line
  // event behaves exactly like every release before the accumulation.
  const dispatchEvent = () => {
    if (sink.done || sink.invalid || dataLines.length === 0) {
      dataLines = [];
      return;
    }
    const payload = dataLines.join('\n').trim();
    dataLines = [];
    if (payload.length === 0) {
      return;
    }
    if (payload === '[DONE]') {
      sink.done = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      sink.invalid = true;
      return;
    }
    const choice = parsed?.choices?.[0] ?? null;
    const delta = typeof choice?.delta?.content === 'string' ? choice.delta.content : '';
    if (delta.length > 0) {
      sink.onText?.(delta);
    }
    let reason;
    try {
      reason = normalizeFinishReason(choice?.finish_reason);
    } catch {
      // An unknown PRESENT finish string is an unreadable response: the
      // same structured path as any other unreadable stream event —
      // never a silent "stop".
      sink.invalid = true;
      return;
    }
    if (reason !== null) {
      sink.finishReason = reason;
    }
    if (parsed?.usage && typeof parsed.usage === 'object') {
      sink.usage = parsed.usage;
    }
  };
  const processLine = (line) => {
    // handlerFailed (round 13) joins the decided-ending guards: once the
    // receiving handler threw, every remaining event of the SAME chunk
    // (and any chunk already in flight) must stop being parsed and
    // delivered — the transfer is cancelled, but cancel takes effect on
    // the transport, not on text still queued in the parser.
    if (sink.done || sink.invalid || sink.handlerFailed) {
      return;
    }
    if (line === '') {
      // The event terminator: what accumulated dispatches now.
      dispatchEvent();
      return;
    }
    if (line.startsWith('data:')) {
      // Field value: everything after the colon, minus ONE leading space
      // (the SSE rule); the join/trim happens at dispatch. An EMPTY data
      // field is separator noise in OpenAI-compatible streams and is
      // ignored, as in every release before the accumulation model.
      const value = line.slice(5).replace(/^ /, '');
      if (value.length > 0) {
        dataLines.push(value);
      }
    }
    // Other field names (`event:`, `id:`, `retry:`) carry nothing this
    // plugin consumes and are ignored, as before.
  };
  const feed = function feed(text) {
    // The ending is already decided once the end marker arrived, an event
    // proved unreadable, or the receiving handler threw (round 13); late
    // chunks change nothing.
    if (sink.done || sink.invalid || sink.handlerFailed) {
      return;
    }
    buffer += text;
    const holdCarriage = buffer.endsWith('\r');
    let work = holdCarriage ? buffer.slice(0, -1) : buffer;
    // Normalize the three separators to LF for the split loop.
    work = work.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let newlineIndex;
    while ((newlineIndex = work.indexOf('\n')) !== -1) {
      const line = work.slice(0, newlineIndex);
      work = work.slice(newlineIndex + 1);
      processLine(line);
      if (sink.done || sink.invalid || sink.handlerFailed) {
        // Nothing after a decided ending (or a broken handler) is consumed.
        work = '';
        break;
      }
    }
    buffer = work + (holdCarriage && !sink.done && !sink.invalid && !sink.handlerFailed ? '\r' : '');
  };
  // The stream's EOF is an event terminator too (the SSE spec dispatches
  // the pending event at stream end): two synthetic line breaks settle any
  // held CR, the buffered final line and the pending event in one call.
  // The service calls this on a normal close (after its availability
  // guard) — a dead plugin never flushes text into a caller handler.
  feed.flush = () => {
    if (!sink.done && !sink.invalid) {
      feed('\n\n');
    }
  };
  return feed;
}

/**
 * Fixed, provider-text-free message per status class.
 * @param {number} status Provider HTTP status.
 * @returns {string} Safe message.
 */
function providerErrorMessage(status) {
  if (status === 401 || status === 403) {
    return 'The provider rejected the credentials or the access level';
  }
  if (status === 404) {
    return 'The provider does not know this model or address';
  }
  if (status === 429) {
    return 'The provider refused the request over usage limits';
  }
  return 'The provider refused the request';
}

export {
  buildMessages,
  buildOptions,
  classifyBadRequest,
  conversationUrl,
  createSseParser,
  mapProviderStatus,
  normalizeFinishReason,
  normalizeSettings,
  parseJsonBody,
  providerErrorMessage,
  requestHeaders,
};
