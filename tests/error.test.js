// Unit tests for lib/error.js — the pey.llm boundary error factory.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLlmError } from '../lib/error.js';

test('should_build_standard_structured_error_when_called_with_code_and_message', () => {
  const error = createLlmError('LLM_REQUEST_FAILED', 'The model request could not be delivered');

  assert.equal(error.code, 'LLM_REQUEST_FAILED');
  assert.equal(error.message, 'The model request could not be delivered');
  assert.equal(error.source, 'pey.llm');
  assert.equal(error.type, 'operational');
  assert.ok(!Number.isNaN(Date.parse(error.timestamp)));
});

test('should_reject_unsupported_codes_and_types_when_misused', () => {
  assert.throws(() => createLlmError('lowercase-code', 'x'), TypeError);
  assert.throws(() => createLlmError('LLM_REQUEST_FAILED', 'x', 'fatal'), TypeError);
});
