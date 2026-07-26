import type { RumContext } from '../types.js';
import { pagePath } from '../utils.js';
import type { ActionInput, InstrumentationHooks } from './types.js';

interface LargestContentfulPaintEntry extends PerformanceEntry {
  renderTime: number;
  loadTime: number;
  size: number;
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface FirstInputEntry extends PerformanceEntry {
  processingStart: number;
}

interface EventTimingEntry extends PerformanceEntry {
  duration: number;
  interactionId: number;
}

interface ViewMetrics {
  lcpMs?: number;
  fidMs?: number;
  cls?: number;
  ttfbMs?: number;
  inpMs?: number;
}

export interface PerformanceInstrumentation {
  startView(page: string): void;
  report(): void;
  stop(): void;
}

export function instrumentPerformance(
  hooks: InstrumentationHooks,
  options: {
    trackWebVitals: boolean;
    trackResources: boolean;
    trackLongTasks: boolean;
  },
): PerformanceInstrumentation {
  const observers: PerformanceObserver[] = [];
  const metrics: ViewMetrics = {};
  let currentPage: string | undefined;
  let lastReport = '';
  let isFirstView = true;
  let loadTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let removeLoadListener: (() => void) | undefined;

  const report = (): void => {
    if (!currentPage || Object.keys(metrics).length === 0) return;
    const signature = JSON.stringify(metrics);
    if (signature === lastReport) return;
    lastReport = signature;
    const input: ActionInput = {
      type: 'view',
      name: `View ${pagePath(currentPage)} performance`,
      url: currentPage,
      context: {
        source: 'web-vitals',
        inp_ms: metrics.inpMs,
      },
    };
    if (metrics.lcpMs !== undefined) input.lcpMs = metrics.lcpMs;
    if (metrics.fidMs !== undefined) input.fidMs = metrics.fidMs;
    if (metrics.cls !== undefined) input.cls = metrics.cls;
    if (metrics.ttfbMs !== undefined) input.ttfbMs = metrics.ttfbMs;
    hooks.recordAction(input);
  };

  const startView = (page: string): void => {
    report();
    currentPage = page;
    lastReport = '';
    delete metrics.lcpMs;
    delete metrics.fidMs;
    delete metrics.cls;
    delete metrics.inpMs;
    delete metrics.ttfbMs;

    if (isFirstView && options.trackWebVitals) {
      const navigation = performance
        .getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (navigation && navigation.responseStart >= 0) {
        metrics.ttfbMs = Math.max(0, navigation.responseStart - navigation.startTime);
      }
    }
    isFirstView = false;
  };

  if (typeof PerformanceObserver !== 'undefined') {
    if (options.trackWebVitals) {
      observe('largest-contentful-paint', observers, (entries) => {
        const entry = entries[entries.length - 1] as
          | LargestContentfulPaintEntry
          | undefined;
        if (!entry) return;
        metrics.lcpMs = Math.max(0, entry.renderTime || entry.loadTime || entry.startTime);
      });
      observe('layout-shift', observers, (entries) => {
        for (const entry of entries as LayoutShiftEntry[]) {
          if (!entry.hadRecentInput) metrics.cls = (metrics.cls ?? 0) + entry.value;
        }
      });
      observe('first-input', observers, (entries) => {
        const entry = entries[0] as FirstInputEntry | undefined;
        if (!entry) return;
        metrics.fidMs = Math.max(0, entry.processingStart - entry.startTime);
        globalThis.setTimeout(report, 0);
      });
      observe('event', observers, (entries) => {
        for (const entry of entries as EventTimingEntry[]) {
          if (entry.interactionId > 0) {
            metrics.inpMs = Math.max(metrics.inpMs ?? 0, entry.duration);
          }
        }
      }, { durationThreshold: 40 });
    }

    if (options.trackLongTasks) {
      observe('longtask', observers, (entries) => {
        for (const entry of entries) {
          hooks.recordAction({
            type: 'long_task',
            name: 'Long task',
            durationMs: entry.duration,
            context: {
              start_time_ms: entry.startTime,
              entry_type: entry.entryType,
            },
          });
        }
      });
    }

    if (options.trackResources) {
      observe('resource', observers, (entries) => {
        for (const rawEntry of entries) {
          const entry = rawEntry as PerformanceResourceTiming;
          if (
            entry.initiatorType === 'fetch' ||
            entry.initiatorType === 'xmlhttprequest' ||
            hooks.isSdkUrl(entry.name) ||
            !hooks.shouldTrackUrl(entry.name)
          ) {
            continue;
          }
          const url = hooks.sanitizeUrl(entry.name);
          let label = url;
          try {
            label = new URL(url).pathname;
          } catch {
            // Keep the sanitized URL.
          }
          const context: RumContext = {
            initiator: entry.initiatorType || 'resource',
            start_time_ms: entry.startTime,
            transfer_size: entry.transferSize,
            encoded_body_size: entry.encodedBodySize,
            decoded_body_size: entry.decodedBodySize,
          };
          const input: ActionInput = {
            type: 'resource',
            name: `${entry.initiatorType || 'resource'} ${label}`,
            url,
            durationMs: entry.duration,
            context,
          };
          if (entry.responseStatus && entry.responseStatus > 0) {
            input.status = entry.responseStatus;
          }
          hooks.recordAction(input);
        }
      });
    }
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') report();
  };
  const onPageHide = (): void => report();
  const onFirstInteraction = (): void => {
    globalThis.setTimeout(report, 0);
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pointerdown', onFirstInteraction, { once: true, capture: true });

  if (options.trackWebVitals) {
    const scheduleReport = (): void => {
      removeLoadListener = undefined;
      loadTimer = globalThis.setTimeout(report, 3_000);
    };
    if (document.readyState === 'complete') scheduleReport();
    else {
      window.addEventListener('load', scheduleReport, { once: true });
      removeLoadListener = () => window.removeEventListener('load', scheduleReport);
    }
  }

  return {
    startView,
    report,
    stop: () => {
      report();
      for (const observer of observers) observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pointerdown', onFirstInteraction, true);
      removeLoadListener?.();
      if (loadTimer !== undefined) globalThis.clearTimeout(loadTimer);
    },
  };
}

function observe(
  type: string,
  observers: PerformanceObserver[],
  onEntries: (entries: PerformanceEntry[]) => void,
  extra: Record<string, unknown> = {},
): void {
  try {
    const observer = new PerformanceObserver((list) => {
      onEntries(list.getEntries());
    });
    observer.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
    observers.push(observer);
  } catch {
    // Browsers differ in entry-type support; each observer is independently optional.
  }
}
