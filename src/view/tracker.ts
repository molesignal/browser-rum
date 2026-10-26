import { perfNow, toNanoseconds, unrefTimer } from '../clock.js';
import type {
  RumContext,
  RumViewBody,
  RumViewLoadingType,
  RumViewPerformance,
} from '../events.js';
import { compact, generateUuid } from '../utils.js';

/** A view is re-reported at most this often while things keep changing. */
export const VIEW_UPDATE_THROTTLE = 3_000;
/** An active, visible view is re-reported this often even if nothing changed. */
export const VIEW_KEEP_ALIVE_INTERVAL = 5 * 60_000;
/** Ended views stay known this long, so late events and metrics still find them. */
const VIEW_RETENTION = 10 * 60_000;

export interface ViewCounts {
  action: number;
  error: number;
  resource: number;
  long_task: number;
  frustration: number;
}

export interface ViewNavigationTimings {
  first_byte?: number;
  dom_interactive?: number;
  dom_content_loaded?: number;
  dom_complete?: number;
  load_event?: number;
}

export interface ViewInit {
  sessionId: string;
  /** Epoch milliseconds at which the session began (`session.start`). */
  sessionStart: number;
  startRel: number;
  startDate: number;
  loadingType: RumViewLoadingType;
  url: string;
  name: string;
  referrer?: string;
  service?: string;
  version?: string;
  context?: RumContext;
  interactionToNextViewTime?: number;
  hasReplay?: boolean;
}

/** Everything the SDK knows about one view; `buildViewBody` turns it into an event. */
export class ViewState {
  readonly id = generateUuid();
  readonly sessionId: string;
  readonly sessionStart: number;
  readonly startRel: number;
  readonly startDate: number;
  readonly loadingType: RumViewLoadingType;
  readonly url: string;
  readonly referrer?: string;
  readonly service?: string;
  readonly version?: string;
  name: string;
  context: RumContext;
  featureFlags: Record<string, unknown> = {};
  /** Custom timings in nanoseconds since the start of the view. */
  customTimings: Record<string, number> = {};
  performance: RumViewPerformance = {};
  navigation: ViewNavigationTimings = {};
  loadingTime?: number;
  networkSettledTime?: number;
  interactionToNextViewTime?: number;
  readonly counts: ViewCounts = {
    action: 0,
    error: 0,
    resource: 0,
    long_task: 0,
    frustration: 0,
  };

  revision = 0;
  isActive = true;
  ended = false;
  endRel?: number;
  hasReplay = false;
  /** The view changed since its last report. */
  dirty = false;
  lastEmitAt = 0;
  timer?: ReturnType<typeof globalThis.setTimeout>;

  constructor(init: ViewInit) {
    this.sessionId = init.sessionId;
    this.sessionStart = init.sessionStart;
    this.startRel = init.startRel;
    this.startDate = init.startDate;
    this.loadingType = init.loadingType;
    this.url = init.url;
    this.name = init.name;
    this.referrer = init.referrer;
    this.service = init.service;
    this.version = init.version;
    this.context = init.context ?? {};
    this.interactionToNextViewTime = init.interactionToNextViewTime;
    this.hasReplay = init.hasReplay ?? false;
  }
}

export function buildViewBody(view: ViewState, now = perfNow()): RumViewBody {
  const end = view.ended ? (view.endRel ?? now) : now;
  return compact({
    id: view.id,
    url: view.url,
    name: view.name,
    referrer: view.referrer || undefined,
    revision: view.revision,
    is_active: view.isActive,
    loading_type: view.loadingType,
    loading_time: view.loadingTime,
    time_spent: toNanoseconds(end - view.startRel),
    ...view.navigation,
    network_settled_time: view.networkSettledTime,
    interaction_to_next_view_time: view.interactionToNextViewTime,
    performance: hasKeys(view.performance) ? view.performance : undefined,
    custom_timings: hasKeys(view.customTimings) ? view.customTimings : undefined,
    action: { count: view.counts.action },
    error: { count: view.counts.error },
    resource: { count: view.counts.resource },
    long_task: { count: view.counts.long_task },
    frustration: { count: view.counts.frustration },
  });
}

export interface ViewTrackerHooks {
  /** Builds and queues the view event for the revision that was just numbered. */
  report(view: ViewState): void;
}

/**
 * Owns the lifecycle of views. A view is reported as soon as it starts, again
 * (with a higher `revision`) at most every three seconds while something in it
 * changes, and one last time when it ends. Events that arrive after a view
 * ended still find it, and re-report it.
 */
export class ViewTracker {
  private views: ViewState[] = [];
  private keepAliveTimer?: ReturnType<typeof globalThis.setInterval>;
  current?: ViewState;
  /** The first `initial_load` view: page-load metrics belong to it. */
  initial?: ViewState;

  constructor(private readonly hooks: ViewTrackerHooks) {
    this.keepAliveTimer = unrefTimer(
      globalThis.setInterval(() => {
        const view = this.current;
        if (view && !view.ended && view.isActive) this.touch(view);
      }, VIEW_KEEP_ALIVE_INTERVAL),
    );
  }

  start(init: ViewInit): ViewState {
    const previous = this.current;
    if (previous && !previous.ended) this.end(previous, init.startRel);

    const view = new ViewState(init);
    this.views.push(view);
    this.current = view;
    if (view.loadingType === 'initial_load' && !this.initial) this.initial = view;
    this.prune();
    this.touch(view);
    return view;
  }

  /** Reports the final revision of a view; it stays known for late events. */
  end(view: ViewState, endRel = perfNow()): void {
    if (view.ended) return;
    view.ended = true;
    view.isActive = false;
    view.endRel = Math.max(endRel, view.startRel);
    if (this.current === view) this.current = undefined;
    this.touch(view);
  }

  /** The view that was current at `rel` (a `performance.now()` time). */
  find(rel: number): ViewState | undefined {
    for (let index = this.views.length - 1; index >= 0; index -= 1) {
      const view = this.views[index];
      if (!view || view.startRel > rel) continue;
      if (view.endRel === undefined || rel < view.endRel) return view;
    }
    return undefined;
  }

  /** Marks the view changed; it is reported now or, if reported recently, shortly. */
  schedule(view: ViewState): void {
    view.dirty = true;
    if (view.timer !== undefined) return;
    const wait = view.lastEmitAt + VIEW_UPDATE_THROTTLE - Date.now();
    if (wait <= 0) {
      this.emit(view);
      return;
    }
    view.timer = unrefTimer(
      globalThis.setTimeout(() => {
        view.timer = undefined;
        this.emit(view);
      }, wait),
    );
  }

  /** Reports every view that changed since its last report, right now. */
  flush(): void {
    for (const view of [...this.views]) {
      if (view.dirty) this.emit(view);
    }
  }

  /** The page went to the background or came back. */
  setForeground(visible: boolean): void {
    const view = this.current;
    if (!view || view.ended || view.isActive === visible) return;
    view.isActive = visible;
    if (visible) this.schedule(view);
    else this.touch(view);
  }

  stop(): void {
    if (this.keepAliveTimer !== undefined) globalThis.clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
    for (const view of this.views) {
      if (view.timer !== undefined) globalThis.clearTimeout(view.timer);
      view.timer = undefined;
    }
  }

  /** Reports the view immediately, regardless of the throttle. */
  private touch(view: ViewState): void {
    view.dirty = true;
    this.emit(view);
  }

  private emit(view: ViewState): void {
    if (view.timer !== undefined) {
      globalThis.clearTimeout(view.timer);
      view.timer = undefined;
    }
    view.dirty = false;
    view.lastEmitAt = Date.now();
    view.revision += 1;
    this.hooks.report(view);
  }

  private prune(): void {
    const now = perfNow();
    this.views = this.views.filter(
      (view) =>
        !view.ended ||
        view.timer !== undefined ||
        view.dirty ||
        now - (view.endRel ?? now) < VIEW_RETENTION,
    );
  }
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}
