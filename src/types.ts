export type RumEventKind = 'session' | 'action' | 'error' | 'replay';

export type RumContext = Record<string, unknown>;

export interface RumUser {
  id: string;
  name?: string;
  email?: string;
  [key: string]: unknown;
}

export interface RumTransportRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  keepalive: boolean;
  kind: RumEventKind;
}

export interface RumTransportResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  body?: string;
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

export type UrlMatcher = string | RegExp | ((url: string) => boolean);

export type PrivacyLevel = 'mask' | 'allow';

export interface RumInitConfiguration {
  /** Stable application identifier shown in MoleSignal RUM views. */
  applicationId: string;
  /** MoleSignal API token used as an Authorization Bearer token. */
  clientToken: string;
  /** MoleSignal origin, for example https://molesignal.example.com. */
  site: string;
  service?: string;
  env?: string;
  version?: string;
  user?: RumUser;
  globalContext?: RumContext;

  /** Percentage in the inclusive 0..100 range. Defaults to 100. */
  sessionSampleRate?: number;
  /** Percentage of sampled sessions that record a replay timeline. Defaults to 0. */
  sessionReplaySampleRate?: number;

  trackUserInteractions?: boolean;
  trackFrustrations?: boolean;
  trackResources?: boolean;
  trackLongTasks?: boolean;
  trackWebVitals?: boolean;
  trackConsoleErrors?: boolean;
  trackViewsManually?: boolean;
  trackAnonymousUser?: boolean;

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
  sessionInactivityTimeout?: number;
  maxSessionDuration?: number;

  beforeSend?: (event: RumContext, context: BeforeSendContext) => boolean | void;
  onError?: (error: Error) => void;
  transport?: RumTransport;
}

export interface RumInternalContext {
  application_id: string;
  session_id?: string;
  user_id?: string;
  service?: string;
  env?: string;
  version?: string;
}

export interface RumClient {
  setUser(user: RumUser): void;
  clearUser(): void;
  getUser(): RumUser | undefined;

  setGlobalContext(context: RumContext): void;
  setGlobalContextProperty(key: string, value: unknown): void;
  removeGlobalContextProperty(key: string): void;
  getGlobalContext(): RumContext;

  addAction(name: string, context?: RumContext): void;
  addError(error: unknown, context?: RumContext): void;
  startView(name?: string, context?: RumContext): void;

  startSessionReplayRecording(): void;
  stopSessionReplayRecording(): void;

  getInternalContext(): RumInternalContext;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

