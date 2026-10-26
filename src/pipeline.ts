import { perfNow } from './clock.js';
import type { NormalizedRumConfiguration } from './config.js';
import type { ContextStore } from './context.js';
import {
  type DeviceInfo,
  readConnectivity,
  readViewport,
} from './environment.js';
import type { RumEvent, RumEventType } from './events.js';
import type { EventInput } from './instrumentation/types.js';
import type { EventTransport } from './transport.js';
import { compact, reportInternalError, SDK_NAME, SDK_VERSION } from './utils.js';
import type { ActionHistory, ActionRecord } from './view/history.js';
import { buildViewBody, type ViewState, type ViewTracker } from './view/tracker.js';

/** Events other than views are limited per minute, to survive an error loop. */
const EVENT_RATE_LIMIT = 3_000;
const EVENT_RATE_WINDOW_MS = 60_000;

export interface PipelineDependencies {
  config: NormalizedRumConfiguration;
  contexts: ContextStore;
  views: ViewTracker;
  actions: ActionHistory;
  device: DeviceInfo;
  tabId: () => string | undefined;
  transport: () => EventTransport | undefined;
  /**
   * The view an event that began at `rel` belongs to; without `rel`, the view
   * that is current now. An implicit view is started if one is needed.
   */
  resolveView: (rel: number | undefined) => ViewState | undefined;
}

/**
 * Turns what the instrumentations observe into contract events: finds the view
 * and action an event belongs to, adds the attributes every event carries,
 * applies `beforeSend`, keeps the view's counters and queues the result.
 */
export class EventPipeline {
  private windowStartedAt = 0;
  private windowCount = 0;
  private rateLimitReported = false;

  constructor(private readonly deps: PipelineDependencies) {}

  /** Queues the current revision of a view. */
  recordView(view: ViewState): void {
    const event = this.assemble(view, 'view', view.startDate, buildViewBody(view));
    this.applyBeforeSend(event);
    this.deps.transport()?.enqueue(event as unknown as RumEvent);
  }

  record(input: EventInput): boolean {
    const view = input.view ?? this.deps.resolveView(input.rel);
    if (!view || !this.withinRateLimit()) return false;

    const action =
      input.type === 'action' || input.type === 'vital'
        ? undefined
        : this.deps.actions.find(input.rel ?? perfNow());
    const event = this.assemble(view, input.type, input.date, input.body, input.context, action);
    if (!this.applyBeforeSend(event)) return false;
    if (!this.deps.transport()?.enqueue(event as unknown as RumEvent)) return false;

    this.count(view, input, action);
    this.deps.views.schedule(view);
    return true;
  }

  private count(view: ViewState, input: EventInput, action: ActionRecord | undefined): void {
    switch (input.type) {
      case 'action':
        view.counts.action += 1;
        view.counts.frustration += input.frustrationCount ?? 0;
        break;
      case 'error':
        view.counts.error += 1;
        if (action) action.counts.error += 1;
        break;
      case 'resource':
        view.counts.resource += 1;
        if (action) action.counts.resource += 1;
        break;
      case 'long_task':
        view.counts.long_task += 1;
        if (action) action.counts.long_task += 1;
        break;
      default:
        break;
    }
  }

  private assemble(
    view: ViewState,
    type: RumEventType,
    date: number,
    body: object,
    context?: Record<string, unknown>,
    action?: ActionRecord,
  ): Record<string, unknown> & { type: RumEventType } {
    const { config, contexts } = this.deps;
    const event: Record<string, unknown> & { type: RumEventType } = {
      type,
      date,
      application: { id: config.applicationId },
      service: view.service ?? config.service,
      env: config.env,
      version: view.version ?? config.version,
      source: 'browser',
      session: compact({
        id: view.sessionId,
        type: 'user',
        start: view.sessionStart,
        has_replay: type === 'view' && view.hasReplay ? true : undefined,
      }),
      view: type === 'view' ? body : this.viewReference(view),
    };
    if (type === 'action') {
      event.action = body;
    } else {
      if (action) event.action = { id: action.id };
      if (type !== 'view') event[type] = body;
    }

    event.usr = contexts.eventUser();
    event.account = contexts.eventAccount();
    const tabId = this.deps.tabId();
    event.tab = tabId ? { id: tabId } : undefined;
    event.connectivity = readConnectivity();
    const viewport = readViewport();
    event.display = viewport ? { viewport } : undefined;
    event.device = hasKeys(this.deps.device) ? this.deps.device : undefined;
    event.sdk = {
      name: SDK_NAME,
      version: SDK_VERSION,
      session_sample_rate: config.sessionSampleRate,
      replay_sample_rate: config.sessionReplaySampleRate,
    };
    const merged = { ...contexts.getGlobalContext(), ...view.context, ...context };
    event.context = hasKeys(merged) ? merged : undefined;
    event.feature_flags = hasKeys(view.featureFlags) ? { ...view.featureFlags } : undefined;
    return compact(event);
  }

  private viewReference(view: ViewState): Record<string, unknown> {
    return compact({
      id: view.id,
      url: view.url,
      name: view.name,
      in_foreground: isForeground(),
    });
  }

  /** False only when `beforeSend` dropped the event; views cannot be dropped. */
  private applyBeforeSend(event: Record<string, unknown> & { type: RumEventType }): boolean {
    const hook = this.deps.config.beforeSend;
    if (!hook) return true;
    try {
      if (hook(event as unknown as RumEvent, { kind: event.type }) === false) {
        return event.type === 'view';
      }
    } catch (error) {
      reportInternalError(this.deps.config.onError, error, 'RUM beforeSend failed');
    }
    return true;
  }

  private withinRateLimit(): boolean {
    const now = Date.now();
    if (now - this.windowStartedAt >= EVENT_RATE_WINDOW_MS) {
      this.windowStartedAt = now;
      this.windowCount = 0;
      this.rateLimitReported = false;
    }
    this.windowCount += 1;
    if (this.windowCount <= EVENT_RATE_LIMIT) return true;
    if (!this.rateLimitReported) {
      this.rateLimitReported = true;
      reportInternalError(
        this.deps.config.onError,
        new Error(`more than ${EVENT_RATE_LIMIT} events in a minute`),
        'RUM events dropped',
      );
    }
    return false;
  }
}

function isForeground(): boolean | undefined {
  return typeof document === 'undefined' ? undefined : document.visibilityState === 'visible';
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}
