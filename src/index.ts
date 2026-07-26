import { BrowserRumClient } from './client.js';
import { normalizeConfiguration } from './config.js';
import type { RumClient, RumInitConfiguration } from './types.js';

export type {
  BeforeSendContext,
  PrivacyLevel,
  RumClient,
  RumContext,
  RumEventKind,
  RumInitConfiguration,
  RumInternalContext,
  RumTransport,
  RumTransportRequest,
  RumTransportResponse,
  RumUser,
  UrlMatcher,
} from './types.js';

let activeClient: RumClient | undefined;

/**
 * Initializes the singleton MoleSignal browser RUM client.
 *
 * Calling initRum again stops the previous client and replaces it. Importing
 * this package is safe during SSR; instrumentation starts only in a browser.
 */
export function initRum(configuration: RumInitConfiguration): RumClient {
  const normalized = normalizeConfiguration(configuration);
  if (activeClient) void activeClient.stop();
  activeClient = new BrowserRumClient(normalized);
  return activeClient;
}

export function getRum(): RumClient | undefined {
  return activeClient;
}
