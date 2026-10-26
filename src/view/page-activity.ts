import { perfNow, unrefTimer } from '../clock.js';

/** If the page does nothing for this long after a trigger, the trigger "had no activity". */
export const PAGE_ACTIVITY_VALIDATION_DELAY = 100;
/** Activity counts as over when the page has been quiet for this long. */
export const PAGE_ACTIVITY_END_DELAY = 100;

export type PageActivityKind = 'dom' | 'request-start' | 'request-end' | 'resource';

type ActivityListener = (kind: PageActivityKind) => void;

export interface PageActivityEnd {
  hadActivity: boolean;
  /** `performance.now()` time of the last observed activity. */
  end: number;
  /** True when the activity was still going on after `maxDuration`. */
  timedOut: boolean;
  /**
   * How much later than planned the timer that ended the wait fired, in
   * milliseconds. Well above zero means the main thread was blocked meanwhile.
   */
  lateness: number;
}

/**
 * A hub for "something happened on the page": DOM mutations, requests starting
 * and finishing, and sub-resources loading. A click or a navigation uses it to
 * tell whether the page reacted, and for how long.
 *
 * The MutationObserver only runs while somebody is waiting.
 */
export class PageActivityMonitor {
  private readonly listeners = new Set<ActivityListener>();
  private observer?: MutationObserver;

  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    this.startObserving();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopObserving();
    };
  }

  requestStarted(): void {
    this.emit('request-start');
  }

  requestEnded(): void {
    this.emit('request-end');
  }

  resourceLoaded(): void {
    this.emit('resource');
  }

  stop(): void {
    this.listeners.clear();
    this.stopObserving();
  }

  private emit(kind: PageActivityKind): void {
    for (const listener of [...this.listeners]) listener(kind);
  }

  private startObserving(): void {
    if (
      this.observer ||
      typeof MutationObserver === 'undefined' ||
      typeof document === 'undefined' ||
      !document.documentElement
    ) {
      return;
    }
    this.observer = new MutationObserver(() => this.emit('dom'));
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }

  private stopObserving(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }
}

export interface ActivityWait {
  /** Stops waiting without calling `onEnd`. */
  cancel(): void;
  /**
   * Ends the wait now, if the page has not done anything since it began. Returns
   * false (and keeps waiting) when there was activity.
   */
  endIfIdle(): boolean;
}

/**
 * Calls `onEnd` once the page settles after now: the first activity must show
 * up within the validation delay, and activity ends after a quiet period
 * with no request in flight.
 */
export function waitPageActivityEnd(
  monitor: PageActivityMonitor,
  onEnd: (end: PageActivityEnd) => void,
  options: { maxDuration?: number } = {},
): ActivityWait {
  let hadActivity = false;
  let finished = false;
  let pendingRequests = 0;
  let lastActivityAt = perfNow();
  let endTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  const unsubscribe = monitor.subscribe((kind) => {
    if (finished) return;
    hadActivity = true;
    lastActivityAt = perfNow();
    if (validationTimer !== undefined) {
      globalThis.clearTimeout(validationTimer);
      validationTimer = undefined;
    }
    if (kind === 'request-start') pendingRequests += 1;
    else if (kind === 'request-end') pendingRequests = Math.max(0, pendingRequests - 1);

    if (endTimer !== undefined) globalThis.clearTimeout(endTimer);
    endTimer = undefined;
    if (pendingRequests === 0) {
      const due = perfNow() + PAGE_ACTIVITY_END_DELAY;
      endTimer = unrefTimer(
        globalThis.setTimeout(
          () => finish(lastActivityAt, false, perfNow() - due),
          PAGE_ACTIVITY_END_DELAY,
        ),
      );
    }
  });

  const validationDue = perfNow() + PAGE_ACTIVITY_VALIDATION_DELAY;
  let validationTimer: ReturnType<typeof globalThis.setTimeout> | undefined = unrefTimer(
    globalThis.setTimeout(() => {
      validationTimer = undefined;
      finish(lastActivityAt, false, perfNow() - validationDue);
    }, PAGE_ACTIVITY_VALIDATION_DELAY),
  );
  const maxTimer =
    options.maxDuration === undefined
      ? undefined
      : unrefTimer(
          globalThis.setTimeout(() => finish(perfNow(), true, 0), options.maxDuration),
        );

  function finish(end: number, timedOut: boolean, lateness: number): void {
    if (finished) return;
    finished = true;
    cleanup();
    onEnd({ hadActivity, end, timedOut, lateness: Math.max(0, lateness) });
  }

  function cleanup(): void {
    unsubscribe();
    if (validationTimer !== undefined) globalThis.clearTimeout(validationTimer);
    if (endTimer !== undefined) globalThis.clearTimeout(endTimer);
    if (maxTimer !== undefined) globalThis.clearTimeout(maxTimer);
    validationTimer = undefined;
    endTimer = undefined;
  }

  return {
    cancel() {
      if (finished) return;
      finished = true;
      cleanup();
    },
    endIfIdle() {
      if (finished || hadActivity) return false;
      finish(perfNow(), false, 0);
      return true;
    },
  };
}
