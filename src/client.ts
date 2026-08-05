import type { NormalizedRumConfiguration } from './config.js';
import {
  clearAnonymousUserId,
  getAnonymousUserId,
  readBrowserEnvironment,
} from './environment.js';
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
  RumTransportStats,
  RumUser,
  TrackingConsent,
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
  private sessionManager?: SessionManager;
  private eventTransport?: EventTransport;
  private replayRecorder?: ReplayRecorder;
  private readonly browserEnvironment: RumContext;
  private anonymousUserId?: string;
  private user?: RumUser;
  private globalContext: RumContext;
  private trackingConsent: TrackingConsent;
  private consentTransition: Promise<void> = Promise.resolve();
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
    this.trackingConsent = config.trackingConsent;
    this.browserEnvironment = this.browser
      ? (readBrowserEnvironment() as RumContext)
      : {};

    if (this.browser && this.trackingConsent === 'granted') this.activate();
  }

  setUser(user: RumUser): void {
    if (!user || typeof user.id !== 'string' || !user.id.trim()) {
      throw new TypeError('MoleSignal RUM user.id must be a non-empty string');
    }
    this.user = { ...sanitizeContext(user), id: user.id.trim() } as RumUser;
    this.markSessionDirty();
  }

  clearUser(): void {
    this.user = undefined;
    this.markSessionDirty();
  }

  getUser(): RumUser | undefined {
    return this.user ? ({ ...this.user } as RumUser) : undefined;
  }

  setGlobalContext(context: RumContext): void {
    this.globalContext = sanitizeContext(context);
    this.markSessionDirty();
  }

  setGlobalContextProperty(key: string, value: unknown): void {
    if (!key.trim()) return;
    this.globalContext[key] = value;
    this.markSessionDirty();
  }

  removeGlobalContextProperty(key: string): void {
    delete this.globalContext[key];
    this.markSessionDirty();
  }

  getGlobalContext(): RumContext {
    return { ...sanitizeContext(this.globalContext) };
  }

  addAction(name: string, context: RumContext = {}): void {
    if (!name || !this.canTrack()) return;
    this.recordAction({
      type: 'custom',
      name,
      context,
    });
  }

  addError(error: unknown, context: RumContext = {}): void {
    if (!this.canTrack()) return;
    this.recordError(error, context, 'manual');
  }

  startView(name?: string, context: RumContext = {}): void {
    if (!this.canTrack()) return;
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
    if (!this.canTrack()) return;
    this.replayOverride = true;
    this.prepareSession();
  }

  stopSessionReplayRecording(): void {
    this.replayOverride = false;
    this.replayRecorder?.stop();
  }

  setTrackingConsent(consent: TrackingConsent): void {
    if (consent !== 'granted' && consent !== 'not-granted') {
      throw new TypeError(
        'MoleSignal RUM tracking consent must be "granted" or "not-granted"',
      );
    }
    if (this.stopped || consent === this.trackingConsent) return;
    this.trackingConsent = consent;

    if (consent === 'not-granted') {
      const transport = this.eventTransport;
      const sessionManager = this.sessionManager;
      this.deactivateInstrumentation();
      this.eventTransport = undefined;
      this.sessionManager = undefined;
      this.replayRecorder = undefined;
      this.anonymousUserId = undefined;
      this.replayOverride = undefined;
      this.recentErrors.clear();
      sessionManager?.clear();
      clearAnonymousUserId(this.config);
      const discard = transport?.discard() ?? Promise.resolve();
      this.consentTransition = Promise.all([this.consentTransition, discard]).then(
        () => undefined,
      );
      return;
    }

    this.consentTransition = this.consentTransition.then(() => {
      if (!this.stopped && this.trackingConsent === 'granted') this.activate();
    });
  }

  getTrackingConsent(): TrackingConsent {
    return this.trackingConsent;
  }

  getInternalContext(): RumInternalContext {
    const session = this.sessionManager?.current();
    const context: RumInternalContext = {
      application_id: this.config.applicationId,
      session_id:
        this.trackingConsent === 'granted' && session?.sampled
          ? session.id
          : undefined,
      user_id:
        this.trackingConsent === 'granted' ? this.currentUserId() : undefined,
      service: this.config.service,
      env: this.config.env,
      version: this.config.version,
    };
    return compact(context);
  }

  getTransportStats(): RumTransportStats {
    return this.eventTransport?.getStats() ?? emptyTransportStats();
  }

  async flush(): Promise<void> {
    if (!this.canTrack()) return;
    this.performanceInstrumentation?.report();
    this.reportCurrentSession();
    await this.eventTransport?.flush(false);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const transport = this.eventTransport;
    this.performanceInstrumentation?.report();
    const session = this.sessionManager?.current();
    if (session?.sampled) {
      this.sessionManager?.finish(session.id);
      this.reportSession(session);
    }
    this.deactivateInstrumentation();
    this.stopped = true;
    this.stopPromise = (async () => {
      await this.consentTransition;
      await transport?.stop();
    })();
    return this.stopPromise;
  }

  private activate(): void {
    if (
      !this.browser ||
      this.stopped ||
      this.trackingConsent !== 'granted' ||
      this.eventTransport
    ) {
      return;
    }
    const sessionManager = new SessionManager(this.config);
    const eventTransport = new EventTransport(this.config, (sessionId) =>
      sessionManager.nextReplaySequence(sessionId),
    );
    this.sessionManager = sessionManager;
    this.eventTransport = eventTransport;
    this.replayRecorder = new ReplayRecorder(this.config, (sessionId, event) => {
      const prepared = this.applyReplayBeforeSend(event);
      if (prepared) this.eventTransport?.enqueueReplay(sessionId, prepared);
    });
    this.anonymousUserId = getAnonymousUserId(this.config);
    this.start();
  }

  private start(): void {
    this.eventTransport?.start();
    this.prepareSession();
    if (this.config.sessionSampleRate <= 0) return;

    const hooks = this.instrumentationHooks();
    this.performanceInstrumentation = instrumentPerformance(hooks, {
      trackWebVitals: this.config.trackWebVitals,
      trackResources: this.config.trackResources,
      trackLongTasks: this.config.trackLongTasks,
      onError: this.config.onError,
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

  private deactivateInstrumentation(): void {
    this.replayRecorder?.stop();
    this.performanceInstrumentation?.stop();
    this.performanceInstrumentation = undefined;
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (error) {
        reportInternalError(this.config.onError, error, 'RUM cleanup failed');
      }
    }
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
      isSdkUrl: (url) => this.eventTransport?.isSdkUrl(url) ?? false,
      shouldTrackUrl: (url) => !matchesUrl(url, this.config.excludedUrls),
      shouldReadTrace: (url) => this.shouldReadTrace(url),
    };
  }

  private installLifecycleListeners(): void {
    const flushKeepalive = (finishSession: boolean): void => {
      if (!this.canTrack()) return;
      this.performanceInstrumentation?.report();
      const session = this.sessionManager?.current();
      if (finishSession && session?.sampled) this.sessionManager?.finish(session.id);
      this.reportCurrentSession();
      void this.eventTransport?.flush(true);
    };
    const onPageHide = (): void => flushKeepalive(true);
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flushKeepalive(true);
    };
    const onOnline = (): void => {
      void this.eventTransport?.flush(false);
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    this.cleanups.push(() => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  }

  private recordAction(input: ActionInput): void {
    if (!this.canTrack()) return;
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
    if (this.enqueue('action', event)) {
      const sessionPage = page ? pagePath(page) : undefined;
      if (input.context?.source === 'web-vitals') {
        this.sessionManager?.touchPage(session.id, sessionPage);
      } else {
        this.sessionManager?.recordAction(session.id, input.type, sessionPage);
      }
    }

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
    if (!this.canTrack()) return;
    const session = this.prepareSession();
    if (!session?.sampled) return;
    const details = describeError(error);
    const stack = details.stack.map((frame) => ({
      ...frame,
      file: frame.file ? this.sanitizeUrl(frame.file) : undefined,
      debug_id: this.config.debugId,
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
      platform: 'web',
      runtime: 'browser',
      debug_id: this.config.debugId,
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
    if (this.enqueue('error', event)) {
      this.sessionManager?.recordError(
        session.id,
        page ? pagePath(page) : undefined,
      );
    }
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
    if (!this.canTrack() || !this.sessionManager) return undefined;
    const { session, created, previous } = this.sessionManager.ensure(true);
    if (previous?.sampled && (!previous.reported || previous.dirty)) {
      this.reportSession(previous);
    }
    if (created || previous) {
      this.replayOverride = undefined;
      this.recentErrors.clear();
    }
    const page = this.currentViewUrl || this.fallbackPage();
    this.sessionManager.touchPage(session.id, page ? pagePath(page) : undefined);
    if (this.isReplayEnabled(session)) this.replayRecorder?.start(session.id);
    else this.replayRecorder?.stop();
    if (session.sampled && !session.reported) this.reportSession(session);
    return session;
  }

  private reportSession(session: RumSession): void {
    if (!session.sampled || !this.eventTransport) return;
    const timestamp = nowMicros();
    const page = this.currentViewUrl || this.fallbackPage();
    const fallbackPage = page ? pagePath(page) : undefined;
    const endedAtMicros = Math.max(session.startedAtMicros, session.lastActivityMicros);
    const event = compact({
      ...this.commonFields(timestamp, session),
      timestamp,
      session_id: session.id,
      user_id: this.currentUserId(),
      started_at: session.startedAtMicros,
      started_at_micros: session.startedAtMicros,
      ended_at_micros: endedAtMicros,
      duration_ms: Math.max(
        0,
        Math.round((endedAtMicros - session.startedAtMicros) / 1_000),
      ),
      application: this.config.applicationId,
      app_version: this.config.version,
      environment: this.config.env,
      version: this.config.version,
      service: this.config.service,
      landing_page: session.landingPage ?? fallbackPage,
      last_page: session.lastPage ?? fallbackPage,
      view_count: session.viewCount,
      action_count: session.actionCount,
      error_count: session.errorCount,
      user: this.user ? sanitizeContext(this.user) : undefined,
      context: sanitizeContext(this.globalContext),
    });
    if (this.enqueue('session', event)) {
      this.sessionManager?.markReported(session.id);
    }
  }

  private reportCurrentSession(): void {
    const session = this.sessionManager?.current();
    if (session && this.sessionManager?.needsReport(session)) {
      this.reportSession(session);
    }
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

  private enqueue(
    kind: Exclude<RumEventKind, 'replay'>,
    event: RumContext,
  ): boolean {
    const prepared = this.applyBeforeSend(kind, event);
    return prepared ? (this.eventTransport?.enqueue(kind, prepared) ?? false) : false;
  }

  private recordReplay(session: RumSession, event: RumContext): void {
    if (!this.isReplayEnabled(session)) return;
    const prepared = this.applyBeforeSend('replay', event);
    if (prepared) this.eventTransport?.enqueueReplay(session.id, prepared);
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

  private canTrack(): boolean {
    return (
      this.browser &&
      !this.stopped &&
      this.trackingConsent === 'granted' &&
      !!this.sessionManager &&
      !!this.eventTransport
    );
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

  private markSessionDirty(): void {
    const session = this.sessionManager?.current();
    if (session) this.sessionManager?.markDirty(session.id);
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

function emptyTransportStats(): RumTransportStats {
  return {
    queued: 0,
    sent: 0,
    retried: 0,
    restored: 0,
    dropped: 0,
    droppedByReason: {
      queue_full: 0,
      serialization: 0,
      payload_too_large: 0,
      rejected: 0,
    },
  };
}
