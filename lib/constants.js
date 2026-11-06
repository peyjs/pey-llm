// Shared constants for the pey.llm plugin.

export const PLUGIN_NAME = 'pey.llm';
export const PLUGIN_VERSION = '1.0.0';
export const SERVICE_NAME = 'pey.llm.service';
export const HTTP_SERVICE = 'pey.http.service';
export const SETTINGS_EVENT = 'llm:settings-changed';

export const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'LLM_NOT_CONFIGURED',
  SETTINGS_INVALID: 'LLM_SETTINGS_INVALID',
  INPUT_INVALID: 'LLM_INPUT_INVALID',
  UNAUTHORIZED: 'LLM_UNAUTHORIZED',
  MODEL_NOT_FOUND: 'LLM_MODEL_NOT_FOUND',
  RATE_LIMITED: 'LLM_RATE_LIMITED',
  CONTEXT_TOO_LONG: 'LLM_CONTEXT_TOO_LONG',
  JSON_UNSUPPORTED: 'LLM_JSON_UNSUPPORTED',
  UNSUPPORTED_CONTENT: 'LLM_UNSUPPORTED_CONTENT',
  INVALID_RESPONSE: 'LLM_INVALID_RESPONSE',
  STREAM_INTERRUPTED: 'LLM_STREAM_INTERRUPTED',
  REQUEST_FAILED: 'LLM_REQUEST_FAILED',
});

export const SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE';

// The transport's mid-stream cut code, recognized when mapping delivery
// failures onto the llm boundary.
export const HTTP_STREAM_INTERRUPTED = 'HTTP_STREAM_INTERRUPTED';

// The OpenAI-compatible conversation path appended to the user's base URL.
export const CHAT_COMPLETIONS_PATH = '/chat/completions';

export const ROLES = Object.freeze(['system', 'user', 'assistant']);
export const FINISH_REASONS = Object.freeze(['stop', 'length', 'content_filter']);
