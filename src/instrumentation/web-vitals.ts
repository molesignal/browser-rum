import type { MetricWithAttribution } from 'web-vitals/attribution';

import { perfNow, toNanoseconds } from '../clock.js';
import type { RumViewPerformance } from '../events.js';
import { elementSelector } from '../selector.js';
import { compact, reportInternalError } from '../utils.js';
import type { ViewState } from '../view/tracker.js';
import type { Cleanup, InstrumentationHooks } from './types.js';

interface VitalSubscriber {
  report(metric: MetricWithAttribution): void;
  generateTarget(node: Node | null): string | undefined;
  onError?: (error: Error) => void;
}

interface FirstInputEntry extends PerformanceEntry {
  processingStart: number;
  target?: Node | null;
}

// web-vitals can only be started once per page, so its callbacks are shared by
// every client the page creates. The latest value of each metric is kept so a
// client that starts later still learns about metrics that were final already.
const subscribers = new Set<VitalSubscriber>();
const latest = new Map<string, MetricWithAttribution>();
let collectorStarted = false;
let activeSubscriber: VitalSubscriber | undefined;

function subscribe(subscriber: VitalSubscriber): () => void {
  subscribers.add(subscriber);
  activeSubscriber = subscriber;
  for (const metric of latest.values()) subscriber.report(metric);

  if (!collectorStarted) {
    collectorStarted = true;
    void import('web-vitals/attribution')
      .then(({ onCLS, onFCP, onINP, onLCP }) => {
        const publish = (metric: MetricWithAttribution): void => {
          latest.set(metric.name, metric);
          for (const listener of subscribers) listener.report(metric);
        };
        const options = {
          reportAllChanges: true,
          reportSoftNavs: true,
          generateTarget: (node: Node | null) => activeSubscriber?.generateTarget(node),
        };
        onFCP(publish, options);
        onLCP(publish, options);
        onINP(publish, options);
        onCLS(publish, options);
      })
      .catch((error: unknown) => {
        collectorStarted = false;
        for (const listener of subscribers) {
          reportInternalError(listener.onError, error, 'RUM Web Vitals failed to load');
        }
      });
  }
  return () => {
    subscribers.delete(subscriber);
    if (activeSubscriber === subscriber) activeSubscriber = [...subscribers].pop();
  };
}

/**
 * Reports Core Web Vitals into `view.performance`, with the attribution that
 * the `web-vitals` library provides: the element, and the sub-parts of LCP and
 * INP. FCP, LCP and FID describe the initial page load; INP and CLS are
 * assigned to the view in which the interaction or layout shift happened.
 */
export function instrumentWebVitals(hooks: InstrumentationHooks): Cleanup {
  const { defaultPrivacyLevel, actionNameAttribute } = hooks.config;

  const targetOf = (node: Node | null | undefined): string | undefined => {
    if (typeof Element === 'undefined' || !(node instanceof Element)) return undefined;
    try {
      return elementSelector(node, actionNameAttribute, defaultPrivacyLevel);
    } catch {
      return undefined;
    }
  };

  const update = (view: ViewState | undefined, apply: (performance: RumViewPerformance) => void): void => {
    if (!view) return;
    apply(view.performance);
    hooks.scheduleView(view);
  };

  const viewOf = (metric: MetricWithAttribution, decisiveTime?: number): ViewState | undefined => {
    if (metric.navigationType === 'soft-navigation' && metric.navigationStartTime !== undefined) {
      return hooks.findView(metric.navigationStartTime + 1);
    }
    if (metric.navigationType === 'back-forward-cache') return hooks.findView(perfNow());
    if (metric.name === 'FCP' || metric.name === 'LCP') return hooks.initialView();
    return hooks.findView(decisiveTime ?? perfNow()) ?? hooks.initialView();
  };

  const unsubscribe = subscribe({
    generateTarget: targetOf,
    onError: hooks.config.onError,
    report(metric) {
      switch (metric.name) {
        case 'FCP': {
          const view = viewOf(metric);
          update(view, (performance) => {
            performance.fcp = { timestamp: since(view, metric.value) };
          });
          break;
        }
        case 'LCP': {
          const view = viewOf(metric);
          const attribution = metric.attribution;
          update(view, (performance) => {
            performance.lcp = compact({
              timestamp: since(view, metric.value),
              target_selector: attribution.target,
              resource_url: attribution.url ? hooks.sanitizeUrl(attribution.url) : undefined,
              sub_parts: {
                load_delay: toNanoseconds(attribution.resourceLoadDelay),
                load_time: toNanoseconds(attribution.resourceLoadDuration),
                render_delay: toNanoseconds(attribution.elementRenderDelay),
              },
            });
          });
          break;
        }
        case 'INP': {
          const attribution = metric.attribution;
          const view = viewOf(metric, attribution.interactionTime);
          update(view, (performance) => {
            performance.inp = compact({
              duration: toNanoseconds(metric.value),
              timestamp:
                attribution.interactionTime === undefined
                  ? undefined
                  : since(view, attribution.interactionTime),
              target_selector: attribution.interactionTarget || undefined,
              sub_parts: {
                input_delay: toNanoseconds(attribution.inputDelay),
                processing_duration: toNanoseconds(attribution.processingDuration),
                presentation_delay: toNanoseconds(attribution.presentationDelay),
              },
            });
          });
          break;
        }
        case 'CLS': {
          const attribution = metric.attribution;
          const view = viewOf(metric, attribution.largestShiftTime);
          update(view, (performance) => {
            performance.cls = compact({
              score: Math.round(metric.value * 1e6) / 1e6,
              timestamp:
                attribution.largestShiftTime === undefined
                  ? undefined
                  : since(view, attribution.largestShiftTime),
              target_selector: attribution.largestShiftTarget || undefined,
            });
          });
          break;
        }
        default:
          break;
      }
    },
  });

  const stopFirstInput = observeFirstInput(hooks, targetOf, update);

  return () => {
    unsubscribe();
    stopFirstInput();
  };
}

/** First Input Delay is not a Core Web Vital any more, but the contract still carries it. */
function observeFirstInput(
  hooks: InstrumentationHooks,
  targetOf: (node: Node | null | undefined) => string | undefined,
  update: (view: ViewState | undefined, apply: (performance: RumViewPerformance) => void) => void,
): Cleanup {
  if (typeof PerformanceObserver === 'undefined') return () => undefined;
  try {
    const observer = new PerformanceObserver((list) => {
      const entry = list.getEntries()[0] as FirstInputEntry | undefined;
      if (!entry) return;
      const view = hooks.initialView();
      update(view, (performance) => {
        performance.fid = compact({
          duration: toNanoseconds(entry.processingStart - entry.startTime),
          timestamp: since(view, entry.startTime),
          target_selector: targetOf(entry.target),
        });
      });
    });
    observer.observe({ type: 'first-input', buffered: true });
    return () => observer.disconnect();
  } catch {
    return () => undefined;
  }
}

/** Nanoseconds from the start of the view to a `performance.now()` time. */
function since(view: ViewState | undefined, time: number): number {
  return toNanoseconds(time - (view?.startRel ?? 0));
}
