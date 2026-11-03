// Provides the pey.llm service: user connection settings in memory and
// OpenAI-compatible conversation calls over pey.http.
//
// Secrecy shape: the key lives in this module's closure and in outgoing
// Authorization headers only. Message text and the key never enter an
// error, an event, a log or a return value; provider error bodies are
// mapped to categorized codes without leaking raw text. Every call takes
// a snapshot of the settings at its start, so a settings change never
// disturbs an in-flight request.

import {
  CHAT_COMPLETIONS_PATH,
  ERROR_CODES,
  FINISH_REASONS,
  ROLES,
  SERVICE_UNAVAILABLE,
  SETTINGS_EVENT,
} from './constants.js';
import { createLlmError } from './error.js';

const HTTP_STREAM_INTERRUPTED = 'HTTP_STREAM_INTERRUPTED';

/**
 * Publishes an event when the bus exists. Bus failures never fail a call.
 * @param {object} state Service state ({ events }).
 * @param {string} type Event type.
 * @returns {void}
 */
function publish(state, type) {
  try {
    state.events?.publish(type);
  } catch {
    // Event bus issues never fail a service call.
  }
}

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
  if (typeof reason !== 'string') {
    return null;
  }
  return FINISH_REASONS.includes(reason) ? reason : null;
}

/**
 * Creates a streaming SSE parser over decoded text chunks: it splits
 * lines, reads `data:` payloads, and stops at the provider's end marker.
 * @param {object} sink Collector for deltas, finish reason and usage.
 * @returns {(text: string) => void} Text feeder.
 */
function createSseParser(sink) {
  let buffer = '';
  return function feed(text) {
    buffer += text;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (payload.length === 0) {
        continue;
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
        sink.text += delta;
        sink.onText?.(delta);
      }
      const reason = normalizeFinishReason(choice?.finish_reason);
      if (reason !== null) {
        sink.finishReason = reason;
      }
      if (parsed?.usage && typeof parsed.usage === 'object') {
        sink.usage = parsed.usage;
      }
    }
  };
}

/**
 * Creates the LLM service closing over activation-bound references.
 * @param {object} state References ({ http, events }).
 * @returns {{service: object, deactivate: Function}} Service and lifecycle control.
 */
export function createLlmService(state) {
  let settings = null;
  let available = true;
  const activeHandles = new Set();

  function requireHttp() {
    if (!available || !state.http) {
      throw createLlmError(SERVICE_UNAVAILABLE, 'LLM service is unavailable');
    }
    return state.http;
  }

  /**
   * Takes the settings snapshot for one request.
   * @returns {object} Frozen settings snapshot.
   * @throws {object} LLM_NOT_CONFIGURED.
   */
  function snapshotSettings() {
    if (!settings) {
      throw createLlmError(ERROR_CODES.NOT_CONFIGURED, 'No model connection is configured');
    }
    return { ...settings };
  }

  /**
   * Maps one pey.http delivery failure onto the llm boundary: network and
   * timeout keep their transport codes (the caller must tell them apart),
   * a cut stream becomes the llm cut code, anything else is a request
   * failure.
   * @param {object} error Structured transport error.
   * @returns {object} Structured llm error.
   */
  function mapDeliveryError(error) {
    const code = error?.code;
    if (code === 'HTTP_NETWORK_FAILED' || code === 'HTTP_TIMEOUT') {
      return error;
    }
    if (code === HTTP_STREAM_INTERRUPTED) {
      return createLlmError(ERROR_CODES.STREAM_INTERRUPTED, 'The answer stream was cut off before it finished');
    }
    return createLlmError(ERROR_CODES.REQUEST_FAILED, 'The model request could not be delivered');
  }

  /**
   * Tracks one in-flight transfer handle so deactivation can end it.
   * @param {object} handle Transport handle.
   * @returns {Promise<object>} The handle's done result.
   */
  async function supervise(handle) {
    activeHandles.add(handle);
    try {
      return await handle.done;
    } finally {
      activeHandles.delete(handle);
    }
  }

  /**
   * Interprets a finished non-streaming provider response: maps error
   * statuses, validates the shape, extracts text/reason/usage.
   * @param {object} final Completed transport result.
   * @returns {object} { text, finishReason, usage? }.
   * @throws {object} Categorized llm error.
   */
  function interpretCompletion(final) {
    if (final.status < 200 || final.status >= 300) {
      const body = parseJsonBody(final.body);
      throw createLlmError(mapProviderStatus(final.status, body), providerErrorMessage(final.status));
    }
    const parsed = parseJsonBody(final.body);
    if (!parsed) {
      throw createLlmError(ERROR_CODES.INVALID_RESPONSE, 'The provider response could not be understood');
    }
    const choice = parsed?.choices?.[0] ?? null;
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : null;
    if (text === null) {
      throw createLlmError(ERROR_CODES.INVALID_RESPONSE, 'The provider response could not be understood');
    }
    const finishReason = normalizeFinishReason(choice?.finish_reason) ?? 'stop';
    const result = { text, finishReason };
    if (parsed?.usage && typeof parsed.usage === 'object') {
      result.usage = parsed.usage;
    }
    return result;
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

  return {
    service: {
      /**
       * Stores the user's connection settings in memory.
       *
       * @param {object} input { baseUrl, model, apiKey? }.
       * @returns {{ok: boolean, hasApiKey: boolean}} Confirmation.
       * @throws {object} LLM_SETTINGS_INVALID.
       */
      setSettings(input) {
        const normalized = normalizeSettings(input);
        settings = normalized;
        publish(state, SETTINGS_EVENT);
        return { ok: true, hasApiKey: normalized.apiKey !== null };
      },

      /**
       * Erases the stored connection settings.
       *
       * @returns {{ok: boolean}} Confirmation.
       */
      clearSettings() {
        settings = null;
        publish(state, SETTINGS_EVENT);
        return { ok: true };
      },

      /**
       * Reports the settings state without ever exposing the key.
       *
       * @returns {object} { configured, baseUrl, model, hasApiKey }.
       */
      getSettingsStatus() {
        if (!settings) {
          return { configured: false, baseUrl: null, model: null, hasApiKey: false };
        }
        return {
          configured: true,
          baseUrl: settings.baseUrl,
          model: settings.model,
          hasApiKey: settings.apiKey !== null,
        };
      },

      /**
       * Sends the conversation and waits for the full answer.
       *
       * @param {Array} messages Conversation messages.
       * @param {object} [options] { json?, maxTokens?, temperature? }.
       * @returns {Promise<{text: string, finishReason: string, usage?: object}>}
       * @throws {object} Categorized llm error.
       */
      async complete(messages, options) {
        const http = requireHttp();
        const snap = snapshotSettings();
        const body = {
          model: snap.model,
          messages: buildMessages(messages),
          stream: false,
          ...buildOptions(options),
        };
        const handle = await http.request({
          url: conversationUrl(snap.baseUrl),
          method: 'POST',
          headers: requestHeaders(snap),
          body: JSON.stringify(body),
        });
        const final = await supervise(handle);
        if (final.ending === 'cancelled') {
          if (!available) {
            throw createLlmError(SERVICE_UNAVAILABLE, 'LLM service is unavailable');
          }
          throw createLlmError(ERROR_CODES.REQUEST_FAILED, 'The model request was cancelled');
        }
        if (final.ending === 'interrupted') {
          throw mapDeliveryError(final.error);
        }
        return interpretCompletion(final);
      },

      /**
       * Sends the conversation and delivers the answer text progressively.
       *
       * @param {Array} messages Conversation messages.
       * @param {object} [options] { json?, maxTokens?, temperature? }.
       * @param {object} handlers { onText(text) }.
       * @returns {Promise<{cancel: Function, done: Promise<object>}>} Stream handle.
       * @throws {object} Categorized llm error (as a rejection).
       */
      async stream(messages, options, handlers) {
        const http = requireHttp();
        if (!handlers || typeof handlers !== 'object' || typeof handlers.onText !== 'function') {
          throw createLlmError(ERROR_CODES.INPUT_INVALID, 'Streaming needs an onText handler');
        }
        const snap = snapshotSettings();
        const body = {
          model: snap.model,
          messages: buildMessages(messages),
          stream: true,
          ...buildOptions(options),
        };

        const sink = {
          text: '',
          done: false,
          invalid: false,
          finishReason: null,
          usage: null,
          onText: handlers.onText,
        };
        const feed = createSseParser(sink);

        const transport = await http.stream({
          url: conversationUrl(snap.baseUrl),
          method: 'POST',
          headers: requestHeaders(snap),
          body: JSON.stringify(body),
        }, {
          onChunk: (chunk) => {
            // pey.http delivers raw bytes in order; a multi-byte character
            // torn between chunks stays intact through the streaming decoder.
            feed(new TextDecoder().decode(chunk, { stream: true }));
          },
        });

        const final = await supervise(transport);
        if (final.ending === 'cancelled') {
          if (!available) {
            return { ending: 'interrupted', error: createLlmError(SERVICE_UNAVAILABLE, 'LLM service is unavailable') };
          }
          return { ending: 'cancelled' };
        }
        if (final.ending === 'interrupted') {
          if (!available) {
            return { ending: 'interrupted', error: createLlmError(SERVICE_UNAVAILABLE, 'LLM service is unavailable') };
          }
          return { ending: 'interrupted', error: mapDeliveryError(final.error) };
        }
        if (sink.invalid) {
          return {
            ending: 'interrupted',
            error: createLlmError(ERROR_CODES.INVALID_RESPONSE, 'The provider sent an unreadable stream event'),
          };
        }
        // A stream that closed without the provider's end marker is never
        // an ordinary ending.
        if (!sink.done) {
          return {
            ending: 'interrupted',
            error: createLlmError(ERROR_CODES.STREAM_INTERRUPTED, 'The answer stream closed without an end marker'),
          };
        }
        const result = {
          ending: 'completed',
          finishReason: sink.finishReason ?? 'stop',
        };
        if (sink.usage) {
          result.usage = sink.usage;
        }
        return result;
      },
    },

    deactivate() {
      available = false;
      // Ending in-flight transfers keeps deactivation from leaving silent
      // hangs; their endings map to the standard interrupted shape.
      for (const handle of [...activeHandles]) {
        try {
          handle.cancel();
        } catch {
          // An already-settled handle is harmless.
        }
      }
    },
  };
}
