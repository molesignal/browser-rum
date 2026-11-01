import type { RumContext, RumEvent, RumEventType, RumLogLevel } from './events.js';

export type { RumContext } from './events.js';

/** What `beforeSend` is called for: every contract event type. */
export type RumEventKind = RumEventType;

/** Which MoleSignal endpoint a transport request is addressed to. */
export type RumRequestKind = 'events' | 'replay';

/** The signed-in user. At least one of `id`, `name` and `email` is required. */
export interface RumUser {
  id?: string;
  name?: string;
  email?: string;
  [key: string]: unknown;
}

export interface RumAccount {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface RumTransportRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  keepalive: boolean;
  kind: RumRequestKind;
}

export interface RumTransportResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  /**
   * The response body. Successful `events` responses are read to find the
   * events the server rejected (`{ accepted, rejected: [{ index, reason }] }`).
   */
  body?: string;
  /** Parsed Retry-After delay in milliseconds, when supplied by the server. */
  retryAfterMs?: number;
}

/**
 * A custom transport is useful when RUM traffic must pass through an
 * application-owned proxy. The default transport uses the browser's fetch
 * implementation captured before network instrumentation is installed.
 */
export interface RumTransport {
  send(request: RumTransportRequest): Promise<RumTransportResponse>;
}

export interface BeforeSendContext {
  kind: RumEventKind;
}

/**
 * Inspect or modify an event before it is queued. Return `false` to drop it.
 * `view` events cannot be dropped: their counts would stop adding up.
 */
export type RumBeforeSend = (event: RumEvent, context: BeforeSendContext) => boolean | void;

export type UrlMatcher = string | RegExp | ((url: string) => boolean);

/**
 * `mask`: every text is masked, and action names and selectors say nothing a person wrote.
 * `mask-user-input`: the text of the page shows; what is typed into a field does not.
 * `allow`: fields show too, but for passwords, e-mail addresses, telephone numbers and card fields.
 */
export type PrivacyLevel = 'mask' | 'mask-user-input' | 'allow';

/** Tracking starts only while consent is granted. */
export type TrackingConsent = 'granted' | 'not-granted';

export type RumQueueDropReason =
  | 'queue_full'
  | 'serialization'
  | 'payload_too_large'
  | 'rejected';

export interface RumTransportStats {
  queued: number;
  sent: number;
  retried: number;
  restored: number;
  dropped: number;
  droppedByReason: Record<RumQueueDropReason, number>;
}

/**
 * Session replay is captured as rrweb DOM snapshots and incremental changes.
 * Inputs are always masked. These selectors provide additional page-specific
 * privacy controls without requiring application code changes.
 */
export interface RumSessionReplayConfiguration {
  /** Entire matching subtrees are replaced with placeholders. */
  blockSelector?: string;
  /** Text inside matching elements is masked. */
  maskTextSelector?: string;
  /** Matching events and mutations are ignored. */
  ignoreSelector?: string;
  /** Periodic full-snapshot interval in milliseconds. Defaults to 5 minutes. */
  checkoutInterval?: number;
  /** Inline dynamically loaded fonts into the recording. Disabled by default. */
  collectFonts?: boolean;
  /** Inline image bytes into the recording. Disabled by default. */
  inlineImages?: boolean;
  /** Record cooperating cross-origin frames. Disabled by default. */
  recordCrossOriginIframes?: boolean;
}

/** A logger of the application: `molesignalRum.logger`, or one of `createLogger`. */
export interface RumLogger {
  debug(message: string, context?: RumContext, error?: unknown): void;
  info(message: string, context?: RumContext, error?: unknown): void;
  warn(message: string, context?: RumContext, error?: unknown): void;
  error(message: string, context?: RumContext, error?: unknown): void;
  /** What is below this level is left out. */
  setLevel(level: RumLogLevel): void;
}

export interface RumLoggerOptions {
  /** Which logger wrote a log, as `log.logger`. */
  name?: string;
  /** What is below this level is left out. Defaults to `debug`. */
  level?: RumLogLevel;
  /** Attributes every log of this logger has. */
  context?: RumContext;
}

/** What a plugin is given once the SDK runs. */
export interface RumPluginStart {
  client: RumClient;
}

/** Something that extends the SDK, such as the integration with a router. */
export interface RumPlugin {
  name: string;
  /** Before the SDK reads its configuration: a plugin may set what it needs in it. */
  onInit?(configuration: RumInitConfiguration): void;
  onStart?(start: RumPluginStart): void;
}

/** What an application's settings can decide for the SDK, read from the server at start. */
export interface RumRemoteConfiguration {
  sessionSampleRate?: number;
  sessionReplaySampleRate?: number;
  defaultPrivacyLevel?: PrivacyLevel;
  trackUserInteractions?: boolean;
  forwardConsoleLogs?: Array<'debug' | 'log' | 'info' | 'warn' | 'error'>;
}

export interface RumInitConfiguration {
  /**
   * Identifier of the MoleSignal RUM application the client token belongs to.
   * It is sent as `application.id`, which the server rejects when it differs
   * from the application the token is bound to. 1 to 128 characters from
   * `A-Z a-z 0-9 . _ : -`.
   */
  applicationId: string;
  /** Application-bound `msrum_<16>_<32>` token used as a Bearer token. */
  clientToken: string;
  /** MoleSignal origin, for example https://molesignal.example.com. */
  site: string;
  service?: string;
  env?: string;
  /** Deployment release used for Source Map lookup. */
  version?: string;
  /** Optional build debug ID used to disambiguate Source Maps for this release. */
  debugId?: string;
  user?: RumUser;
  account?: RumAccount;
  globalContext?: RumContext;

  /** Defaults to granted. */
  trackingConsent?: TrackingConsent;

  /** Percentage in the inclusive 0..100 range. Defaults to 100. */
  sessionSampleRate?: number;
  /** Percentage of sampled sessions that record DOM replay. Defaults to 0. */
  sessionReplaySampleRate?: number;
  /**
   * Percentage of the traces requests start that a back end is asked to keep (the W3C sampled flag).
   * The others still carry a trace context, so the request and its trace id stay joined. Defaults to 100.
   */
  traceSampleRate?: number;
  /** DOM recording and privacy controls for sampled session replay. */
  sessionReplay?: RumSessionReplayConfiguration;

  trackUserInteractions?: boolean;
  trackFrustrations?: boolean;
  trackResources?: boolean;
  trackLongTasks?: boolean;
  trackWebVitals?: boolean;
  trackConsoleErrors?: boolean;
  trackViewsManually?: boolean;
  /** Start a new view when a page is restored from the back/forward cache. Defaults to false. */
  trackBfcacheViews?: boolean;
  trackAnonymousUser?: boolean;
  /** Keep how far down the page each view goes. Defaults to true. */
  trackScroll?: boolean;
  /** Say what goes wrong in the SDK itself as logs of the application. Defaults to true. */
  trackSdkErrors?: boolean;
  /** Which console methods also write logs. Defaults to none. */
  forwardConsoleLogs?: Array<'debug' | 'log' | 'info' | 'warn' | 'error'> | 'all';
  /**
   * The headers of a fetch or XHR to keep with its resource, by name. Credentials
   * (`authorization`, `cookie` and the like) are never kept. Defaults to none.
   */
  trackResourceHeaders?: Array<string | RegExp>;

  /** URL query strings are removed by default because they commonly contain PII. */
  trackUrlQueryString?: boolean;
  defaultPrivacyLevel?: PrivacyLevel;
  actionNameAttribute?: string;
  excludedUrls?: UrlMatcher[];
  allowedTracingUrls?: UrlMatcher[];

  flushInterval?: number;
  batchSize?: number;
  replayFlushInterval?: number;
  replayBatchSize?: number;
  maxQueueSize?: number;
  /** Persist unsent telemetry in IndexedDB. Defaults to true. */
  enablePersistentQueue?: boolean;
  /** Gzip the requests of events where the browser can. Defaults to false. */
  compressIntakeRequests?: boolean;
  /**
   * Read what the settings of the application decide from the server before starting, and let it
   * replace the values given here. The SDK starts with the values given if the server does not
   * answer in time. Defaults to false.
   */
  remoteConfiguration?: boolean;
  /** Where people open MoleSignal, when it is not `site`. For `getSessionReplayLink`. */
  appUrl?: string;
  /** What extends the SDK. */
  plugins?: RumPlugin[];
  /** Initial retry delay in milliseconds. Defaults to 1 second. */
  retryBaseDelay?: number;
  /** Maximum retry delay in milliseconds. Defaults to 60 seconds. */
  retryMaxDelay?: number;
  /** Idle time after which a session expires, in milliseconds. Defaults to 15 minutes. */
  sessionInactivityTimeout?: number;
  /** Hard limit on a session's length, in milliseconds. Defaults to 4 hours. */
  maxSessionDuration?: number;
  /**
   * Domain of the session cookie, for example `.example.com` to share one
   * session across subdomains. Defaults to the current host.
   */
  sessionCookieDomain?: string;
  /** Share the session across subdomains by finding the registrable domain. */
  trackSessionAcrossSubdomains?: boolean;
  /** Write the session cookie with `SameSite=None; Secure` (for embedded iframes). */
  useCrossSiteSessionCookie?: boolean;

  beforeSend?: RumBeforeSend;
  onError?: (error: Error) => void;
  transport?: RumTransport;
}

export interface RumInternalContext {
  application_id: string;
  session_id?: string;
  user_id?: string;
  tab_id?: string;
  service?: string;
  env?: string;
  version?: string;
  view?: { id: string; url: string; name?: string; referrer?: string };
  user_action?: { id: string };
}

export interface StartViewOptions {
  name?: string;
  /** Overrides `service` for the events of this view (for micro-frontends). */
  service?: string;
  /** Overrides `version` for the events of this view. */
  version?: string;
  context?: RumContext;
}

export interface DurationVitalOptions {
  context?: RumContext;
  description?: string;
}

/** Handle of a running duration vital, returned by `startDurationVital`. */
export interface DurationVitalReference {
  readonly id: string;
  readonly name: string;
}

export interface AddDurationVitalOptions extends DurationVitalOptions {
  /** Epoch milliseconds, or a `performance.now()` timestamp. */
  startTime: number;
  /** Milliseconds. */
  duration: number;
}

export interface AddErrorOptions {
  /**
   * Errors with the same fingerprint form one group, whatever their message and
   * stack. Up to 128 characters, sent as given. The SDK sets no fingerprint of its
   * own; for errors it collects by itself, set `event.error.fingerprint` in `beforeSend`.
   */
  fingerprint?: string;
}

export interface StopDurationVitalOptions extends DurationVitalOptions {
  /** Epoch milliseconds, or a `performance.now()` timestamp. Defaults to now. */
  stopTime?: number;
}

export interface RumClient {
  setUser(user: RumUser): void;
  getUser(): RumUser | undefined;
  setUserProperty(key: string, value: unknown): void;
  removeUserProperty(key: string): void;
  clearUser(): void;

  setAccount(account: RumAccount): void;
  getAccount(): RumAccount | undefined;
  setAccountProperty(key: string, value: unknown): void;
  removeAccountProperty(key: string): void;
  clearAccount(): void;

  setGlobalContext(context: RumContext): void;
  setGlobalContextProperty(key: string, value: unknown): void;
  removeGlobalContextProperty(key: string): void;
  clearGlobalContext(): void;
  getGlobalContext(): RumContext;

  addAction(name: string, context?: RumContext): void;
  /**
   * Reports a handled error. The server groups errors itself; pass
   * `options.fingerprint` to choose the grouping.
   */
  addError(error: unknown, context?: RumContext, options?: AddErrorOptions): void;
  /**
   * Records a custom timing on the current view. `time` is a
   * `performance.now()` timestamp or epoch milliseconds; it defaults to now.
   */
  addTiming(name: string, time?: number): void;
  addFeatureFlagEvaluation(key: string, value: unknown): void;

  /** The logger of the application, which has no name of its own. */
  readonly logger: RumLogger;
  createLogger(options?: RumLoggerOptions): RumLogger;

  startView(nameOrOptions?: string | StartViewOptions, context?: RumContext): void;
  setViewName(name: string): void;
  setViewContext(context: RumContext): void;
  setViewContextProperty(key: string, value: unknown): void;
  getViewContext(): RumContext;
  /**
   * Says the current view has loaded now, in place of what the SDK measures. For pages that know
   * better, such as one that shows a skeleton while its data arrives.
   */
  setViewLoadingTime(): void;

  startDurationVital(
    name: string,
    options?: DurationVitalOptions,
  ): DurationVitalReference | undefined;
  stopDurationVital(
    nameOrReference: string | DurationVitalReference,
    options?: StopDurationVitalOptions,
  ): void;
  addDurationVital(name: string, options: AddDurationVitalOptions): void;

  /** Records the DOM of the current session, whatever `sessionReplaySampleRate` selected. */
  startSessionReplayRecording(): void;
  stopSessionReplayRecording(): void;
  /** Ends the session now; the next user activity starts a new one. */
  stopSession(): void;
  /**
   * The address of the current session in MoleSignal, to put in a support ticket or a bug report.
   * Undefined while no session is recorded.
   */
  getSessionReplayLink(): string | undefined;

  setTrackingConsent(consent: TrackingConsent): void;
  getTrackingConsent(): TrackingConsent;

  getInternalContext(): RumInternalContext;
  getTransportStats(): RumTransportStats;
  /** Runs `callback` when the SDK is ready; immediately for an imported client. */
  onReady(callback: () => void): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
}
