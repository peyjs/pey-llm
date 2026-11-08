# pey.llm — Reference

Self-contained reference for the `pey.llm` feature plugin. The manifest (`manifest.json`) is always the authoritative contract; this document explains it.

## Purpose

The single point of contact with a large language model provider. It holds the user's connection settings in memory, shapes requests in the OpenAI-compatible chat protocol over `pey.http`, decodes SSE streams, and maps provider errors onto categorized structured codes. If a different provider shape is ever needed, only this plugin changes. It holds no conversation history and no business logic — that belongs to its consumers (e.g. `pey.chat`).

**Why feature, not infrastructure:** the program works without AI. If this plugin fails to start, its dependents deactivate with `REQUIRED_DEPENDENCY_UNAVAILABLE` and the rest of the program keeps working.

## Structure

- `manifest.json` — plugin contract (identity, service, events).
- `index.js` — Bonyan two-phase entry point (`prepare` / `activate`).
- `lib/constants.js` — plugin name, service name, error codes, protocol constants.
- `lib/error.js` — standard Bonyan error factory.
- `lib/llm-protocol.js` — pure OpenAI-protocol helpers (message/body shaping, provider-status error mapping, SSE parsing).
- `lib/llm-service.js` — settings, request shaping, SSE decoding, error mapping.
- `tests/` — unit tests (`node:test`, fake `pey.http` only).

## Dependencies

- **Required:** `pey.http.service` — bound at activation; if it disappears at runtime the plugin reports `REQUIRED_DEPENDENCY_LOST`.
- **Optional:** none.

## Public API

The service `pey.llm.service` provides five methods.

### Settings

#### `setSettings({ baseUrl, model, apiKey? })`

Stores the connection settings in memory (nothing is persisted; closing the app forgets them). `baseUrl` is the address up to the conversation path prefix (e.g. `https://api.openai.com/v1`) — the plugin appends `/chat/completions` itself and tolerates any number of trailing slashes. The key is optional: local models and self-hosted proxies may not need one, and then no Authorization header is sent. Surface validation only: absolute http(s) URL, non-empty model name. Throws `LLM_SETTINGS_INVALID` on bad input. Publishes `llm:settings-changed`.

#### `clearSettings()`

Erases the settings and publishes `llm:settings-changed`.

#### `getSettingsStatus()`

Resolves to `{ configured, baseUrl, model, hasApiKey }`. The key itself never leaves the plugin — not in this result, not in an error, not in an event.

### Conversation

Messages: `[{ role: 'system'|'user'|'assistant', content: [{ type: 'text', text }] }]`. Only text parts exist in this first step; any other part type is rejected with `LLM_UNSUPPORTED_CONTENT` (never silently dropped). Options: `{ json?, maxTokens?, temperature? }` — `json` switches on the provider's **native** JSON mode (`response_format`); validating the returned JSON stays with the caller.

#### `complete(messages, options?)`

Waits for the full answer. Resolves to `{ text, finishReason, usage? }` where `finishReason` is `'stop'` (complete), `'length'` (cut by the length cap) or `'content_filter'` (blocked by the provider). Rejects with a categorized structured error.

#### `stream(messages, options?, { onText })`

Delivers the answer text progressively through `onText` as it arrives — the shared flow pattern: resolves to a handle `{ cancel, done }`; `done` never rejects and resolves exactly one of three endings:

- `{ ending: 'completed', finishReason, usage? }` — the provider's end marker arrived.
- `{ ending: 'interrupted', error }` — network, timeout, a stream cut mid-way, or a stream that closed **without** the end marker (never counted as completed).
- `{ ending: 'cancelled' }` — the caller cancelled; no text is delivered after the cancel.

Raw SSE bytes come from `pey.http` undecoded; a streaming `TextDecoder` reassembles a multi-byte character torn between chunks.

Several calls may run in parallel; each can be cancelled independently. Every call works on a snapshot of the settings taken at its start — changing settings mid-flight never disturbs an in-flight request.

## Events

| Event | Data | When |
|---|---|---|
| `llm:settings-changed` | none | Settings were stored or cleared. |

No message text, no key — the event carries nothing at all.

## Errors Reference

| Code | Situation | Type |
|---|---|---|
| `LLM_NOT_CONFIGURED` | A call was made before any settings exist. | operational |
| `LLM_SETTINGS_INVALID` | Surface-invalid settings (bad URL, empty model, empty key). | operational |
| `LLM_INPUT_INVALID` | Malformed call input (bad message shape, unknown role, missing `onText`, bad option values). | operational |
| `LLM_UNAUTHORIZED` | Provider answered 401/403: the key is invalid or lacks access. | operational |
| `LLM_MODEL_NOT_FOUND` | Provider answered 404, or a 400 says the model does not exist. | operational |
| `LLM_RATE_LIMITED` | Provider answered 429: usage limit or credit exhausted. | operational |
| `LLM_CONTEXT_TOO_LONG` | The provider indicated the input text exceeds the model's limit. | operational |
| `LLM_JSON_UNSUPPORTED` | The provider refused the native JSON mode for this model. | operational |
| `LLM_UNSUPPORTED_CONTENT` | A message carried a non-text content part. | operational |
| `LLM_INVALID_RESPONSE` | The provider response (or a stream event) could not be understood. | operational |
| `LLM_STREAM_INTERRUPTED` | The stream was cut mid-way or closed without the end marker. | operational |
| `LLM_REQUEST_FAILED` | Any other provider refusal or delivery failure. | operational |
| `HTTP_NETWORK_FAILED` / `HTTP_TIMEOUT` | Passed through unchanged from `pey.http` — the caller must tell connection loss and timeouts apart. | operational |
| `SERVICE_UNAVAILABLE` | Called before activation or after deactivation/shutdown; an in-flight stream ends interrupted with this code. | operational |

Error messages are fixed and safe: no key, no message text, no raw provider output — not even in details. Branch on `code`, never on `message`.

## Config

None. Address, model and key come from the user at runtime, not from plugin configuration.

## Business Rules

- The key lives only in this plugin's memory and in outgoing Authorization headers — never in events, errors, logs or return values.
- No default model, address or key exists; the user's connection is the user's own.
- Provider error bodies are consumed only to pick the category; their raw text never leaves the plugin.
- JSON mode uses the provider's native capability only — no prompt manipulation — and result validation stays with the caller.
- A stream without the provider's end marker is interrupted, never completed; after a cancel no text is delivered.
- Startup sends nothing; the plugin never retries or fails over automatically.

## Constraints

- Only the OpenAI-compatible protocol in this step; other provider shapes are out of scope.
- Do not use this service for conversation history — it is stateless by design.
- Settings are memory-only by decision: persistent (encrypted) key storage needs an explicit later decision.
