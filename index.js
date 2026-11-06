// Wires the LLM service into Bonyan's two-phase plugin lifecycle.

import { HTTP_SERVICE, PLUGIN_NAME, SERVICE_NAME } from './lib/constants.js';
import { createLlmService } from './lib/llm-service.js';

const state = { http: null, events: null };
let savedContext = null;
let lifecycle = null;
let unsubscribeUnavailable = null;

/**
 * Releases this prepare() call's resources: the dependency reference goes
 * away, in-flight streams end, and the core:service-unavailable listener
 * leaves the Event Bus so a lost-dependency event after shutdown can never
 * report a critical error for a dead plugin.
 */
function teardown() {
  state.http = null;
  lifecycle?.deactivate();
  if (unsubscribeUnavailable !== null) {
    unsubscribeUnavailable();
    unsubscribeUnavailable = null;
  }
}

/**
 * Reports a critical error when the required HTTP transport disappears at
 * runtime. Settlement already handles startup-time absence automatically.
 * @param {object} event Core event envelope.
 * @returns {void}
 */
function handleServiceUnavailable(event) {
  if (event?.data?.serviceName !== HTTP_SERVICE || !savedContext) {
    return;
  }
  savedContext.reportCriticalError({
    code: 'REQUIRED_DEPENDENCY_LOST',
    message: `Required service ${HTTP_SERVICE} is no longer available`,
    source: SERVICE_NAME,
    type: 'critical',
    timestamp: new Date().toISOString(),
  });
}

/**
 * Prepares the plugin: builds the service and registers lifecycle hooks.
 * The pey.http dependency is bound later, at activation.
 * @param {object} prepareContext Bonyan preparation context.
 * @returns {Promise<Array>} Service registration.
 */
export async function prepare(prepareContext) {
  // A repeated prepare() call must not leave the previous call's listener
  // behind on the Event Bus.
  teardown();
  state.events = prepareContext.events ?? null;
  savedContext = prepareContext;
  const subscribed = prepareContext.events?.subscribe('core:service-unavailable', handleServiceUnavailable);
  unsubscribeUnavailable = typeof subscribed === 'function' ? subscribed : null;
  lifecycle = createLlmService(state);
  prepareContext.onDeactivated = () => teardown();
  prepareContext.onShutdown = async () => teardown();
  return [{ name: SERVICE_NAME, object: lifecycle.service }];
}

/**
 * Activates the plugin: binds the required HTTP transport for service calls.
 * @param {Record<string, object>} services Bound declared dependencies.
 * @returns {Promise<void>}
 */
export async function activate(services) {
  const http = services[HTTP_SERVICE];
  if (!http) {
    // Boundary errors are always structured, startup included.
    throw Object.assign(new Error(`Required service is unavailable: ${HTTP_SERVICE}`), {
      code: 'REQUIRED_DEPENDENCY_UNAVAILABLE',
      source: PLUGIN_NAME,
      type: 'startup',
      timestamp: new Date().toISOString(),
      detail: { service: HTTP_SERVICE },
    });
  }
  state.http = http;
}
