# Changelog

## [1.0.2] - 1405-08-22

### Fixed

- **Delivery lifecycle for async receiving handlers**: `onText` may be async — calls are SERIALIZED (each happens only after the previous result settled, so an async handler applies real backpressure and text order is preserved), a rejection takes the same handler-stop path as a throw (`LLM_REQUEST_FAILED`, no further delivery, no unhandled rejection escaping to kill the host process), a never-settling handler promise is cut by the caller's cancel or by deactivation (both settle a parked `done`), and `done` resolves only after the last delivery settled — across every ending shape, early returns included.
- **SSE framing per spec**: line separators LF, CRLF and bare CR; one event may carry several `data:` lines (joined and dispatched at the blank-line terminator or at the stream's normal close); a payload broken mid-string-literal is honestly refused; unknown present finish reasons map to `LLM_INVALID_RESPONSE` in `complete` and to the interrupted ending in `stream` with the delivered text kept.
- **Settings hardening**: a base URL with a query string or fragment is refused (`LLM_SETTINGS_INVALID`) instead of swallowing the appended `/chat/completions`; a malformed `options.json` flag fails loudly; the settings methods' pre-activation allowance is documented and locked.
- **Structured failures everywhere**: every read of the broken `pey.llm` surface (throwing getters, rejecting `done`, non-standard field values) maps to the declared codes; `SERVICE_UNAVAILABLE` covers any settlement landing after deactivation; the settings error table rows match the code.
- Reference/manifest/requirements sync for all of the above (90 tests).

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
