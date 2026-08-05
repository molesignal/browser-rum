import type { MetricType } from 'web-vitals';

import type { RumContext } from '../types.js';
import { pagePath, reportInternalError } from '../utils.js';
import type { ActionInput, InstrumentationHooks } from './types.js';

interface FirstInputEntry extends PerformanceEntry {
  processingStart: number;
}

interface ViewMetrics {
  lcpMs?: number;
  fidMs?: number;
  cls?: number;
  ttfbMs?: number;
  inpMs?: number;
  metricIds: Record<string, string>;
  navigationType?: string;
}

export interface PerformanceInstrumentation {
  startView(page: string): void;
  report(): void;
  stop(): void;
}

interface VitalSubscriber {
  report(metric: MetricType): void;
  onError?: (error: Error) => void;
}

const vitalSubscribers = new Set<VitalSubscriber>();
let vitalCollectorStarted = false;

export function instrumentPerformance(
  hooks: InstrumentationHooks,
  options: {
    trackWebVitals: boolean;
    trackResources: boolean;
    trackLongTasks: boolean;
    onError?: (error: Error) => void;
  },
): PerformanceInstrumentation {
  const observers: PerformanceObserver[] = [];
  const metricsByPage = new Map<string, ViewMetrics>();
  const lastReports = new Map<string, string>();
  const reportTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
  let currentPage: string | undefined;
  let stopped = false;
  let unsubscribeVitals: (() => void) | undefined;

  const metricsFor = (page: string): ViewMetrics => {
    let metrics = metricsByPage.get(page);
    if (!metrics) {
      metrics = { metricIds: {} };
      metricsByPage.set(page, metrics);
      while (metricsByPage.size > 20) {
        const oldest = metricsByPage.keys().next().value as string | undefined;
        if (!oldest) break;
        metricsByPage.delete(oldest);
        lastReports.delete(oldest);
      }
    }
    return metrics;
  };

  const reportPage = (page: string): void => {
    const metrics = metricsByPage.get(page);
    if (!metrics) return;
    const values = {
      lcpMs: metrics.lcpMs,
      fidMs: metrics.fidMs,
      cls: metrics.cls,
      ttfbMs: metrics.ttfbMs,
      inpMs: metrics.inpMs,
    };
    if (Object.values(values).every((value) => value === undefined)) return;
    const signature = JSON.stringify(values);
    if (signature === lastReports.get(page)) return;
    lastReports.set(page, signature);
    const input: ActionInput = {
      type: 'view',
      name: `View ${pagePath(page)} performance`,
      url: page,
      context: {
        source: 'web-vitals',
        inp_ms: metrics.inpMs,
        metric_ids: metrics.metricIds,
        navigation_type: metrics.navigationType,
      },
    };
    if (metrics.lcpMs !== undefined) input.lcpMs = metrics.lcpMs;
    if (metrics.fidMs !== undefined) input.fidMs = metrics.fidMs;
    if (metrics.cls !== undefined) input.cls = metrics.cls;
    if (metrics.ttfbMs !== undefined) input.ttfbMs = metrics.ttfbMs;
    hooks.recordAction(input);
  };

  const scheduleReport = (page: string): void => {
    if (reportTimers.has(page)) return;
    const timer = globalThis.setTimeout(() => {
      reportTimers.delete(page);
      if (!stopped) reportPage(page);
    }, 0);
    reportTimers.set(page, timer);
  };

  const report = (): void => {
    if (currentPage) reportPage(currentPage);
  };

  const startView = (page: string): void => {
    report();
    currentPage = page;
    metricsFor(page);
  };

  if (options.trackWebVitals) {
    unsubscribeVitals = subscribeToWebVitals(
      (metric) => {
        if (stopped) return;
        const rawPage = metric.navigationURL || currentPage || window.location.href;
        const page = hooks.sanitizeUrl(rawPage);
        const metrics = metricsFor(page);
        metrics.metricIds[metric.name.toLowerCase()] = metric.id;
        metrics.navigationType = metric.navigationType;
        switch (metric.name) {
          case 'CLS':
            metrics.cls = metric.value;
            break;
          case 'INP':
            metrics.inpMs = metric.value;
            break;
          case 'LCP':
            metrics.lcpMs = metric.value;
            break;
          case 'TTFB':
            metrics.ttfbMs = metric.value;
            break;
          case 'FCP':
            return;
        }
        scheduleReport(page);
      },
      options.onError,
    );

    // FID is no longer a Core Web Vital and is not exported by current
    // web-vitals versions. Keep it as a best-effort backwards-compatible field.
    observe('first-input', observers, (entries) => {
      const entry = entries[0] as FirstInputEntry | undefined;
      if (!entry || !currentPage) return;
      metricsFor(currentPage).fidMs = Math.max(
        0,
        entry.processingStart - entry.startTime,
      );
      scheduleReport(currentPage);
    });
  }

  if (typeof PerformanceObserver !== 'undefined') {
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
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);

  return {
    startView,
    report,
    stop: () => {
      if (stopped) return;
      report();
      stopped = true;
      unsubscribeVitals?.();
      for (const observer of observers) observer.disconnect();
      for (const timer of reportTimers.values()) globalThis.clearTimeout(timer);
      reportTimers.clear();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    },
  };
}

function subscribeToWebVitals(
  report: (metric: MetricType) => void,
  onError?: (error: Error) => void,
): () => void {
  const subscriber: VitalSubscriber = { report, onError };
  vitalSubscribers.add(subscriber);
  if (!vitalCollectorStarted) {
    vitalCollectorStarted = true;
    void import('web-vitals')
      .then(({ onCLS, onINP, onLCP, onTTFB }) => {
        const publish = (metric: MetricType): void => {
          for (const listener of vitalSubscribers) listener.report(metric);
        };
        const options = { reportAllChanges: true, reportSoftNavs: true };
        onCLS(publish, options);
        onINP(publish, options);
        onLCP(publish, options);
        onTTFB(publish, options);
      })
      .catch((error: unknown) => {
        vitalCollectorStarted = false;
        for (const listener of vitalSubscribers) {
          reportInternalError(
            listener.onError,
            error,
            'RUM Web Vitals failed to load',
          );
        }
      });
  }
  return () => vitalSubscribers.delete(subscriber);
}

function observe(
  type: string,
  observers: PerformanceObserver[],
  onEntries: (entries: PerformanceEntry[]) => void,
  extra: Record<string, unknown> = {},
): void {
  if (typeof PerformanceObserver === 'undefined') return;
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
