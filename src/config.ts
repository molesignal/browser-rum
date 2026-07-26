import type {
  PrivacyLevel,
  RumContext,
  RumInitConfiguration,
  RumTransport,
  RumUser,
  UrlMatcher,
} from './types.js';

const MIN_FLUSH_INTERVAL = 250;
const MAX_FLUSH_INTERVAL = 60_000;
const MIN_SESSION_TIMEOUT = 60_000;

export interface NormalizedRumConfiguration {
  applicationId: string;
  clientToken: string;
  site: string;
  service: string;
  env?: string;
  version?: string;
  user?: RumUser;
  globalContext: RumContext;

  sessionSampleRate: number;
  sessionReplaySampleRate: number;
  trackUserInteractions: boolean;
  trackFrustrations: boolean;
  trackResources: boolean;
  trackLongTasks: boolean;
  trackWebVitals: boolean;
  trackConsoleErrors: boolean;
  trackViewsManually: boolean;
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
  sessionInactivityTimeout: number;
  maxSessionDuration: number;

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
  const applicationId = requiredString(config.applicationId, 'applicationId');
  const clientToken = requiredString(config.clientToken, 'clientToken');
  const site = normalizeSite(requiredString(config.site, 'site'));
  const trackUserInteractions = config.trackUserInteractions ?? false;

  return {
    applicationId,
    clientToken,
    site,
    service: cleanOptionalString(config.service) ?? applicationId,
    env: cleanOptionalString(config.env),
    version: cleanOptionalString(config.version),
    user: normalizeUser(config.user),
    globalContext: { ...(config.globalContext ?? {}) },

    sessionSampleRate: normalizeRate(config.sessionSampleRate, 100),
    sessionReplaySampleRate: normalizeRate(config.sessionReplaySampleRate, 0),
    trackUserInteractions,
    trackFrustrations: config.trackFrustrations ?? trackUserInteractions,
    trackResources: config.trackResources ?? true,
    trackLongTasks: config.trackLongTasks ?? true,
    trackWebVitals: config.trackWebVitals ?? true,
    trackConsoleErrors: config.trackConsoleErrors ?? false,
    trackViewsManually: config.trackViewsManually ?? false,
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
    sessionInactivityTimeout: clampInteger(
      config.sessionInactivityTimeout,
      30 * 60_000,
      MIN_SESSION_TIMEOUT,
      24 * 60 * 60_000,
    ),
    maxSessionDuration: clampInteger(
      config.maxSessionDuration,
      4 * 60 * 60_000,
      MIN_SESSION_TIMEOUT,
      24 * 60 * 60_000,
    ),

    beforeSend: config.beforeSend,
    onError: config.onError,
    transport: config.transport,
  };
}

export function rumEndpoint(
  site: string,
  kind: 'sessions' | 'actions' | 'errors' | 'replay',
): string {
  const url = new URL(site);
  let path = url.pathname.replace(/\/+$/, '');

  if (path.endsWith('/api/v1/rum/v1')) {
    path = `${path}/${kind}`;
  } else if (path.endsWith('/api/v1')) {
    path = `${path}/rum/v1/${kind}`;
  } else if (path.endsWith('/api')) {
    path = `${path}/v1/rum/v1/${kind}`;
  } else {
    path = `${path}/api/v1/rum/v1/${kind}`;
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

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeUser(user: RumUser | undefined): RumUser | undefined {
  if (!user) return undefined;
  const id = cleanOptionalString(user.id);
  if (!id) {
    throw new TypeError('MoleSignal RUM user.id must be a non-empty string');
  }
  return { ...user, id };
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
