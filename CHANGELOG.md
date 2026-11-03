# Changelog

## [1.0.0] - 1405-08-13

Initial release: the single provider-facing LLM point for the chat/voice capability stack — in-memory user connection settings (base URL, model, optional key, never persisted, never exposed), OpenAI-compatible `complete` (full answer with finish reason and usage) and `stream` (progressive text through the shared flow pattern with three endings), native-JSON-mode option, minimal sampling options, SSE decoding with a streaming decoder (multi-byte characters survive chunk boundaries), categorized provider-error mapping (`LLM_UNAUTHORIZED`, `LLM_MODEL_NOT_FOUND`, `LLM_RATE_LIMITED`, `LLM_CONTEXT_TOO_LONG`, `LLM_JSON_UNSUPPORTED`, …), per-request settings snapshots, independent cancellation, and the `llm:settings-changed` event. Built on `pey.http` 2.0.0; `docs/requirements.md` (numbered pey format) is the construction source of truth.
