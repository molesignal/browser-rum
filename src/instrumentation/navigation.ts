import { toNanoseconds } from '../clock.js';
import type { ViewNavigationTimings } from '../view/tracker.js';

/**
 * Navigation timings of the page load, as nanoseconds since the navigation
 * started (or since the page was activated, for a prerendered page). Events
 * that have not happened yet are left out.
 */
export function readNavigationTimings(): ViewNavigationTimings {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
    return {};
  }
  try {
    const navigation = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (!navigation) return {};
    const activation = navigation.activationStart ?? 0;
    const since = (time: number): number | undefined =>
      time > activation ? toNanoseconds(time - activation) : undefined;
    const timings: ViewNavigationTimings = {
      first_byte: since(navigation.responseStart),
      dom_interactive: since(navigation.domInteractive),
      dom_content_loaded: since(navigation.domContentLoadedEventEnd),
      dom_complete: since(navigation.domComplete),
      load_event: since(navigation.loadEventEnd),
    };
    for (const key of Object.keys(timings) as Array<keyof ViewNavigationTimings>) {
      if (timings[key] === undefined) delete timings[key];
    }
    return timings;
  } catch {
    return {};
  }
}

/**
 * Calls `callback` once the load event handlers have run, so that
 * `loadEventEnd` is set. Returns a function that cancels the wait.
 */
export function onPageLoaded(callback: () => void): () => void {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const settle = (): void => {
    timer = globalThis.setTimeout(callback, 0);
  };
  if (document.readyState === 'complete') {
    settle();
    return () => {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }
  window.addEventListener('load', settle, { once: true });
  return () => {
    window.removeEventListener('load', settle);
    if (timer !== undefined) globalThis.clearTimeout(timer);
  };
}
