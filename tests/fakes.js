// Shared fakes for the pey.llm tests: a fake pey.http service (never a
// real network) and OpenAI-shaped payload builders.

export function encode(text) {
  return new TextEncoder().encode(text);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deltaEvent(text, extra = {}) {
  return { choices: [{ delta: { content: text }, ...extra }] };
}

export function completionBody(content, { finish = 'stop', usage } = {}) {
  return {
    choices: [{ message: { content }, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

export function errorBody(message) {
  return { error: { message } };
}

export function sseChunks(events, endMarker = true) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    + (endMarker ? 'data: [DONE]\n\n' : '');
  return [encode(text)];
}

/**
 * Builds a fake stream handle that feeds byte chunks through the
 * captured onChunk handler, honoring cancellation like a real body
 * reader would.
 */
export function makeStreamHandle(handlers, byteChunks, { delayMs = 0, finalEnding } = {}) {
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    done: (async () => {
      for (const chunk of byteChunks) {
        await sleep(delayMs);
        if (cancelled) {
          return { ending: 'cancelled' };
        }
        handlers.onChunk(chunk);
      }
      if (cancelled) {
        return { ending: 'cancelled' };
      }
      return finalEnding ?? { ending: 'completed', status: 200, headers: {} };
    })(),
  };
}

/**
 * Creates a fake pey.http service. `map.request(input)` returns the
 * final transport result for plain requests; `map.stream(input, handlers)`
 * may return a custom handle (from makeStreamHandle) — otherwise raw
 * `map.streamChunks` (when given) or a default completed SSE stream is
 * delivered.
 */
export function createFakeHttp(map = {}) {
  const calls = [];
  const http = {
    calls,
    async request(input) {
      calls.push({ kind: 'request', input });
      const outcome = map.request
        ? map.request(input)
        : { ending: 'completed', status: 200, headers: {}, body: encode(JSON.stringify(completionBody('پاسخ'))) };
      return { cancel: () => {}, done: Promise.resolve(outcome) };
    },
    async stream(input, handlers) {
      calls.push({ kind: 'stream', input });
      if (map.stream) {
        return map.stream(input, handlers);
      }
      return makeStreamHandle(handlers, map.streamChunks ?? sseChunks([
        deltaEvent('سلام'),
        deltaEvent(' خوش'),
        deltaEvent(' آمدید', { finish_reason: 'stop' }),
      ]));
    },
  };
  return http;
}

/**
 * Creates a settings snapshot fixture.
 */
export function settings(overrides = {}) {
  return {
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    apiKey: 'sk-test-key',
    ...overrides,
  };
}
