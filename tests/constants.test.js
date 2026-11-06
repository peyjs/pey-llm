// Unit tests for lib/constants.js — the shared contract values.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ERROR_CODES,
  PLUGIN_NAME,
  SERVICE_NAME,
  SETTINGS_EVENT,
} from '../lib/constants.js';

test('should_expose_the_plugin_and_service_names_when_read', () => {
  assert.equal(PLUGIN_NAME, 'pey.llm');
  assert.equal(SERVICE_NAME, 'pey.llm.service');
});

test('should_name_the_settings_event_in_past_tense_when_declared', () => {
  // bonyan/naming.md: domain events read as what happened.
  assert.equal(SETTINGS_EVENT, 'llm:settings-changed');
});

test('should_keep_every_error_code_prefixed_with_llm_when_listed', () => {
  for (const code of Object.values(ERROR_CODES)) {
    assert.match(code, /^LLM_[A-Z_]+$/, code);
  }
});
