# pey.llm

[![AI](https://img.shields.io/badge/Built%20with-AI-blueviolet)](#)
[![version](https://img.shields.io/badge/version-1.0.2-blue.svg)](#)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Bonyan Architecture](https://img.shields.io/badge/bonyan-0.11-56c3bf)](https://github.com/barnevis/bonyan)

## Purpose

Feature plugin of the Pey ecosystem: the single point of contact with an OpenAI-compatible LLM provider. Holds the user's connection settings in memory (base URL, model, optional key), shapes complete and streaming conversation calls over `pey.http`, and maps provider errors onto categorized structured codes. The API key never leaves the plugin's memory.

## Structure

- `docs/requirements.md` — requirements; the construction source of truth.
- `manifest.json` — plugin contract (identity, service, events).
- `index.js` — Bonyan two-phase entry point (`prepare` / `activate`).
- `lib/constants.js` — plugin names, error codes, protocol constants.
- `lib/error.js` — standard Bonyan error factory.
- `lib/llm-protocol.js` — pure OpenAI-protocol helpers (message/body shaping, provider-status error mapping, SSE parsing).
- `lib/llm-service.js` — settings, request shaping, SSE decoding, error mapping.
- `tests/` — unit tests (`node:test`, fake transport only).

## Dependencies

- **Required:** `pey.http` (`pey.http.service`).
- **Optional:** none.

## See Also

- [docs/requirements.md](docs/requirements.md) for the "what and why", written before the implementation.
- [docs/reference.md](docs/reference.md) for the full API, events, errors, business rules, and constraints.
