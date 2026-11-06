// Verifies the entry-point lifecycle wiring and the manifest contract.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { prepare, activate } from '../index.js';

const MANIFEST_PATH = new URL('../manifest.json', import.meta.url);
const PACKAGE_PATH = new URL('../package.json', import.meta.url);

function createPrepareContext(overrides = {}) {
  const context = {};
  Object.assign(context, {
    config: {},
    events: {
      published: [],
      listeners: {},
      publish() {},
      subscribe(type, listener) {
        this.listeners[type] = this.listeners[type] ?? [];
        this.listeners[type].push(listener);
        return () => {
          const index = this.listeners[type].indexOf(listener);
          if (index !== -1) this.listeners[type].splice(index, 1);
        };
      },
    },
    onShutdown: null,
    onDeactivated: null,
    reportCriticalError: (error) => context.events.published.push({ type: 'critical', data: error }),
    ...overrides,
  });
  return context;
}

test('should_register_service_when_prepare_is_called', async () => {
  const context = createPrepareContext();

  const registrations = await prepare(context);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, 'pey.llm.service');
  assert.equal(typeof registrations[0].object.complete, 'function');
  assert.equal(typeof registrations[0].object.stream, 'function');
  assert.equal(typeof registrations[0].object.setSettings, 'function');
  assert.equal(typeof context.onShutdown, 'function');
  assert.equal(typeof context.onDeactivated, 'function');
});

test('should_reject_activation_with_a_structured_startup_error_when_the_dependency_is_missing', async () => {
  await prepare(createPrepareContext());

  await assert.rejects(
    () => activate({}),
    (error) => error.code === 'REQUIRED_DEPENDENCY_UNAVAILABLE'
      && error.type === 'startup'
      && error.source === 'pey.llm',
  );
  await activate({ 'pey.http.service': {} });
});

test('should_report_critical_error_when_the_transport_dependency_is_lost_at_runtime', async () => {
  const context = createPrepareContext();
  await prepare(context);

  context.events.listeners['core:service-unavailable'][0]({
    data: { serviceName: 'pey.http.service' },
  });

  const critical = context.events.published.find((entry) => entry.type === 'critical');
  assert.equal(critical.data.code, 'REQUIRED_DEPENDENCY_LOST');
  assert.equal(critical.data.type, 'critical');
});

test('should_ignore_unrelated_service_loss_when_notified', async () => {
  const context = createPrepareContext();
  await prepare(context);

  context.events.listeners['core:service-unavailable'][0]({
    data: { serviceName: 'other.service' },
  });

  assert.equal(context.events.published.find((entry) => entry.type === 'critical'), undefined);
});

test('should_unsubscribe_from_service_unavailable_when_shutdown', async () => {
  const context = createPrepareContext();
  await prepare(context);
  assert.equal(context.events.listeners['core:service-unavailable'].length, 1);

  await context.onShutdown();

  assert.equal(context.events.listeners['core:service-unavailable'].length, 0, 'shutdown must leave the bus');
});

test('should_unsubscribe_from_service_unavailable_when_deactivated', async () => {
  const context = createPrepareContext();
  await prepare(context);

  context.onDeactivated();

  assert.equal(context.events.listeners['core:service-unavailable'].length, 0, 'deactivation must leave the bus');
});

test('should_refuse_calls_before_activation', async () => {
  const context = createPrepareContext();
  const registrations = await prepare(context);

  await assert.rejects(
    () => registrations[0].object.complete([]),
    (error) => error.code === 'SERVICE_UNAVAILABLE',
  );
});

test('should_match_manifest_contract_when_loaded', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const pkg = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));

  assert.equal(manifest.name, 'pey.llm');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.type, 'feature');
  assert.equal(manifest.adapterType, undefined);
  assert.deepEqual(manifest.dependencies, { required: ['pey.http.service'], optional: [] });
  assert.equal(manifest.provides.length, 1);
  assert.equal(manifest.provides[0].name, 'pey.llm.service');
  const methodNames = manifest.provides[0].methods.map((method) => method.name);
  assert.deepEqual(methodNames, ['setSettings', 'clearSettings', 'getSettingsStatus', 'complete', 'stream']);
  assert.deepEqual(manifest.events.map((event) => event.name), ['llm:settings-changed']);
  assert.deepEqual(manifest.config, {});
});
