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
  ERROR_CODES,
  HTTP_STREAM_INTERRUPTED,
  SERVICE_UNAVAILABLE,
  SETTINGS_EVENT,
} from './constants.js';
import { createLlmError } from './error.js';
import {
  buildMessages,
  buildOptions,
  conversationUrl,
  createSseParser,
  mapProviderStatus,
  normalizeFinishReason,
  normalizeSettings,
  parseJsonBody,
  providerErrorMessage,
  requestHeaders,
} from './llm-protocol.js';

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
        // The transport can reject before any transfer runs (validation,
        // address policy): that rejection is a delivery failure and crosses
        // the boundary through the same mapping as every other one.
        let handle;
        try {
          handle = await http.request({
            url: conversationUrl(snap.baseUrl),
            method: 'POST',
            headers: requestHeaders(snap),
            body: JSON.stringify(body),
          });
        } catch (error) {
          throw mapDeliveryError(error);
        }
        // A deactivation landing while the transport was being obtained
        // must end the transfer immediately (the handle is registered by
        // supervise, but only it can cancel — do so right away).
        if (!available) {
          handle.cancel();
        }
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

        let transport = null;
        let handlerFailed = false;
        const sink = {
          done: false,
          invalid: false,
          finishReason: null,
          usage: null,
          onText: (text) => {
            // A broken receiving handler must not escape into the
            // transport's read loop: stop the transfer and let the done
            // path report the interruption with its own stage.
            try {
              handlers.onText(text);
            } catch {
              handlerFailed = true;
              transport?.cancel();
            }
          },
        };
        const feed = createSseParser(sink);
        // One streaming decoder per stream: it carries incomplete multi-byte
        // characters from one chunk to the next.
        const decoder = new TextDecoder();

        // Same boundary rule as complete: the transport's immediate
        // rejections cross through the delivery mapping, and a deactivation
        // landing in this window cancels the transfer right away.
        try {
          transport = await http.stream({
            url: conversationUrl(snap.baseUrl),
            method: 'POST',
            headers: requestHeaders(snap),
            body: JSON.stringify(body),
          }, {
            onChunk: (chunk) => {
              // pey.http delivers raw bytes in order; a multi-byte character
              // torn between chunks stays intact through the streaming decoder.
              feed(decoder.decode(chunk, { stream: true }));
            },
          });
        } catch (error) {
          throw mapDeliveryError(error);
        }
        if (!available) {
          transport.cancel();
        }

        return {
          cancel: () => transport.cancel(),
          done: (async () => {
            const final = await supervise(transport);
            if (handlerFailed) {
              return {
                ending: 'interrupted',
                error: createLlmError(ERROR_CODES.REQUEST_FAILED, 'The answer stream was stopped by the receiving handler'),
              };
            }
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
            // The transport delivers a provider error status as an ordinary
            // completed result; the categorized code must survive into the
            // stream ending instead of reading as a mid-stream cut.
            if (final.status < 200 || final.status >= 300) {
              const errorBody = parseJsonBody(final.body);
              return {
                ending: 'interrupted',
                error: createLlmError(mapProviderStatus(final.status, errorBody), providerErrorMessage(final.status)),
              };
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
            if (!available) {
              // Deactivation landed while the provider was finishing: the
              // contract code is the standard unavailable error, never a
              // fake completion for a dead plugin.
              return { ending: 'interrupted', error: createLlmError(SERVICE_UNAVAILABLE, 'LLM service is unavailable') };
            }
            const result = {
              ending: 'completed',
              finishReason: sink.finishReason ?? 'stop',
            };
            if (sink.usage) {
              result.usage = sink.usage;
            }
            return result;
          })(),
        };
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
