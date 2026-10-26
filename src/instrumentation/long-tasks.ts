import { relativeToEpoch, toNanoseconds } from '../clock.js';
import type { RumLongTaskBody, RumLongTaskScript } from '../events.js';
import { clampText, compact, generateUuid } from '../utils.js';
import type { Cleanup, InstrumentationHooks } from './types.js';

const MAX_SCRIPTS = 32;
const INVOKER_TYPES = new Set([
  'user-callback',
  'event-listener',
  'resolve-promise',
  'reject-promise',
  'classic-script',
  'module-script',
]);

interface ScriptTimingLike extends PerformanceEntry {
  pauseDuration?: number;
  forcedStyleAndLayoutDuration?: number;
  executionStart?: number;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
  invoker?: string;
  invokerType?: string;
  windowAttribution?: string;
}

interface AnimationFrameLike extends PerformanceEntry {
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  firstUIEventTimestamp?: number;
  scripts?: ScriptTimingLike[];
}

export interface LongTaskTracker {
  /** Reports the entries the browser has queued but not delivered yet; returns how many. */
  flush(): number;
  stop: Cleanup;
}

/**
 * Collects long animation frames (Chromium 123+), which say which scripts were
 * responsible, and falls back to the older `longtask` entries elsewhere.
 */
export function instrumentLongTasks(hooks: InstrumentationHooks): LongTaskTracker {
  const noop: LongTaskTracker = { flush: () => 0, stop: () => undefined };
  if (typeof PerformanceObserver === 'undefined') return noop;

  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  const candidates = ['long-animation-frame', 'longtask'].filter(
    (type) => supported.length === 0 || supported.includes(type),
  );

  for (const type of candidates) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) report(entry, hooks);
      });
      observer.observe({ type, buffered: true });
      return {
        flush() {
          try {
            const entries = observer.takeRecords();
            for (const entry of entries) report(entry, hooks);
            return entries.length;
          } catch {
            // takeRecords is optional in older engines.
            return 0;
          }
        },
        stop() {
          observer.disconnect();
        },
      };
    } catch {
      // The entry type is not supported; try the next one.
    }
  }
  return noop;
}

function report(entry: PerformanceEntry, hooks: InstrumentationHooks): void {
  const view = hooks.findView(entry.startTime);
  if (!view) return;
  const sinceViewStart = (time: number): number => toNanoseconds(time - view.startRel);
  const frame = entry as AnimationFrameLike;
  const isFrame = entry.entryType === 'long-animation-frame';

  const body: RumLongTaskBody = compact({
    id: generateUuid(),
    duration: toNanoseconds(entry.duration),
    entry_type: isFrame ? ('long-animation-frame' as const) : ('long-task' as const),
    start_time: sinceViewStart(entry.startTime),
    blocking_duration: isFrame ? optionalDuration(frame.blockingDuration) : undefined,
    render_start: isFrame ? optionalTime(frame.renderStart, sinceViewStart) : undefined,
    style_and_layout_start: isFrame
      ? optionalTime(frame.styleAndLayoutStart, sinceViewStart)
      : undefined,
    first_ui_event_timestamp: isFrame
      ? optionalTime(frame.firstUIEventTimestamp, sinceViewStart)
      : undefined,
    scripts:
      isFrame && frame.scripts?.length
        ? frame.scripts
            .slice(0, MAX_SCRIPTS)
            .map((script) => scriptBody(script, hooks, sinceViewStart))
        : undefined,
  });
  // A frame can start a moment before the click that it handled, so a task
  // that overlaps an action's window belongs to it.
  const end = entry.startTime + entry.duration;
  const rel = hooks.findAction(entry.startTime) ? entry.startTime : hooks.findAction(end) ? end : entry.startTime;
  hooks.record({
    type: 'long_task',
    date: relativeToEpoch(entry.startTime),
    rel,
    body,
    view,
  });
}

function scriptBody(
  script: ScriptTimingLike,
  hooks: InstrumentationHooks,
  sinceViewStart: (time: number) => number,
): RumLongTaskScript {
  const invokerType = script.invokerType;
  return compact({
    duration: toNanoseconds(script.duration),
    pause_duration: optionalDuration(script.pauseDuration),
    forced_style_and_layout_duration: optionalDuration(script.forcedStyleAndLayoutDuration),
    start_time: sinceViewStart(script.startTime),
    execution_start: optionalTime(script.executionStart, sinceViewStart),
    source_url: script.sourceURL ? hooks.sanitizeUrl(script.sourceURL) : undefined,
    source_function_name: script.sourceFunctionName || undefined,
    source_char_position:
      typeof script.sourceCharPosition === 'number' && script.sourceCharPosition >= 0
        ? Math.round(script.sourceCharPosition)
        : undefined,
    invoker: script.invoker ? invokerText(script, hooks) : undefined,
    invoker_type:
      invokerType && INVOKER_TYPES.has(invokerType)
        ? (invokerType as RumLongTaskScript['invoker_type'])
        : undefined,
    window_attribution: script.windowAttribution || undefined,
  });
}

/**
 * The invoker names what ran: a script URL, or an event listener such as
 * `BUTTON#pay.onclick`. With the `mask` privacy level the element id is left
 * out, because ids can carry personal data.
 */
function invokerText(script: ScriptTimingLike, hooks: InstrumentationHooks): string {
  const invoker = script.invoker ?? '';
  if (script.invokerType === 'classic-script' || script.invokerType === 'module-script') {
    return clampText(hooks.sanitizeUrl(invoker), 1_024);
  }
  if (hooks.config.defaultPrivacyLevel === 'mask') {
    return clampText(invoker.replace(/#[^.]*/, ''), 256);
  }
  return clampText(invoker, 256);
}

function optionalDuration(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? toNanoseconds(value) : undefined;
}

function optionalTime(
  value: number | undefined,
  sinceViewStart: (time: number) => number,
): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? sinceViewStart(value)
    : undefined;
}
