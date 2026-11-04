import { rumEndpoint, type NormalizedRumConfiguration } from './config.js';
import type { RumInitConfiguration, RumRemoteConfiguration } from './types.js';
import { reportInternalError } from './utils.js';

/** The SDK starts with what it was given if the server has not answered by then. */
const REMOTE_TIMEOUT_MS = 1_500;

/** What the settings of the application say to the SDK; nothing if the server does not say. */
export async function fetchRemoteConfiguration(
  config: NormalizedRumConfiguration,
): Promise<RumRemoteConfiguration> {
  const fetchImplementation =
    typeof window !== 'undefined' && typeof window.fetch === 'function'
      ? window.fetch.bind(window)
      : typeof fetch === 'function'
        ? fetch
        : undefined;
  if (!fetchImplementation) return {};
  const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
  const timer = globalThis.setTimeout(() => controller?.abort(), REMOTE_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(rumEndpoint(config.site, 'config'), {
      headers: { authorization: `Bearer ${config.clientToken}` },
      credentials: 'omit',
      cache: 'no-store',
      signal: controller?.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return readRemote(await response.json());
  } catch (error) {
    reportInternalError(config.onError, error, 'RUM remote configuration unavailable');
    return {};
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function readRemote(answer: unknown): RumRemoteConfiguration {
  if (!answer || typeof answer !== 'object') return {};
  const said = answer as Record<string, unknown>;
  const remote: RumRemoteConfiguration = {};
  if (typeof said.sessionSampleRate === 'number') {
    remote.sessionSampleRate = said.sessionSampleRate;
  }
  if (typeof said.sessionReplaySampleRate === 'number') {
    remote.sessionReplaySampleRate = said.sessionReplaySampleRate;
  }
  if (
    said.defaultPrivacyLevel === 'mask' ||
    said.defaultPrivacyLevel === 'mask-user-input' ||
    said.defaultPrivacyLevel === 'allow'
  ) {
    remote.defaultPrivacyLevel = said.defaultPrivacyLevel;
  }
  if (typeof said.trackUserInteractions === 'boolean') {
    remote.trackUserInteractions = said.trackUserInteractions;
  }
  if (Array.isArray(said.forwardConsoleLogs)) {
    remote.forwardConsoleLogs = said.forwardConsoleLogs as RumRemoteConfiguration['forwardConsoleLogs'];
  }
  return remote;
}

/** The configuration with what the server decides put over what the page gave. */
export function applyRemoteConfiguration(
  configuration: RumInitConfiguration,
  remote: RumRemoteConfiguration,
): RumInitConfiguration {
  return { ...configuration, ...remote };
}
