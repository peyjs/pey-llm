# Changelog

## [1.0.0] - 1405-08-13

Review hardening (1405-08-16, still inside this unreleased version):

- A provider error status on `stream` now maps to its categorized code (`LLM_UNAUTHORIZED`, `LLM_RATE_LIMITED`, …) instead of always reading as a mid-stream cut; the transport delivers non-2xx as an ordinary completed result and the mapping was only wired for `complete`.
- A throwing `onText` handler no longer escapes into the transport's read loop: the transfer stops and the stream ends interrupted with `LLM_REQUEST_FAILED`.
- `LLM_INPUT_INVALID` is declared in the manifest for both methods; `LLM_INPUT_INVALID`-related manifest/reference mismatch closed.
- The `core:service-unavailable` subscription is released on shutdown/deactivation (and on a repeated `prepare()`); a missing dependency at activation throws a structured startup error (`REQUIRED_DEPENDENCY_UNAVAILABLE`).
- The pure OpenAI-protocol helpers moved to `lib/llm-protocol.js` (service file down from ~595 lines); the transport stream-interrupted code lives in `constants.js`.
- Test fakes replaced real timers with deterministic gates; new tests cover the stream status mapping, the handler-error path, the cancelled `complete` ending, the runtime dependency-loss critical report and the unsubscribe paths; per-source test files added (`error`, `constants`) and `tests/entry.test.js` renamed to `tests/index.test.js` (42 tests). The requirements doc now states explicitly that cancellation is the streaming handle's operation.

Initial release: the single provider-facing LLM point for the chat/voice capability stack — in-memory user connection settings (base URL, model, optional key, never persisted, never exposed), OpenAI-compatible `complete` (full answer with finish reason and usage) and `stream` (progressive text through the shared flow pattern with three endings), native-JSON-mode option, minimal sampling options, SSE decoding with a streaming decoder (multi-byte characters survive chunk boundaries), categorized provider-error mapping (`LLM_UNAUTHORIZED`, `LLM_MODEL_NOT_FOUND`, `LLM_RATE_LIMITED`, `LLM_CONTEXT_TOO_LONG`, `LLM_JSON_UNSUPPORTED`, …), per-request settings snapshots, independent cancellation, and the `llm:settings-changed` event. Built on `pey.http` 2.0.0; `docs/requirements.md` (numbered pey format) is the construction source of truth.

Initial release: the single provider-facing LLM point for the chat/voice capability stack — in-memory user connection settings (base URL, model, optional key, never persisted, never exposed), OpenAI-compatible `complete` (full answer with finish reason and usage) and `stream` (progressive text through the shared flow pattern with three endings), native-JSON-mode option, minimal sampling options, SSE decoding with a streaming decoder (multi-byte characters survive chunk boundaries), categorized provider-error mapping (`LLM_UNAUTHORIZED`, `LLM_MODEL_NOT_FOUND`, `LLM_RATE_LIMITED`, `LLM_CONTEXT_TOO_LONG`, `LLM_JSON_UNSUPPORTED`, …), per-request settings snapshots, independent cancellation, and the `llm:settings-changed` event. Built on `pey.http` 2.0.0; `docs/requirements.md` (numbered pey format) is the construction source of truth.
