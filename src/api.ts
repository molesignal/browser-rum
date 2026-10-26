import { BrowserRumClient } from './client.js';
import { normalizeConfiguration } from './config.js';
import { perfNow } from './clock.js';
import type {
  RumClient,
  RumContext,
  RumInitConfiguration,
  RumTransportStats,
  TrackingConsent,
} from './types.js';
import { reportInternalError, SDK_VERSION } from './utils.js';

/** The same methods as a client, plus `init`: what `molesignalRum` and `window.MoleSignalRum` are. */
export interface RumGlobal extends RumClient {
  /** Starts the SDK. Calling it again stops the previous client and replaces it. */
  init(configuration: RumInitConfiguration): RumClient;
  /** Same as `init`; the name from SDK versions before 0.2. */
  initRum(configuration: RumInitConfiguration): RumClient;
  /** The client created by the latest `init`, if any. */
  getRum(): RumClient | undefined;
  readonly version: string;
}

/** Calls made before `init` are kept, up to this many, and replayed by `init`. */
const MAX_BUFFERED_CALLS = 500;

type BufferedCall = (client: RumClient) => void;

const EMPTY_STATS: RumTransportStats = {
  queued: 0,
  sent: 0,
  retried: 0,
  restored: 0,
  dropped: 0,
  droppedByReason: { queue_full: 0, serialization: 0, payload_too_large: 0, rejected: 0 },
};

/**
 * Builds the object applications call. Until `init`, calls that record
 * something (a user, an action, a view...) wait in a buffer, so code that runs
 * before the SDK is configured does not lose data.
 */
export function createRumApi(): RumGlobal {
  let client: RumClient | undefined;
  let pendingConsent: TrackingConsent | undefined;
  const buffer: BufferedCall[] = [];

  const queue = (call: BufferedCall): void => {
    if (buffer.length < MAX_BUFFERED_CALLS) buffer.push(call);
  };

  const init = (configuration: RumInitConfiguration): RumClient => {
    const normalized = normalizeConfiguration({
      ...configuration,
      trackingConsent: pendingConsent ?? configuration?.trackingConsent,
    });
    pendingConsent = undefined;
    if (client) void client.stop();
    const created = new BrowserRumClient(normalized);
    client = created;
    for (const call of buffer.splice(0)) {
      try {
        call(created);
      } catch (error) {
        reportInternalError(normalized.onError, error, 'RUM call made before init failed');
      }
    }
    return created;
  };

  const api: RumGlobal = {
    version: SDK_VERSION,
    init,
    initRum: init,
    getRum: () => client,

    setUser: (user) => (client ? client.setUser(user) : queue((c) => c.setUser(user))),
    getUser: () => client?.getUser(),
    setUserProperty: (key, value) =>
      client ? client.setUserProperty(key, value) : queue((c) => c.setUserProperty(key, value)),
    removeUserProperty: (key) =>
      client ? client.removeUserProperty(key) : queue((c) => c.removeUserProperty(key)),
    clearUser: () => (client ? client.clearUser() : queue((c) => c.clearUser())),

    setAccount: (account) =>
      client ? client.setAccount(account) : queue((c) => c.setAccount(account)),
    getAccount: () => client?.getAccount(),
    setAccountProperty: (key, value) =>
      client ? client.setAccountProperty(key, value) : queue((c) => c.setAccountProperty(key, value)),
    removeAccountProperty: (key) =>
      client ? client.removeAccountProperty(key) : queue((c) => c.removeAccountProperty(key)),
    clearAccount: () => (client ? client.clearAccount() : queue((c) => c.clearAccount())),

    setGlobalContext: (context) =>
      client ? client.setGlobalContext(context) : queue((c) => c.setGlobalContext(context)),
    setGlobalContextProperty: (key, value) =>
      client
        ? client.setGlobalContextProperty(key, value)
        : queue((c) => c.setGlobalContextProperty(key, value)),
    removeGlobalContextProperty: (key) =>
      client
        ? client.removeGlobalContextProperty(key)
        : queue((c) => c.removeGlobalContextProperty(key)),
    clearGlobalContext: () =>
      client ? client.clearGlobalContext() : queue((c) => c.clearGlobalContext()),
    getGlobalContext: (): RumContext => client?.getGlobalContext() ?? {},

    addAction: (name, context) =>
      client ? client.addAction(name, context) : queue((c) => c.addAction(name, context)),
    addError: (error, context, options) =>
      client
        ? client.addError(error, context, options)
        : queue((c) => c.addError(error, context, options)),
    addTiming: (name, time) => {
      if (client) {
        client.addTiming(name, time);
        return;
      }
      // Stamp the time now: the call is replayed later.
      const at = time ?? perfNow();
      queue((c) => c.addTiming(name, at));
    },
    addFeatureFlagEvaluation: (key, value) =>
      client
        ? client.addFeatureFlagEvaluation(key, value)
        : queue((c) => c.addFeatureFlagEvaluation(key, value)),

    startView: (nameOrOptions, context) =>
      client
        ? client.startView(nameOrOptions, context)
        : queue((c) => c.startView(nameOrOptions, context)),
    setViewName: (name) => (client ? client.setViewName(name) : queue((c) => c.setViewName(name))),
    setViewContext: (context) =>
      client ? client.setViewContext(context) : queue((c) => c.setViewContext(context)),
    setViewContextProperty: (key, value) =>
      client
        ? client.setViewContextProperty(key, value)
        : queue((c) => c.setViewContextProperty(key, value)),
    getViewContext: (): RumContext => client?.getViewContext() ?? {},

    // Durations depend on when they start and stop, so they are not replayed later.
    startDurationVital: (name, options) => client?.startDurationVital(name, options),
    stopDurationVital: (nameOrReference, options) =>
      client?.stopDurationVital(nameOrReference, options),
    addDurationVital: (name, options) =>
      client ? client.addDurationVital(name, options) : queue((c) => c.addDurationVital(name, options)),

    startSessionReplayRecording: () =>
      client ? client.startSessionReplayRecording() : queue((c) => c.startSessionReplayRecording()),
    stopSessionReplayRecording: () =>
      client ? client.stopSessionReplayRecording() : queue((c) => c.stopSessionReplayRecording()),
    stopSession: () => (client ? client.stopSession() : queue((c) => c.stopSession())),

    setTrackingConsent: (consent) => {
      if (client) {
        client.setTrackingConsent(consent);
        return;
      }
      if (consent !== 'granted' && consent !== 'not-granted') {
        throw new TypeError(
          'MoleSignal RUM tracking consent must be "granted" or "not-granted"',
        );
      }
      pendingConsent = consent;
    },
    getTrackingConsent: () => client?.getTrackingConsent() ?? pendingConsent ?? 'granted',

    getInternalContext: () => client?.getInternalContext() ?? { application_id: '' },
    getTransportStats: () => client?.getTransportStats() ?? { ...EMPTY_STATS },
    onReady: (callback) => {
      try {
        callback();
      } catch {
        // A failing callback must not break the page that loads the SDK.
      }
    },
    flush: () => client?.flush() ?? Promise.resolve(),
    stop: () => client?.stop() ?? Promise.resolve(),
  };
  return api;
}
