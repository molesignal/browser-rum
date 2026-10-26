import { createRumApi, type RumGlobal } from './api.js';
import type { RumClient, RumInitConfiguration } from './types.js';

export type { RumGlobal } from './api.js';
export type {
  RumActionBody,
  RumActionEvent,
  RumConnectivity,
  RumCount,
  RumErrorBody,
  RumErrorEvent,
  RumErrorFrame,
  RumErrorSource,
  RumEvent,
  RumEventAccount,
  RumEventBase,
  RumEventType,
  RumEventUser,
  RumLargestContentfulPaint,
  RumLongTaskBody,
  RumLongTaskEvent,
  RumLongTaskScript,
  RumResourceBody,
  RumResourceEvent,
  RumResourcePhase,
  RumResourceType,
  RumViewBody,
  RumViewEvent,
  RumViewLoadingType,
  RumViewPerformance,
  RumViewReference,
  RumVitalBody,
  RumVitalEvent,
} from './events.js';
export type {
  AddDurationVitalOptions,
  AddErrorOptions,
  BeforeSendContext,
  DurationVitalOptions,
  DurationVitalReference,
  PrivacyLevel,
  RumAccount,
  RumBeforeSend,
  RumClient,
  RumContext,
  RumEventKind,
  RumInitConfiguration,
  RumInternalContext,
  RumQueueDropReason,
  RumRequestKind,
  RumSessionReplayConfiguration,
  RumTransport,
  RumTransportRequest,
  RumTransportResponse,
  RumTransportStats,
  RumUser,
  StartViewOptions,
  StopDurationVitalOptions,
  TrackingConsent,
  UrlMatcher,
} from './types.js';

/**
 * The SDK as a singleton, in the style of `datadogRum`: `molesignalRum.init()`
 * once, then `molesignalRum.setUser()`, `addAction()` and so on. Calls made
 * before `init` are kept and replayed by it.
 */
export const molesignalRum: RumGlobal = createRumApi();

/**
 * Initializes the singleton MoleSignal browser RUM client.
 *
 * Calling `init` again stops the previous client and replaces it. Importing
 * this package is safe during SSR; instrumentation starts only in a browser.
 */
export function init(configuration: RumInitConfiguration): RumClient {
  return molesignalRum.init(configuration);
}

/** The same as {@link init}, under the name used before SDK 0.2. */
export function initRum(configuration: RumInitConfiguration): RumClient {
  return molesignalRum.init(configuration);
}

export function getRum(): RumClient | undefined {
  return molesignalRum.getRum();
}
