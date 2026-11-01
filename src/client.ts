import {
  epochToRelative,
  perfNow,
  relativeToEpoch,
  timeOriginEpoch,
  toNanoseconds,
} from './clock.js';
import { sessionPage, type NormalizedRumConfiguration } from './config.js';
import { ContextStore } from './context.js';
import {
  clearAnonymousUserId,
  clearTabId,
  getAnonymousUserId,
  getTabId,
  readDeviceInfo,
} from './environment.js';
import type { RumViewLoadingType } from './events.js';
import { ErrorRecorder, captureHandlingStack, instrumentErrors } from './instrumentation/errors.js';
import { instrumentClicks, type ClickTracker } from './instrumentation/clicks.js';
import {
  createLogger,
  createSdkReporter,
  instrumentConsole,
  type LogInput,
  recordLog,
} from './instrumentation/logs.js';
import { instrumentLongTasks, type LongTaskTracker } from './instrumentation/long-tasks.js';
import { instrumentNetwork } from './instrumentation/network.js';
import { createResourceCollector, type ResourceCollector } from './instrumentation/resources.js';
import { instrumentRoutes } from './instrumentation/routes.js';
import type { Cleanup, InstrumentationHooks } from './instrumentation/types.js';
import { instrumentWebVitals } from './instrumentation/web-vitals.js';
import { EventPipeline } from './pipeline.js';
import { ReplayRecorder } from './replay/recorder.js';
import { ReplaySequence } from './replay/sequence.js';
import { SessionManager, type SessionChange } from './session/manager.js';
import { createSessionStore, type SessionState } from './session/store.js';
import { publishTestSession } from './test-context.js';
import { EventTransport } from './transport.js';
import type {
  AddDurationVitalOptions,
  AddErrorOptions,
  DurationVitalOptions,
  DurationVitalReference,
  RumAccount,
  RumClient,
  RumContext,
  RumInternalContext,
  RumLogger,
  RumLoggerOptions,
  RumTransportStats,
  RumUser,
  StartViewOptions,
  StopDurationVitalOptions,
  TrackingConsent,
} from './types.js';
import {
  clampText,
  compact,
  generateUuid,
  isBrowserEnvironment,
  matchesUrl,
  reportInternalError,
  sanitizeContext,
  sanitizeUrl,
  sanitizeValue,
  sanitizeViewUrl,
  truncate,
  viewPath,
} from './utils.js';
import { ActionHistory } from './view/history.js';
import { trackLoadingTime } from './view/loading.js';
import { PageActivityMonitor } from './view/page-activity.js';
import { instrumentScroll } from './view/scroll.js';
import { ViewState, ViewTracker } from './view/tracker.js';

/** A route change this soon after a click is attributed to the click. */
const INTERACTION_TO_VIEW_WINDOW_MS = 3_000;
const MAX_CUSTOM_TIMINGS = 50;
const MAX_FEATURE_FLAGS = 100;
/** Numbers below this are `performance.now()` timestamps, above it epoch milliseconds. */
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

interface PendingVital {
  reference: DurationVitalReference;
  startRel: number;
  startDate: number;
  context: RumContext;
  description?: string;
}

/** Everything that exists only while the SDK is collecting: consent given, in a browser. */
interface Runtime {
  sessions: SessionManager;
  transport: EventTransport;
  views: ViewTracker;
  pipeline: EventPipeline;
  actions: ActionHistory;
  activity: PageActivityMonitor;
  replay: ReplayRecorder;
  replaySequence: ReplaySequence;
  hooks: InstrumentationHooks;
  errors: ErrorRecorder;
  tabId: string;
  cleanups: Cleanup[];
  resources?: ResourceCollector;
  longTasks: LongTaskTracker;
  clicks?: ClickTracker;
  stopLoading?: () => void;
  measureScroll?: () => void;
  vitals: Map<string, PendingVital>;
  documentCollected: boolean;
  /** Set while an explicit `startView` creates the view the session change would. */
  autoViewSuppressed: boolean;
  /** When the user event that is renewing the session happened, if known. */
  startHint?: number;
}

export class BrowserRumClient implements RumClient {
  private readonly browser = isBrowserEnvironment();
  private readonly contexts: ContextStore;
  private runtime?: Runtime;
  private trackingConsent: TrackingConsent;
  private consentTransition: Promise<void> = Promise.resolve();
  private stopped = false;
  private stopPromise?: Promise<void>;
  readonly logger: RumLogger;

  constructor(private readonly config: NormalizedRumConfiguration) {
    this.logger = createLogger((input) => this.writeLog(input));
    if (config.trackSdkErrors) {
      const report = createSdkReporter(() => this.live()?.hooks);
      const given = config.onError;
      config.onError = (error) => {
        given?.(error);
        report(error);
      };
    }
    this.contexts = new ContextStore({
      user: config.user,
      account: config.account,
      globalContext: config.globalContext,
    });
    this.trackingConsent = config.trackingConsent;
    if (this.browser && this.trackingConsent === 'granted') this.activate();
  }

  setUser(user: RumUser): void {
    this.contexts.setUser(user);
    this.refreshView();
  }

  getUser(): RumUser | undefined {
    return this.contexts.getUser();
  }

  setUserProperty(key: string, value: unknown): void {
    this.contexts.setUserProperty(key, value);
    this.refreshView();
  }

  removeUserProperty(key: string): void {
    this.contexts.removeUserProperty(key);
    this.refreshView();
  }

  clearUser(): void {
    this.contexts.clearUser();
    this.refreshView();
  }

  setAccount(account: RumAccount): void {
    this.contexts.setAccount(account);
    this.refreshView();
  }

  getAccount(): RumAccount | undefined {
    return this.contexts.getAccount();
  }

  setAccountProperty(key: string, value: unknown): void {
    this.contexts.setAccountProperty(key, value);
    this.refreshView();
  }

  removeAccountProperty(key: string): void {
    this.contexts.removeAccountProperty(key);
    this.refreshView();
  }

  clearAccount(): void {
    this.contexts.clearAccount();
    this.refreshView();
  }

  setGlobalContext(context: RumContext): void {
    this.contexts.setGlobalContext(context);
    this.refreshView();
  }

  setGlobalContextProperty(key: string, value: unknown): void {
    this.contexts.setGlobalContextProperty(key, value);
    this.refreshView();
  }

  removeGlobalContextProperty(key: string): void {
    this.contexts.removeGlobalContextProperty(key);
    this.refreshView();
  }

  clearGlobalContext(): void {
    this.contexts.clearGlobalContext();
    this.refreshView();
  }

  getGlobalContext(): RumContext {
    return this.contexts.getGlobalContext();
  }

  addAction(name: string, context: RumContext = {}): void {
    const runtime = this.live();
    if (!runtime || typeof name !== 'string' || !name.trim()) return;
    runtime.pipeline.record({
      type: 'action',
      date: Date.now(),
      body: {
        id: generateUuid(),
        type: 'custom',
        target: { name: truncate(name.trim(), 1_024) },
      },
      context: sanitizeContext(context),
    });
  }

  addError(error: unknown, context: RumContext = {}, options?: AddErrorOptions): void {
    const runtime = this.live();
    if (!runtime) return;
    runtime.errors.record({
      error,
      source: 'custom',
      handling: 'handled',
      handlingStack: captureHandlingStack(),
      context,
      fingerprint: options?.fingerprint,
    });
  }

  addTiming(name: string, time?: number): void {
    const runtime = this.live();
    const view = runtime?.views.current;
    if (!runtime || !view || typeof name !== 'string') return;
    const key = name.replace(/[^A-Za-z0-9_.@$-]/g, '_').slice(0, 128);
    if (!key) return;
    if (!(key in view.customTimings) && Object.keys(view.customTimings).length >= MAX_CUSTOM_TIMINGS) {
      return;
    }
    const rel = time === undefined ? perfNow() : toRelative(time);
    view.customTimings[key] = toNanoseconds(rel - view.startRel);
    runtime.views.schedule(view);
  }

  addFeatureFlagEvaluation(key: string, value: unknown): void {
    const runtime = this.live();
    const view = runtime?.views.current;
    if (!runtime || !view || typeof key !== 'string' || !key.trim()) return;
    if (!(key in view.featureFlags) && Object.keys(view.featureFlags).length >= MAX_FEATURE_FLAGS) {
      return;
    }
    view.featureFlags = { ...view.featureFlags, [key]: sanitizeValue(value) };
    runtime.views.schedule(view);
  }

  createLogger(options?: RumLoggerOptions): RumLogger {
    return createLogger((input) => this.writeLog(input), options);
  }

  /** Writes one log; the loggers of the API come here. */
  writeLog(input: LogInput): void {
    const runtime = this.live();
    if (runtime) recordLog(runtime.hooks, input);
  }

  startView(nameOrOptions?: string | StartViewOptions, context?: RumContext): void {
    const runtime = this.live();
    if (!runtime) return;
    const options = normalizeViewOptions(nameOrOptions, context);

    runtime.autoViewSuppressed = true;
    let session: SessionState;
    try {
      session = runtime.sessions.touch();
    } finally {
      runtime.autoViewSuppressed = false;
    }
    if (!session.tracked) return;

    const current = runtime.views.current;
    let loadingType: RumViewLoadingType = 'route_change';
    if (!runtime.views.initial) loadingType = 'initial_load';
    else if (!current || current.sessionId !== session.id) loadingType = 'session_renewal';
    this.beginView(session, loadingType, options);
  }

  setViewName(name: string): void {
    const runtime = this.live();
    const view = runtime?.views.current;
    if (!runtime || !view || typeof name !== 'string' || !name.trim()) return;
    view.name = clampText(name.trim(), 1_024);
    runtime.views.schedule(view);
  }

  setViewContext(context: RumContext): void {
    const runtime = this.live();
    const view = runtime?.views.current;
    if (!runtime || !view) return;
    view.context = sanitizeContext(context);
    runtime.views.schedule(view);
  }

  setViewContextProperty(key: string, value: unknown): void {
    const runtime = this.live();
    const view = runtime?.views.current;
    if (!runtime || !view || typeof key !== 'string' || !key.trim()) return;
    view.context = { ...view.context, ...sanitizeContext({ [key]: value }) };
    runtime.views.schedule(view);
  }

  getViewContext(): RumContext {
    return { ...(this.runtime?.views.current?.context ?? {}) };
  }

  setViewLoadingTime(): void {
    const runtime = this.live();
    const view = runtime?.views.current;
    if (!runtime || !view) return;
    runtime.stopLoading?.();
    runtime.stopLoading = undefined;
    view.loadingTime = toNanoseconds(perfNow() - view.startRel);
    runtime.views.schedule(view);
  }

  startDurationVital(
    name: string,
    options: DurationVitalOptions = {},
  ): DurationVitalReference | undefined {
    const runtime = this.live();
    if (!runtime || typeof name !== 'string' || !name.trim()) return undefined;
    const reference: DurationVitalReference = {
      id: generateUuid(),
      name: clampText(name.trim(), 256),
    };
    runtime.vitals.set(reference.id, {
      reference,
      startRel: perfNow(),
      startDate: Date.now(),
      context: sanitizeContext(options.context ?? {}),
      description: options.description,
    });
    return reference;
  }

  stopDurationVital(
    nameOrReference: string | DurationVitalReference,
    options: StopDurationVitalOptions = {},
  ): void {
    const runtime = this.live();
    if (!runtime) return;
    const pending = findPendingVital(runtime.vitals, nameOrReference);
    if (!pending) return;
    runtime.vitals.delete(pending.reference.id);

    const stopRel = options.stopTime === undefined ? perfNow() : toRelative(options.stopTime);
    this.recordVital(
      runtime,
      pending.reference.name,
      pending.startRel,
      pending.startDate,
      Math.max(0, stopRel - pending.startRel),
      { ...pending.context, ...sanitizeContext(options.context ?? {}) },
      options.description ?? pending.description,
    );
  }

  addDurationVital(name: string, options: AddDurationVitalOptions): void {
    const runtime = this.live();
    if (
      !runtime ||
      typeof name !== 'string' ||
      !name.trim() ||
      !options ||
      !Number.isFinite(options.startTime) ||
      !Number.isFinite(options.duration)
    ) {
      return;
    }
    const requestedRel = toRelative(options.startTime);
    this.recordVital(
      runtime,
      clampText(name.trim(), 256),
      // A start before the page loaded still belongs to the first view.
      Math.max(0, requestedRel),
      relativeToEpoch(requestedRel),
      Math.max(0, options.duration),
      sanitizeContext(options.context ?? {}),
      options.description,
    );
  }

  startSessionReplayRecording(): void {
    const runtime = this.live();
    if (!runtime) return;
    const session = runtime.sessions.get();
    if (!session?.tracked) return;
    this.syncReplay(runtime.sessions.setReplay(2));
  }

  stopSessionReplayRecording(): void {
    const runtime = this.live();
    if (!runtime) return;
    runtime.sessions.setReplay(0);
    runtime.replay.stop();
  }

  stopSession(): void {
    this.live()?.sessions.end();
  }

  getSessionReplayLink(): string | undefined {
    const session = this.live()?.sessions.get();
    return session?.tracked ? sessionPage(this.config, session.id) : undefined;
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
      const runtime = this.runtime;
      this.runtime = undefined;
      this.contexts.anonymousId = undefined;
      if (runtime) {
        this.deactivate(runtime);
        runtime.sessions.clear();
        runtime.replaySequence.clear();
      }
      clearAnonymousUserId(this.config);
      clearTabId(this.config);
      const discard = runtime?.transport.discard() ?? Promise.resolve();
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
    const runtime = this.runtime;
    const granted = this.trackingConsent === 'granted';
    const session = granted ? runtime?.sessions.get() : undefined;
    const view = runtime?.views.current;
    const action = runtime?.actions.current();
    return compact({
      application_id: this.config.applicationId,
      session_id: session?.tracked ? session.id : undefined,
      user_id: granted ? (this.contexts.getUser()?.id ?? this.contexts.anonymousId) : undefined,
      tab_id: granted ? runtime?.tabId : undefined,
      service: this.config.service,
      env: this.config.env,
      version: this.config.version,
      view:
        granted && session?.tracked && view
          ? compact({ id: view.id, url: view.url, name: view.name, referrer: view.referrer })
          : undefined,
      user_action: granted && action ? { id: action.id } : undefined,
    });
  }

  getTransportStats(): RumTransportStats {
    return this.runtime?.transport.getStats() ?? emptyTransportStats();
  }

  onReady(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      reportInternalError(this.config.onError, error, 'RUM onReady callback failed');
    }
  }

  async flush(): Promise<void> {
    const runtime = this.live();
    if (!runtime) return;
    this.drain(runtime);
    runtime.views.flush();
    await runtime.transport.flush(false);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const runtime = this.runtime;
    if (runtime) {
      this.drain(runtime, true);
      const view = runtime.views.current;
      if (view) runtime.views.end(view);
      runtime.views.flush();
      this.deactivate(runtime);
    }
    this.stopped = true;
    this.stopPromise = (async () => {
      await this.consentTransition;
      await runtime?.transport.stop();
    })();
    return this.stopPromise;
  }

  private activate(): void {
    if (
      !this.browser ||
      this.stopped ||
      this.trackingConsent !== 'granted' ||
      this.runtime ||
      this.config.sessionSampleRate <= 0
    ) {
      return;
    }
    const { config } = this;
    const tabId = getTabId(config);
    this.contexts.anonymousId = getAnonymousUserId(config);

    const replaySequence = new ReplaySequence(config.applicationId);
    const transport = new EventTransport(config, tabId, (sessionId) => replaySequence.next(sessionId));
    const actions = new ActionHistory();
    const activity = new PageActivityMonitor();
    const views = new ViewTracker({
      report: (view) => this.runtime?.pipeline.recordView(view),
    });
    const pipeline = new EventPipeline({
      config,
      contexts: this.contexts,
      views,
      actions,
      device: readDeviceInfo(),
      tabId: () => tabId,
      transport: () => transport,
      resolveView: (rel) => this.resolveView(rel),
    });
    const hooks: InstrumentationHooks = {
      config,
      activity,
      actions,
      record: (input) => pipeline.record(input),
      findView: (rel) => views.find(rel),
      initialView: () => views.initial ?? this.lazyInitialView(),
      scheduleView: (view) => views.schedule(view),
      findAction: (rel) => actions.find(rel),
      userActivity: (eventRel) => this.userActivity(eventRel),
      sanitizeUrl: (url) => this.sanitizeUrl(url),
      isSdkUrl: (url) => transport.isSdkUrl(url),
      shouldTrackUrl: (url) => !matchesUrl(url, config.excludedUrls),
      shouldReadTrace: (url) => this.shouldReadTrace(url),
    };
    const sessions = new SessionManager(config, createSessionStore(config), (change) =>
      this.onSessionChange(change),
    );
    const replay = new ReplayRecorder(
      config,
      (sessionId, event) => {
        runtime.transport.enqueueReplay(sessionId, event);
      },
      (recording) => this.onReplayChange(recording),
    );
    const runtime: Runtime = {
      sessions,
      transport,
      views,
      pipeline,
      actions,
      activity,
      replay,
      replaySequence,
      hooks,
      errors: new ErrorRecorder(hooks),
      tabId,
      cleanups: [],
      longTasks: { flush: () => 0, stop: () => undefined },
      vitals: new Map(),
      documentCollected: false,
      autoViewSuppressed: false,
    };
    this.runtime = runtime;

    transport.start();
    sessions.touch();
    this.install(runtime);
  }

  private install(runtime: Runtime): void {
    const { config } = this;
    const { hooks, cleanups } = runtime;

    cleanups.push(instrumentErrors(hooks, runtime.errors));

    const resources = createResourceCollector(hooks, runtime.errors);
    runtime.resources = resources;
    cleanups.push(instrumentNetwork(hooks, resources));
    cleanups.push(() => resources.stop());

    if (config.trackLongTasks) {
      runtime.longTasks = instrumentLongTasks(hooks);
      cleanups.push(() => runtime.longTasks.stop());
    }
    if (config.trackWebVitals) cleanups.push(instrumentWebVitals(hooks));
    if (config.trackUserInteractions) {
      const clicks = instrumentClicks(hooks, { resources, longTasks: runtime.longTasks });
      runtime.clicks = clicks;
      cleanups.push(() => clicks.stop());
    }
    if (!config.trackViewsManually) cleanups.push(instrumentRoutes(() => this.startView()));
    if (config.forwardConsoleLogs.length > 0) {
      cleanups.push(instrumentConsole(hooks, config.forwardConsoleLogs));
    }
    if (config.trackScroll) {
      const scroll = instrumentScroll(
        () => runtime.views.current,
        (view) => runtime.views.schedule(view),
      );
      runtime.measureScroll = scroll.measureNow;
      cleanups.push(scroll.stop);
      scroll.measureNow();
    }

    this.installLifecycle(runtime);
    this.installUserActivity(runtime);

    if (runtime.views.initial && !runtime.documentCollected) {
      runtime.documentCollected = true;
      resources.collectDocument();
    }
  }

  private deactivate(runtime: Runtime): void {
    runtime.stopLoading?.();
    runtime.stopLoading = undefined;
    runtime.replay.stop();
    runtime.views.stop();
    runtime.activity.stop();
    runtime.sessions.stop();
    runtime.errors.clear();
    for (const cleanup of runtime.cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (error) {
        reportInternalError(this.config.onError, error, 'RUM cleanup failed');
      }
    }
  }

  private installLifecycle(runtime: Runtime): void {
    const leave = (): void => {
      this.drain(runtime, true);
      runtime.views.setForeground(false);
      runtime.views.flush();
      void runtime.transport.flush(true, true);
    };
    const onPageHide = (): void => leave();
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        leave();
      } else {
        this.userActivity();
        runtime.views.setForeground(true);
      }
    };
    const onPageShow = (event: PageTransitionEvent): void => {
      if (!event.persisted) return;
      const session = runtime.sessions.touch();
      if (this.config.trackBfcacheViews && session.tracked) {
        this.beginView(session, 'bf_cache');
      } else {
        runtime.views.setForeground(true);
      }
    };
    const onOnline = (): void => {
      void runtime.transport.flush(false, true);
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    runtime.cleanups.push(() => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  }

  /** User input keeps the session alive; one touch per second is enough. */
  private installUserActivity(runtime: Runtime): void {
    let lastTouch = 0;
    const onActivity = (event: Event): void => {
      const now = Date.now();
      if (now - lastTouch < 1_000) return;
      lastTouch = now;
      this.userActivity(event.timeStamp);
    };
    const options = { capture: true, passive: true } as const;
    const events = ['click', 'keydown', 'touchstart', 'scroll'] as const;
    for (const type of events) window.addEventListener(type, onActivity, options);
    runtime.cleanups.push(() => {
      for (const type of events) window.removeEventListener(type, onActivity, options);
    });
  }

  private onSessionChange(change: SessionChange): void {
    const runtime = this.runtime;
    if (!runtime || this.stopped) return;
    switch (change.type) {
      case 'expired':
      case 'ended':
        this.endCurrentView(runtime);
        this.syncReplay(undefined);
        break;
      case 'switched':
        this.announceTestSession(change.session);
        this.syncReplay(change.session);
        if (!runtime.autoViewSuppressed) this.beginView(change.session, 'session_renewal');
        break;
      case 'started':
        this.announceTestSession(change.session);
        this.syncReplay(change.session);
        if (!runtime.autoViewSuppressed) this.autoStartView(runtime, change.session);
        break;
    }
  }

  /** A test that drives the page links to the session it became. */
  private announceTestSession(session: SessionState): void {
    if (this.config.testContext && session.tracked) publishTestSession(session.id);
  }

  /** The first view of a new session; with manual views the initial one waits for `startView`. */
  private autoStartView(runtime: Runtime, session: SessionState): void {
    if (!session.tracked) return;
    if (this.config.trackViewsManually && !runtime.views.initial) return;
    this.beginView(session, runtime.views.initial ? 'session_renewal' : 'initial_load');
  }

  private endCurrentView(runtime: Runtime): void {
    runtime.stopLoading?.();
    runtime.stopLoading = undefined;
    const view = runtime.views.current;
    if (view) runtime.views.end(view);
  }

  private beginView(
    session: SessionState,
    loadingType: RumViewLoadingType,
    options: StartViewOptions = {},
  ): ViewState | undefined {
    const runtime = this.runtime;
    if (!runtime || !session.tracked) return undefined;
    runtime.stopLoading?.();

    const initial = loadingType === 'initial_load';
    const now = perfNow();
    const hint = runtime.startHint;
    const startRel = initial ? 0 : hint !== undefined && hint > 0 && hint <= now ? hint : now;
    const url = this.viewUrl();
    const previous = runtime.views.current;
    const clickRel = runtime.clicks?.lastClickRel();
    const view = runtime.views.start({
      sessionId: session.id,
      sessionStart: session.created,
      startRel,
      startDate: initial ? timeOriginEpoch() : relativeToEpoch(startRel),
      loadingType,
      url,
      name: clampText(options.name?.trim() || viewPath(url), 1_024),
      referrer: initial ? this.documentReferrer() : previous?.url,
      service: options.service ? clampText(options.service, 256) : undefined,
      version: options.version ? clampText(options.version, 256) : undefined,
      context: options.context ? sanitizeContext(options.context) : undefined,
      interactionToNextViewTime:
        loadingType === 'route_change' &&
        clickRel !== undefined &&
        startRel >= clickRel &&
        startRel - clickRel <= INTERACTION_TO_VIEW_WINDOW_MS
          ? toNanoseconds(startRel - clickRel)
          : undefined,
      hasReplay: runtime.replay.isRecording(),
    });

    runtime.stopLoading = trackLoadingTime(runtime.activity, view, {
      initialLoad: initial,
      schedule: (target) => runtime.views.schedule(target),
    });
    if (initial && runtime.resources && !runtime.documentCollected) {
      runtime.documentCollected = true;
      runtime.resources.collectDocument();
    }
    runtime.measureScroll?.();
    return view;
  }

  /**
   * The view an event that began at `rel` belongs to; null when events are not
   * collected right now (no consent, no live session, sampled out).
   */
  private resolveView(rel: number | undefined): ViewState | undefined {
    const runtime = this.runtime;
    if (!runtime || this.stopped || this.trackingConsent !== 'granted') return undefined;
    // Looking at the session may renew it and start a new view, so look before choosing.
    const session = runtime.sessions.get();
    if (!session?.tracked) return undefined;
    const found =
      rel === undefined
        ? runtime.views.current && !runtime.views.current.ended
          ? runtime.views.current
          : undefined
        : runtime.views.find(rel);
    return found ?? this.lazyInitialView(session);
  }

  /** With manual views, events that arrive before the first `startView` get an implicit view. */
  private lazyInitialView(known?: SessionState): ViewState | undefined {
    const runtime = this.runtime;
    if (!runtime || runtime.views.initial || !this.config.trackViewsManually) return undefined;
    const session = known ?? runtime.sessions.get();
    return session?.tracked ? this.beginView(session, 'initial_load') : undefined;
  }

  /**
   * `eventRel` is when the user's event happened. If it renews the session, the
   * new view starts then, so the event itself is not left outside every view.
   */
  private userActivity(eventRel?: number): void {
    const runtime = this.live();
    if (!runtime) return;
    runtime.startHint = eventRel;
    try {
      runtime.sessions.touch();
    } finally {
      runtime.startHint = undefined;
    }
  }

  private syncReplay(session: SessionState | undefined): void {
    const runtime = this.runtime;
    if (!runtime) return;
    if (session?.tracked && session.replay > 0 && !this.stopped) {
      runtime.replaySequence.prune(session.id);
      runtime.replay.start(session.id);
    } else {
      runtime.replay.stop();
    }
  }

  private onReplayChange(recording: boolean): void {
    const runtime = this.runtime;
    const view = runtime?.views.current;
    if (!runtime || !view || !recording || view.hasReplay) return;
    view.hasReplay = true;
    runtime.views.schedule(view);
  }

  private recordVital(
    runtime: Runtime,
    name: string,
    startRel: number,
    startDate: number,
    durationMs: number,
    context: RumContext,
    description?: string,
  ): void {
    runtime.pipeline.record({
      type: 'vital',
      date: startDate,
      rel: startRel,
      body: compact({
        id: generateUuid(),
        type: 'duration' as const,
        name,
        description: description ? truncate(description, 1_024) : undefined,
        duration: toNanoseconds(durationMs),
      }),
      context,
    });
  }

  /**
   * Reports what the instrumentations still hold back, so the next flush sees it.
   * Clicks that are still waiting for the page to settle are only cut short when
   * the page is going away (`ending`); otherwise they finish on their own.
   */
  private drain(runtime: Runtime, ending = false): void {
    if (ending) runtime.clicks?.flush();
    runtime.longTasks.flush();
    runtime.resources?.flushPending();
  }

  /** Something every later event carries changed: report the view again. */
  private refreshView(): void {
    const runtime = this.live();
    const view = runtime?.views.current;
    if (runtime && view) runtime.views.schedule(view);
  }

  private live(): Runtime | undefined {
    return this.runtime && !this.stopped && this.trackingConsent === 'granted'
      ? this.runtime
      : undefined;
  }

  private viewUrl(): string {
    return sanitizeViewUrl(
      window.location.href,
      this.config.trackUrlQueryString,
      window.location.href,
    );
  }

  private documentReferrer(): string | undefined {
    return document.referrer
      ? sanitizeUrl(document.referrer, this.config.trackUrlQueryString)
      : undefined;
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

  private sanitizeUrl(url: string): string {
    return sanitizeUrl(
      url,
      this.config.trackUrlQueryString,
      isBrowserEnvironment() ? window.location.href : undefined,
    );
  }
}

function normalizeViewOptions(
  nameOrOptions: string | StartViewOptions | undefined,
  context: RumContext | undefined,
): StartViewOptions {
  const options: StartViewOptions =
    typeof nameOrOptions === 'string' ? { name: nameOrOptions } : { ...nameOrOptions };
  if (context) options.context = { ...options.context, ...context };
  return options;
}

function findPendingVital(
  pending: Map<string, PendingVital>,
  nameOrReference: string | DurationVitalReference,
): PendingVital | undefined {
  if (typeof nameOrReference === 'object' && nameOrReference !== null) {
    return pending.get(nameOrReference.id);
  }
  let found: PendingVital | undefined;
  for (const candidate of pending.values()) {
    if (candidate.reference.name === nameOrReference) found = candidate;
  }
  return found;
}

/** A `performance.now()` timestamp, from either that or epoch milliseconds. */
function toRelative(time: number): number {
  return time > ONE_YEAR_MS ? epochToRelative(time) : time;
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
