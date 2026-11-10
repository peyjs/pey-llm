# Changelog

## [1.0.2] - 1405-08-17

### Fixed

- The transport's immediate rejections (address policy, validation) now cross the boundary through the delivery mapping (`LLM_REQUEST_FAILED`) instead of leaking undeclared `HTTP_*` codes.
- A deactivation landing while the transport was being resolved cancels the transfer right away, and a stream completing after deactivation reports the standard unavailable error instead of a fake completion.
- The dead `sink.text` accumulation (the answer text was kept for no reader) and the stale `PLUGIN_VERSION` constant are gone; `LLM_SETTINGS_INVALID` is no longer declared for `complete`/`stream` (only `setSettings` throws it); `lib/llm-protocol.js` is listed in the reference structure and exported like the other lib modules.
- The `completed` branch of `complete` now applies the same guard as `stream`: a completion landing after deactivation throws the standard unavailable error instead of returning an ordinary answer for a dead plugin (dedicated gate test added for both timings).
- `tests/llm-protocol.test.js` added: `buildOptions` boundaries, `classifyBadRequest` wording classes, `normalizeFinishReason` and the SSE parser's edge states (partial lines across chunks, empty `data:` lines, unreadable events, finish reason/usage).
- The immediate stream-rejection mapping and the Persian structure line in the reference are covered/cleaned; one test name moved to the `should_..._when_...` convention.

## [1.0.1] - 1405-08-15

### Fixed

- A provider error status on `stream` now maps to its categorized code (`LLM_UNAUTHORIZED`, `LLM_RATE_LIMITED`, …) instead of always reading as a mid-stream cut; the transport delivers non-2xx as an ordinary completed result and the mapping was only wired for `complete`.
- A throwing `onText` handler no longer escapes into the transport's read loop: the transfer stops and the stream ends interrupted with `LLM_REQUEST_FAILED`.
- `LLM_INPUT_INVALID` is declared in the manifest for both methods, closing the manifest/reference mismatch.
- The `core:service-unavailable` subscription is released on shutdown/deactivation (and on a repeated `prepare()`); a missing dependency at activation throws a structured startup error (`REQUIRED_DEPENDENCY_UNAVAILABLE`).
- The pure OpenAI-protocol helpers moved to `lib/llm-protocol.js` (service file down from ~595 lines); the transport stream-interrupted code lives in `constants.js`.

### Tests

- Test fakes replaced real timers with deterministic gates; new tests cover the stream status mapping, the handler-error path, the cancelled `complete` ending, the runtime dependency-loss critical report and the unsubscribe paths; per-source test files added (`error`, `constants`) and `tests/entry.test.js` renamed to `tests/index.test.js` (42 tests). The requirements doc now states explicitly that cancellation is the streaming handle's operation.

## [1.0.0] - 1405-08-13

Initial release: the single provider-facing LLM point for the chat/voice capability stack — in-memory user connection settings (base URL, model, optional key, never persisted, never exposed), OpenAI-compatible `complete` (full answer with finish reason and usage) and `stream` (progressive text through the shared flow pattern with three endings), native-JSON-mode option, minimal sampling options, SSE decoding with a streaming decoder (multi-byte characters survive chunk boundaries), categorized provider-error mapping (`LLM_UNAUTHORIZED`, `LLM_MODEL_NOT_FOUND`, `LLM_RATE_LIMITED`, `LLM_CONTEXT_TOO_LONG`, `LLM_JSON_UNSUPPORTED`, …), per-request settings snapshots, independent cancellation, and the `llm:settings-changed` event. Built on `pey.http` 2.0.0; `docs/requirements.md` (numbered pey format) is the construction source of truth.
