import { normalizeAccount, normalizeUser } from './identity.js';
import type {
  PrivacyLevel,
  RumAccount,
  RumContext,
  RumInitConfiguration,
  RumSessionReplayConfiguration,
  RumTransport,
  RumUser,
  TrackingConsent,
  UrlMatcher,
} from './types.js';
import { clampText, sanitizeContext } from './utils.js';

const MIN_FLUSH_INTERVAL = 250;
const MAX_FLUSH_INTERVAL = 60_000;
const MIN_SESSION_TIMEOUT = 60_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const DEFAULT_SESSION_INACTIVITY_TIMEOUT = 15 * 60_000;
const DEFAULT_MAX_SESSION_DURATION = 4 * 60 * 60_000;

export interface NormalizedRumConfiguration {
  applicationId: string;
  clientToken: string;
  site: string;
  service: string;
  env?: string;
  version?: string;
  debugId?: string;
  user?: RumUser;
  account?: RumAccount;
  globalContext: RumContext;
  trackingConsent: TrackingConsent;

  sessionSampleRate: number;
  sessionReplaySampleRate: number;
  sessionReplay: Required<RumSessionReplayConfiguration>;
  trackUserInteractions: boolean;
  trackFrustrations: boolean;
  trackResources: boolean;
  trackLongTasks: boolean;
  trackWebVitals: boolean;
  trackConsoleErrors: boolean;
  trackViewsManually: boolean;
  trackBfcacheViews: boolean;
  trackAnonymousUser: boolean;
  trackUrlQueryString: boolean;
  defaultPrivacyLevel: PrivacyLevel;
  actionNameAttribute: string;
  excludedUrls: UrlMatcher[];
  allowedTracingUrls: UrlMatcher[];

  flushInterval: number;
  batchSize: number;
  replayFlushInterval: number;
  replayBatchSize: number;
  maxQueueSize: number;
  enablePersistentQueue: boolean;
  retryBaseDelay: number;
  retryMaxDelay: number;
  sessionInactivityTimeout: number;
  maxSessionDuration: number;
  sessionCookieDomain?: string;
  trackSessionAcrossSubdomains: boolean;
  useCrossSiteSessionCookie: boolean;

  beforeSend?: RumInitConfiguration['beforeSend'];
  onError?: RumInitConfiguration['onError'];
  transport?: RumTransport;
}

export function normalizeConfiguration(
  config: RumInitConfiguration,
): NormalizedRumConfiguration {
  if (!config || typeof config !== 'object') {
    throw new TypeError('MoleSignal RUM configuration is required');
  }
  const applicationId = normalizeApplicationId(config.applicationId);
  const clientToken = normalizeClientToken(config.clientToken);
  const site = normalizeSite(requiredString(config.site, 'site'));
  const trackUserInteractions = config.trackUserInteractions ?? false;
  const version = cleanLabel(config.version);
  const debugId = normalizeDebugId(config.debugId);
  if (debugId && !version) {
    throw new TypeError('MoleSignal RUM "version" is required when "debugId" is set');
  }
  const retryBaseDelay = clampInteger(config.retryBaseDelay, 1_000, 250, 60_000);

  return {
    applicationId,
    clientToken,
    site,
    service: cleanLabel(config.service) ?? clampText(applicationId, 256),
    env: cleanLabel(config.env),
    version,
    debugId,
    user: config.user ? normalizeUser(config.user) : undefined,
    account: config.account ? normalizeAccount(config.account) : undefined,
    globalContext: sanitizeContext(config.globalContext ?? {}),
    trackingConsent: normalizeTrackingConsent(config.trackingConsent),

    sessionSampleRate: normalizeRate(config.sessionSampleRate, 100),
    sessionReplaySampleRate: normalizeRate(config.sessionReplaySampleRate, 0),
    sessionReplay: normalizeSessionReplay(config.sessionReplay),
    trackUserInteractions,
    trackFrustrations: config.trackFrustrations ?? trackUserInteractions,
    trackResources: config.trackResources ?? true,
    trackLongTasks: config.trackLongTasks ?? true,
    trackWebVitals: config.trackWebVitals ?? true,
    trackConsoleErrors: config.trackConsoleErrors ?? false,
    trackViewsManually: config.trackViewsManually ?? false,
    trackBfcacheViews: config.trackBfcacheViews ?? false,
    trackAnonymousUser: config.trackAnonymousUser ?? true,
    trackUrlQueryString: config.trackUrlQueryString ?? false,
    defaultPrivacyLevel: config.defaultPrivacyLevel ?? 'mask',
    actionNameAttribute: normalizeAttributeName(config.actionNameAttribute),
    excludedUrls: [...(config.excludedUrls ?? [])],
    allowedTracingUrls: [...(config.allowedTracingUrls ?? [])],

    flushInterval: clampInteger(
      config.flushInterval,
      5_000,
      MIN_FLUSH_INTERVAL,
      MAX_FLUSH_INTERVAL,
    ),
    batchSize: clampInteger(config.batchSize, 50, 1, 100),
    replayFlushInterval: clampInteger(
      config.replayFlushInterval,
      10_000,
      MIN_FLUSH_INTERVAL,
      MAX_FLUSH_INTERVAL,
    ),
    replayBatchSize: clampInteger(config.replayBatchSize, 100, 1, 200),
    maxQueueSize: clampInteger(config.maxQueueSize, 1_000, 20, 10_000),
    enablePersistentQueue: config.enablePersistentQueue ?? true,
    retryBaseDelay,
    retryMaxDelay: clampInteger(
      config.retryMaxDelay,
      60_000,
      retryBaseDelay,
      5 * 60_000,
    ),
    sessionInactivityTimeout: clampInteger(
      config.sessionInactivityTimeout,
      DEFAULT_SESSION_INACTIVITY_TIMEOUT,
      MIN_SESSION_TIMEOUT,
      24 * 60 * 60_000,
    ),
    maxSessionDuration: clampInteger(
      config.maxSessionDuration,
      DEFAULT_MAX_SESSION_DURATION,
      MIN_SESSION_TIMEOUT,
      24 * 60 * 60_000,
    ),
    sessionCookieDomain: normalizeCookieDomain(config.sessionCookieDomain),
    trackSessionAcrossSubdomains: config.trackSessionAcrossSubdomains ?? false,
    useCrossSiteSessionCookie: config.useCrossSiteSessionCookie ?? false,

    beforeSend: config.beforeSend,
    onError: config.onError,
    transport: config.transport,
  };
}

function normalizeSessionReplay(
  replay: RumSessionReplayConfiguration | undefined,
): Required<RumSessionReplayConfiguration> {
  return {
    blockSelector: normalizeSelector(
      replay?.blockSelector,
      '[data-molesignal-block]',
      'sessionReplay.blockSelector',
    ),
    maskTextSelector: normalizeSelector(
      replay?.maskTextSelector,
      '[data-molesignal-mask]',
      'sessionReplay.maskTextSelector',
    ),
    ignoreSelector: normalizeSelector(
      replay?.ignoreSelector,
      '[data-molesignal-ignore]',
      'sessionReplay.ignoreSelector',
    ),
    checkoutInterval: clampInteger(
      replay?.checkoutInterval,
      5 * 60_000,
      30_000,
      30 * 60_000,
    ),
    collectFonts: replay?.collectFonts ?? false,
    inlineImages: replay?.inlineImages ?? false,
    recordCrossOriginIframes: replay?.recordCrossOriginIframes ?? false,
  };
}

function normalizeSelector(value: string | undefined, fallback: string, field: string): string {
  const selector = cleanOptionalString(value) ?? fallback;
  if (selector.length > 1_024 || selector.includes('\0')) {
    throw new TypeError(`MoleSignal RUM "${field}" is not a valid CSS selector`);
  }
  return selector;
}

/**
 * The URL of the event or replay endpoint for a `site`, which may be an
 * origin or end in `/api`, `/api/v1` or `/api/v1/rum`. Events go to
 * `…/api/v1/rum/events`, DOM recordings to `…/api/v1/rum/replay`.
 */
export function rumEndpoint(site: string, kind: 'events' | 'replay'): string {
  const url = new URL(site);
  let path = url.pathname.replace(/\/+$/, '');

  if (path.endsWith('/api/v1/rum')) {
    path = `${path}/${kind}`;
  } else if (path.endsWith('/api/v1')) {
    path = `${path}/rum/${kind}`;
  } else if (path.endsWith('/api')) {
    path = `${path}/v1/rum/${kind}`;
  } else {
    path = `${path}/api/v1/rum/${kind}`;
  }

  url.pathname = path.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  return url.toString();
}

function normalizeSite(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('MoleSignal RUM "site" must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('MoleSignal RUM "site" must use http or https');
  }
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`MoleSignal RUM "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function normalizeApplicationId(value: unknown): string {
  const applicationId = requiredString(value, 'applicationId');
  if (!IDENTIFIER_PATTERN.test(applicationId)) {
    throw new TypeError(
      'MoleSignal RUM "applicationId" must be 1 to 128 characters from A-Z a-z 0-9 . _ : -',
    );
  }
  return applicationId;
}

function normalizeClientToken(value: unknown): string {
  const token = requiredString(value, 'clientToken');
  if (!/^msrum_[0-9A-Za-z]{16}_[0-9A-Za-z]{32}$/.test(token)) {
    throw new TypeError(
      'MoleSignal RUM "clientToken" must be an application-bound msrum_<16>_<32> token',
    );
  }
  return token;
}

function normalizeTrackingConsent(value: TrackingConsent | undefined): TrackingConsent {
  if (value === undefined) return 'granted';
  if (value !== 'granted' && value !== 'not-granted') {
    throw new TypeError(
      'MoleSignal RUM "trackingConsent" must be "granted" or "not-granted"',
    );
  }
  return value;
}

function normalizeDebugId(value: unknown): string | undefined {
  const debugId = cleanOptionalString(value);
  if (!debugId) return undefined;
  if (debugId.length > 128 || !/^[0-9A-Za-z{}_.:-]+$/.test(debugId)) {
    throw new TypeError('MoleSignal RUM "debugId" is not valid');
  }
  return debugId;
}

function normalizeCookieDomain(value: unknown): string | undefined {
  const domain = cleanOptionalString(value);
  if (!domain) return undefined;
  if (domain.length > 253 || !/^\.?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/.test(domain)) {
    throw new TypeError('MoleSignal RUM "sessionCookieDomain" is not a valid domain');
  }
  return domain;
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** `service`, `env` and `version` are contract labels of 1 to 256 characters. */
function cleanLabel(value: unknown): string | undefined {
  const label = cleanOptionalString(value);
  return label === undefined ? undefined : clampText(label, 256);
}

function normalizeRate(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, value));
}

function normalizeAttributeName(value: string | undefined): string {
  const attribute = cleanOptionalString(value) ?? 'data-molesignal-name';
  if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(attribute)) {
    throw new TypeError('MoleSignal RUM "actionNameAttribute" is not a valid attribute name');
  }
  return attribute;
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
