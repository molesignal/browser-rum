import { toNanoseconds } from '../clock.js';
import { onPageLoaded, readNavigationTimings } from '../instrumentation/navigation.js';
import { type PageActivityMonitor, waitPageActivityEnd } from './page-activity.js';
import type { ViewState } from './tracker.js';

/** Activity that outlasts this is not waited for: a ticking clock must not keep us listening. */
const LOADING_MAX_DURATION = 30_000;

/**
 * Works out how long a view took to load. The page load fills the navigation
 * timings; the loading time is the later of the load event (initial load only)
 * and the moment the page settled after the view started (DOM and network).
 * Returns a function that cancels the measurement, for when the view ends first.
 */
export function trackLoadingTime(
  monitor: PageActivityMonitor,
  view: ViewState,
  options: { initialLoad: boolean; schedule: (view: ViewState) => void },
): () => void {
  const candidates: number[] = [];
  let waitingForLoad = options.initialLoad;
  let waitingForActivity = true;
  let cancelled = false;

  const publish = (): void => {
    if (cancelled || waitingForLoad || waitingForActivity || candidates.length === 0) return;
    view.loadingTime = Math.max(...candidates);
    options.schedule(view);
  };

  const cancelActivity = waitPageActivityEnd(
    monitor,
    (end) => {
      waitingForActivity = false;
      if (end.hadActivity && !end.timedOut) {
        const settled = toNanoseconds(end.end - view.startRel);
        view.networkSettledTime = settled;
        candidates.push(settled);
      }
      publish();
    },
    { maxDuration: LOADING_MAX_DURATION },
  );

  const cancelLoad = options.initialLoad
    ? onPageLoaded(() => {
        waitingForLoad = false;
        const timings = readNavigationTimings();
        view.navigation = timings;
        if (timings.load_event !== undefined) candidates.push(timings.load_event);
        options.schedule(view);
        publish();
      })
    : undefined;

  return () => {
    cancelled = true;
    cancelActivity.cancel();
    cancelLoad?.();
  };
}
