// Wires the LLM service into Bonyan's two-phase plugin lifecycle.

import { HTTP_SERVICE, SERVICE_NAME } from './lib/constants.js';
import { createLlmService } from './lib/llm-service.js';

const state = { http: null, events: null };
let savedContext = null;
let lifecycle = null;

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
  state.http = null;
  state.events = prepareContext.events ?? null;
  savedContext = prepareContext;
  prepareContext.events?.subscribe('core:service-unavailable', handleServiceUnavailable);
  lifecycle = createLlmService(state);
  prepareContext.onDeactivated = () => {
    state.http = null;
    lifecycle?.deactivate();
  };
  prepareContext.onShutdown = async () => {
    state.http = null;
    lifecycle?.deactivate();
  };
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
    throw new Error(`Required service is unavailable: ${HTTP_SERVICE}`);
  }
  state.http = http;
}
