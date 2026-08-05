import type { NormalizedRumConfiguration } from './config.js';
import { getAnonymousUserId, readBrowserEnvironment } from './environment.js';
import { describeError } from './instrumentation/errors.js';
import { instrumentErrors } from './instrumentation/errors.js';
import { instrumentInteractions } from './instrumentation/interactions.js';
import { instrumentNetwork } from './instrumentation/network.js';
import {
  instrumentPerformance,
  type PerformanceInstrumentation,
} from './instrumentation/performance.js';
import type {
  ActionInput,
  Cleanup,
  InstrumentationHooks,
} from './instrumentation/types.js';
import { instrumentViews } from './instrumentation/views.js';
import { type RumSession, SessionManager } from './session.js';
import { ReplayRecorder } from './replay/recorder.js';
import { EventTransport } from './transport.js';
import type {
  RumClient,
  RumContext,
  RumEventKind,
  RumInternalContext,
  RumUser,
} from './types.js';
import {
  fnv1a,
  isBrowserEnvironment,
  matchesUrl,
  nowMicros,
  pagePath,
  reportInternalError,
  sanitizeContext,
  sanitizeUrl,
  SDK_NAME,
  SDK_VERSION,
} from './utils.js';

export class BrowserRumClient implements RumClient {
  private readonly browser = isBrowserEnvironment();
  private readonly sessionManager: SessionManager;
  private readonly eventTransport: EventTransport;
  private readonly replayRecorder: ReplayRecorder;
  private readonly browserEnvironment: RumContext;
  private readonly anonymousUserId?: string;
  private user?: RumUser;
  private globalContext: RumContext;
  private readonly cleanups: Cleanup[] = [];
  private performanceInstrumentation?: PerformanceInstrumentation;
  private currentViewUrl = '';
  private currentViewName = '';
  private changeId = 0;
  private stopped = false;
  private stopPromise?: Promise<void>;
  private replayOverride?: boolean;
  private readonly recentErrors = new Map<string, number>();

  constructor(private readonly config: NormalizedRumConfiguration) {
    this.user = config.user ? ({ ...config.user } as RumUser) : undefined;
    this.globalContext = { ...config.globalContext };
    this.sessionManager = new SessionManager(config);
    this.eventTransport = new EventTransport(config, (sessionId) =>
      this.sessionManager.nextReplaySequence(sessionId),
    );
    this.replayRecorder = new ReplayRecorder(config, (sessionId, event) => {
      const prepared = this.applyReplayBeforeSend(event);
      if (prepared) this.eventTransport.enqueueReplay(sessionId, prepared);
    });
    this.browserEnvironment = this.browser
      ? (readBrowserEnvironment() as RumContext)
      : {};
    this.anonymousUserId = this.browser
      ? getAnonymousUserId(config)
      : undefined;

    if (this.browser) this.start();
  }

  setUser(user: RumUser): void {
    if (!user || typeof user.id !== 'string' || !user.id.trim()) {
      throw new TypeError('MoleSignal RUM user.id must be a non-empty string');
    }
    this.user = { ...sanitizeContext(user), id: user.id.trim() } as RumUser;
  }

  clearUser(): void {
    this.user = undefined;
  }

  getUser(): RumUser | undefined {
    return this.user ? ({ ...this.user } as RumUser) : undefined;
  }

  setGlobalContext(context: RumContext): void {
    this.globalContext = sanitizeContext(context);
  }

  setGlobalContextProperty(key: string, value: unknown): void {
    if (!key.trim()) return;
    this.globalContext[key] = value;
  }

  removeGlobalContextProperty(key: string): void {
    delete this.globalContext[key];
  }

  getGlobalContext(): RumContext {
    return { ...sanitizeContext(this.globalContext) };
  }

  addAction(name: string, context: RumContext = {}): void {
    if (!name || this.stopped || !this.browser) return;
    this.recordAction({
      type: 'custom',
      name,
      context,
    });
  }

  addError(error: unknown, context: RumContext = {}): void {
    if (this.stopped || !this.browser) return;
    this.recordError(error, context, 'manual');
  }

  startView(name?: string, context: RumContext = {}): void {
    if (this.stopped || !isBrowserEnvironment()) return;
    const url = this.sanitizeUrl(window.location.href);
    const logicalName = name?.trim() || pagePath(url);

    this.performanceInstrumentation?.startView(url);
    this.currentViewUrl = url;
    this.currentViewName = logicalName;
    this.markChange();
    this.recordAction({
      type: 'view',
      name: `View ${logicalName}`,
      url,
      context: {
        ...context,
        path: pagePath(url),
        view_name: logicalName,
      },
    });
  }

  startSessionReplayRecording(): void {
    if (this.stopped || !this.browser) return;
    this.replayOverride = true;
    this.prepareSession();
  }

  stopSessionReplayRecording(): void {
    this.replayOverride = false;
    this.replayRecorder.stop();
  }

  getInternalContext(): RumInternalContext {
    const session = this.sessionManager.current();
    const context: RumInternalContext = {
      application_id: this.config.applicationId,
      session_id: session.sampled ? session.id : undefined,
      user_id: this.currentUserId(),
      service: this.config.service,
      env: this.config.env,
      version: this.config.version,
    };
    return compact(context);
  }

  async flush(): Promise<void> {
    this.performanceInstrumentation?.report();
    await this.eventTransport.flush(false);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.replayRecorder.stop();
      for (const cleanup of this.cleanups.reverse()) {
        try {
          cleanup();
        } catch (error) {
          reportInternalError(this.config.onError, error, 'RUM cleanup failed');
        }
      }
      this.performanceInstrumentation?.stop();
      this.stopped = true;
      await this.eventTransport.stop();
    })();
    return this.stopPromise;
  }

  private start(): void {
    this.eventTransport.start();
    this.prepareSession();
    if (this.config.sessionSampleRate <= 0) return;

    const hooks = this.instrumentationHooks();
    this.performanceInstrumentation = instrumentPerformance(hooks, {
      trackWebVitals: this.config.trackWebVitals,
      trackResources: this.config.trackResources,
      trackLongTasks: this.config.trackLongTasks,
    });

    if (!this.config.trackViewsManually) {
      this.startView();
    } else {
      this.currentViewUrl = this.sanitizeUrl(window.location.href);
      this.currentViewName = pagePath(this.currentViewUrl);
    }

    if (!this.config.trackViewsManually) this.cleanups.push(instrumentViews(hooks));
    this.cleanups.push(instrumentErrors(hooks, this.config.trackConsoleErrors));
    if (this.config.trackResources) this.cleanups.push(instrumentNetwork(hooks));
    if (this.config.trackUserInteractions) {
      this.cleanups.push(
        instrumentInteractions(hooks, {
          trackFrustrations: this.config.trackFrustrations,
          privacyLevel: this.config.defaultPrivacyLevel,
          actionNameAttribute: this.config.actionNameAttribute,
        }),
      );
    }
    this.installLifecycleListeners();

  }

  private instrumentationHooks(): InstrumentationHooks {
    return {
      recordAction: (input) => this.recordAction(input),
      recordError: (error, context, source) => this.recordError(error, context, source),
      startView: (name, context) => this.startView(name, context),
      markActivity: () => {
        this.prepareSession();
      },
      markChange: () => this.markChange(),
      getChangeId: () => this.changeId,
      currentPage: () => this.currentViewUrl,
      sanitizeUrl: (url) => this.sanitizeUrl(url),
      isSdkUrl: (url) => this.eventTransport.isSdkUrl(url),
      shouldTrackUrl: (url) => !matchesUrl(url, this.config.excludedUrls),
      shouldReadTrace: (url) => this.shouldReadTrace(url),
    };
  }

  private installLifecycleListeners(): void {
    const flushKeepalive = (): void => {
      this.performanceInstrumentation?.report();
      void this.eventTransport.flush(true);
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flushKeepalive();
    };
    const onOnline = (): void => {
      void this.eventTransport.flush(false);
    };
    window.addEventListener('pagehide', flushKeepalive);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    this.cleanups.push(() => {
      window.removeEventListener('pagehide', flushKeepalive);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  }

  private recordAction(input: ActionInput): void {
    if (this.stopped || !this.browser) return;
    const session = this.prepareSession();
    if (!session?.sampled) return;
    const timestamp = input.timestampMicros ?? nowMicros();
    const page = this.currentViewUrl || this.fallbackPage();
    const payload = compact({
      ...sanitizeContext(this.globalContext),
      ...sanitizeContext(input.context ?? {}),
      path: page ? pagePath(page) : undefined,
      application: this.config.applicationId,
      environment: this.config.env,
      version: this.config.version,
      browser: this.browserEnvironment.browser,
      os: this.browserEnvironment.os,
      device: this.browserEnvironment.device,
      user: this.user ? sanitizeContext(this.user) : undefined,
    });
    const event = compact({
      ...this.commonFields(timestamp, session),
      timestamp,
      session_id: session.id,
      ts_micros: timestamp,
      type: input.type,
      name: input.name,
      page: page ? pagePath(page) : undefined,
      url: input.url ? this.sanitizeUrl(input.url) : input.type === 'view' ? page : undefined,
      duration_ms: finite(input.durationMs),
      status: finite(input.status),
      lcp_ms: finite(input.lcpMs),
      fid_ms: finite(input.fidMs),
      cls: finite(input.cls),
      ttfb_ms: finite(input.ttfbMs),
      trace_id: input.traceContext?.traceId,
      parent_span_id: input.traceContext?.parentSpanId,
      service: input.service ?? this.config.service,
      payload,
    });
    this.enqueue('action', event);

    if (this.isReplayEnabled(session)) {
      this.recordReplay(
        session,
        compact({
          type: input.type,
          ts: Math.floor(timestamp / 1_000),
          href: page,
          url: input.url ? this.sanitizeUrl(input.url) : undefined,
          name: input.name,
          selector: stringValue(input.context?.selector),
          duration_ms: finite(input.durationMs),
          status: finite(input.status),
          payload: sanitizeContext(input.context ?? {}),
        }),
      );
    }
  }

  private recordError(error: unknown, context: RumContext = {}, source = 'unknown'): void {
    if (this.stopped || !this.browser) return;
    const session = this.prepareSession();
    if (!session?.sampled) return;
    const details = describeError(error);
    const stack = details.stack.map((frame) => ({
      ...frame,
      file: frame.file ? this.sanitizeUrl(frame.file) : undefined,
    }));
    const signature = [
      details.type,
      details.message,
      ...stack.slice(0, 3).map((frame) =>
        [frame.file, frame.function, frame.line, frame.column].join(':'),
      ),
    ].join('|');
    const now = Date.now();
    const previous = this.recentErrors.get(signature);
    if (previous !== undefined && now - previous < 1_000) return;
    this.recentErrors.set(signature, now);
    this.pruneRecentErrors(now);

    const timestamp = nowMicros();
    const page = this.currentViewUrl || this.fallbackPage();
    const fingerprint = `fp_${fnv1a(signature)}`;
    const errorContext = {
      ...sanitizeContext(this.globalContext),
      ...sanitizeContext(context),
      source,
      page: page ? pagePath(page) : undefined,
    };
    const event = compact({
      ...this.commonFields(timestamp, session),
      timestamp,
      session_id: session.id,
      user_id: this.currentUserId(),
      fingerprint,
      message: details.message,
      page: page ? pagePath(page) : undefined,
      url: page,
      application: this.config.applicationId,
      environment: this.config.env,
      version: this.config.version,
      release: this.config.version,
      service: this.config.service,
      error_type: details.type,
      error: compact({
        type: details.type,
        message: details.message,
        stack,
        raw_stack:
          this.config.defaultPrivacyLevel === 'allow' ? details.rawStack : undefined,
        context: errorContext,
      }),
      context: errorContext,
    });
    this.enqueue('error', event);
    this.recordAction({
      type: 'error',
      name: details.message,
      timestampMicros: timestamp,
      context: {
        fingerprint,
        error_type: details.type,
        source,
      },
    });
  }

  private prepareSession(): RumSession | undefined {
    if (this.stopped) return undefined;
    const { session, created } = this.sessionManager.ensure(true);
    if (created) {
      this.replayOverride = undefined;
      this.recentErrors.clear();
    }
    if (this.isReplayEnabled(session)) this.replayRecorder.start(session.id);
    else this.replayRecorder.stop();
    if (session.sampled && !session.reported) this.reportSession(session);
    return session;
  }

  private reportSession(session: RumSession): void {
    const timestamp = session.startedAtMicros;
    const page = this.currentViewUrl || this.fallbackPage();
    const event = compact({
      ...this.commonFields(timestamp, session),
      timestamp,
      session_id: session.id,
      user_id: this.currentUserId(),
      started_at: timestamp,
      started_at_micros: timestamp,
      application: this.config.applicationId,
      app_version: this.config.version,
      environment: this.config.env,
      version: this.config.version,
      service: this.config.service,
      landing_page: page ? pagePath(page) : undefined,
      last_page: page ? pagePath(page) : undefined,
      user: this.user ? sanitizeContext(this.user) : undefined,
      context: sanitizeContext(this.globalContext),
    });
    this.enqueue('session', event);
    this.sessionManager.markReported(session.id);
  }

  private commonFields(timestamp: number, session: RumSession): RumContext {
    return compact({
      timestamp,
      session_id: session.id,
      application: this.config.applicationId,
      environment: this.config.env,
      version: this.config.version,
      service: this.config.service,
      user_id: this.currentUserId(),
      anonymous_id: this.anonymousUserId,
      browser: this.browserEnvironment.browser,
      os: this.browserEnvironment.os,
      device: this.browserEnvironment.device,
      language: this.browserEnvironment.language,
      timezone: this.browserEnvironment.timezone,
      viewport: this.browserEnvironment.viewport,
      sdk_name: SDK_NAME,
      sdk_version: SDK_VERSION,
    });
  }

  private enqueue(kind: Exclude<RumEventKind, 'replay'>, event: RumContext): void {
    const prepared = this.applyBeforeSend(kind, event);
    if (prepared) this.eventTransport.enqueue(kind, prepared);
  }

  private recordReplay(session: RumSession, event: RumContext): void {
    if (!this.isReplayEnabled(session)) return;
    const prepared = this.applyBeforeSend('replay', event);
    if (prepared) this.eventTransport.enqueueReplay(session.id, prepared);
  }

  private applyBeforeSend(kind: RumEventKind, event: RumContext): RumContext | undefined {
    if (this.config.beforeSend) {
      try {
        if (this.config.beforeSend(event, { kind }) === false) return undefined;
      } catch (error) {
        reportInternalError(this.config.onError, error, 'RUM beforeSend failed');
      }
    }
    return sanitizeContext(event);
  }

  private applyReplayBeforeSend(event: RumContext): RumContext | undefined {
    if (!this.config.beforeSend) return event;
    try {
      return this.config.beforeSend(event, { kind: 'replay' }) === false
        ? undefined
        : event;
    } catch (error) {
      reportInternalError(this.config.onError, error, 'RUM beforeSend failed');
      return event;
    }
  }

  private isReplayEnabled(session: RumSession): boolean {
    if (!session.sampled) return false;
    if (this.replayOverride !== undefined) return this.replayOverride;
    return session.replaySampled;
  }

  private shouldReadTrace(url: string): boolean {
    if (this.config.allowedTracingUrls.length > 0) {
      return matchesUrl(url, this.config.allowedTracingUrls);
    }
    try {
      return new URL(url, window.location.href).origin === window.location.origin;
    } catch {
      return false;
    }
  }

  private currentUserId(): string | undefined {
    return this.user?.id ?? this.anonymousUserId;
  }

  private fallbackPage(): string {
    return isBrowserEnvironment() ? this.sanitizeUrl(window.location.href) : '';
  }

  private sanitizeUrl(url: string): string {
    return sanitizeUrl(
      url,
      this.config.trackUrlQueryString,
      isBrowserEnvironment() ? window.location.href : undefined,
    );
  }

  private markChange(): void {
    this.changeId += 1;
  }

  private pruneRecentErrors(now: number): void {
    if (this.recentErrors.size < 100) return;
    for (const [signature, timestamp] of this.recentErrors) {
      if (now - timestamp > 60_000) this.recentErrors.delete(signature);
    }
  }
}

function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
