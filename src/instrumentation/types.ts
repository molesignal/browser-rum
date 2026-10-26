import type { NormalizedRumConfiguration } from '../config.js';
import type { RumContext, RumEventType } from '../events.js';
import type { ActionHistory, ActionRecord } from '../view/history.js';
import type { PageActivityMonitor } from '../view/page-activity.js';
import type { ViewState } from '../view/tracker.js';

/**
 * What an instrumentation hands to the event pipeline. The pipeline finds the
 * view and action the event belongs to, adds the attributes every event shares,
 * runs `beforeSend`, updates the view's counters and queues it.
 */
export interface EventInput {
  type: Exclude<RumEventType, 'view'>;
  /** Epoch milliseconds at which the event began. */
  date: number;
  /**
   * `performance.now()` time at which the event began; it picks the view and
   * action the event belongs to. Leave it out for an event that is happening
   * now: it then belongs to the current view.
   */
  rel?: number;
  /** The type-specific object: `resource`, `error`, `long_task`, `action` or `vital`. */
  body: object;
  /** Event specific custom attributes, merged over the global and view context. */
  context?: RumContext;
  /** Place the event in this view instead of the one found at `rel`. */
  view?: ViewState;
  /** Frustration signals of an action; they are counted on the view. */
  frustrationCount?: number;
}

export type Cleanup = () => void;

export interface InstrumentationHooks {
  readonly config: NormalizedRumConfiguration;
  readonly activity: PageActivityMonitor;
  readonly actions: ActionHistory;
  /** Queues an event; false when it was dropped (no session, sampling, `beforeSend`). */
  record(input: EventInput): boolean;
  /** The view that was current at `rel`. */
  findView(rel: number): ViewState | undefined;
  /** The view of the page load, which FCP, LCP and the navigation timings describe. */
  initialView(): ViewState | undefined;
  /** Reports a view again (throttled) after something in it changed. */
  scheduleView(view: ViewState): void;
  /** The action in which an event starting at `rel` happened. */
  findAction(rel: number): ActionRecord | undefined;
  /** Keeps the session alive; call it for genuine user activity. */
  userActivity(eventRel?: number): void;
  sanitizeUrl(url: string): string;
  isSdkUrl(url: string): boolean;
  shouldTrackUrl(url: string): boolean;
  shouldReadTrace(url: string): boolean;
}
