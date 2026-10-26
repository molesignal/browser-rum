import { perfNow, relativeToEpoch, toNanoseconds, unrefTimer } from '../clock.js';
import type { RumActionBody } from '../events.js';
import { actionTargetName, elementSelector } from '../selector.js';
import { compact, generateUuid, reportInternalError } from '../utils.js';
import { type PageActivityEnd, waitPageActivityEnd } from '../view/page-activity.js';
import type { LongTaskTracker } from './long-tasks.js';
import type { ResourceCollector } from './resources.js';
import type { Cleanup, InstrumentationHooks } from './types.js';

/** A click action that has not settled after this long is closed without a loading time. */
const CLICK_ACTION_MAX_DURATION = 10_000;
/** Three clicks within this window, close to each other, are a rage click. */
const RAGE_CLICK_WINDOW_MS = 1_000;
const RAGE_CLICK_MIN_CLICKS = 3;
const RAGE_CLICK_MAX_DISTANCE = 100;
/** The longest an action waits for the frame it caused to be drawn. */
const FRAME_GRACE_MS = 150;
/** A timer this late means the main thread was blocked about as long as a long task. */
const BLOCKED_THRESHOLD_MS = 60;
const LONG_TASK_POLLS = 10;
const LONG_TASK_POLL_MS = 25;

type Frustration = NonNullable<RumActionBody['frustration']>['type'][number];

interface ClickSample {
  time: number;
  x: number;
  y: number;
}

export interface ClickTracker {
  /** The time of the latest click, for `interaction_to_next_view_time`. */
  lastClickRel(): number | undefined;
  /** Reports the clicks that are still waiting for the page to settle, as they are now. */
  flush(): void;
  stop: Cleanup;
}

interface PendingClick {
  cancel(): void;
  finishNow(): void;
  /** A later click ends this one early if the page has not reacted to it yet: it is dead. */
  endIfIdle(): void;
}

/**
 * Turns clicks into `click` actions. An action lasts until the page settles
 * after the click (DOM changes, requests, resources); the resources, errors
 * and long tasks that start in that time are counted on it. Frustration
 * signals are added: a rage click (three quick clicks in one place), a dead
 * click (the page did not react) and an error click (an error followed).
 */
export function instrumentClicks(
  hooks: InstrumentationHooks,
  collectors: { resources: ResourceCollector; longTasks: LongTaskTracker },
): ClickTracker {
  const { trackFrustrations, defaultPrivacyLevel, actionNameAttribute } = hooks.config;
  const samples: ClickSample[] = [];
  const pending = new Set<PendingClick>();
  let lastClick: number | undefined;

  const onClick = (event: MouseEvent): void => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const element = closestInteractiveElement(event.target, actionNameAttribute);
    if (!element) return;

    // Whatever the page does from now on is the reaction to this click, not to the earlier ones.
    for (const earlier of [...pending]) earlier.endIfIdle();

    const startRel = eventTime(event);
    lastClick = startRel;
    const record = hooks.actions.open(generateUuid(), startRel);
    const selector = elementSelector(element, actionNameAttribute, defaultPrivacyLevel);
    const { name, source } = actionTargetName(
      element,
      selector,
      defaultPrivacyLevel,
      actionNameAttribute,
    );
    const rect = element.getBoundingClientRect();
    const selectionAtClick = currentSelection();
    const frustrations = new Set<Frustration>();
    const detect = trackFrustrations && event.isTrusted;

    if (detect && isRageClick(samples, event)) frustrations.add('rage_click');

    let loadingTime: number | undefined;
    let done = false;
    const emit = (): void => {
      if (done) return;
      done = true;
      pending.delete(click);
      if (detect && record.counts.error > 0) frustrations.add('error_click');
      hooks.record({
        type: 'action',
        date: relativeToEpoch(startRel),
        rel: startRel,
        body: compact({
          id: record.id,
          type: 'click' as const,
          loading_time: loadingTime,
          target: compact({
            name,
            selector,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }),
          position: { x: Math.round(event.clientX), y: Math.round(event.clientY) },
          name_source: source,
          frustration: frustrations.size > 0 ? { type: [...frustrations] } : undefined,
          error: { count: record.counts.error },
          long_task: { count: record.counts.long_task },
          resource: { count: record.counts.resource },
        }),
        frustrationCount: frustrations.size,
      });
      hooks.actions.prune(perfNow());
    };

    const close = (end: PageActivityEnd): void => {
      const endRel = end.hadActivity && !end.timedOut ? end.end : perfNow();
      hooks.actions.close(record, endRel);
      if (end.hadActivity && !end.timedOut) loadingTime = toNanoseconds(end.end - startRel);
      if (detect && !end.hadActivity && isDeadClick(element, selectionAtClick)) {
        frustrations.add('dead_click');
      }
    };

    const cancelWait = waitPageActivityEnd(
      hooks.activity,
      (end) => {
        close(end);
        // A long animation frame is only reported once its frame is over.
        void afterNextFrame()
          .then(() => (end.lateness > BLOCKED_THRESHOLD_MS ? awaitLongTasks(collectors.longTasks) : undefined))
          .then(() => {
            collectors.longTasks.flush();
            return collectors.resources.settle(record.startRel, record.endRel ?? perfNow());
          })
          .catch((error: unknown) => {
            reportInternalError(hooks.config.onError, error, 'RUM action failed');
          })
          .then(emit);
      },
      { maxDuration: CLICK_ACTION_MAX_DURATION },
    );

    const click: PendingClick = {
      cancel: () => {
        cancelWait.cancel();
        done = true;
      },
      finishNow: () => {
        cancelWait.cancel();
        if (record.endRel === undefined) {
          close({ hadActivity: false, end: perfNow(), timedOut: false, lateness: 0 });
        }
        collectors.longTasks.flush();
        emit();
      },
      endIfIdle: () => {
        cancelWait.endIfIdle();
      },
    };
    pending.add(click);
  };

  document.addEventListener('click', onClick, true);

  return {
    lastClickRel: () => lastClick,
    flush() {
      for (const click of [...pending]) click.finishNow();
    },
    stop() {
      document.removeEventListener('click', onClick, true);
      for (const click of [...pending]) click.cancel();
      pending.clear();
    },
  };
}

/**
 * The main thread was blocked, so the browser has a long task to report for
 * this click. It does so a little after the fact: wait for it, briefly.
 */
async function awaitLongTasks(longTasks: LongTaskTracker): Promise<void> {
  for (let attempt = 0; attempt < LONG_TASK_POLLS; attempt += 1) {
    if (longTasks.flush() > 0) return;
    await new Promise<void>((resolve) =>
      unrefTimer(globalThis.setTimeout(resolve, LONG_TASK_POLL_MS)),
    );
  }
}

/** Resolves after a frame was drawn, or soon anyway if the page is hidden and draws none. */
function afterNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      globalThis.clearTimeout(timer);
      resolve();
    };
    const timer = unrefTimer(globalThis.setTimeout(finish, FRAME_GRACE_MS));
    if (typeof requestAnimationFrame === 'function') {
      // The first callback may run in the very frame being measured; the second in the next.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          globalThis.setTimeout(finish, 0);
        });
      });
    }
  });
}

/** The click time on the `performance.now()` clock; `timeStamp` also covers input delay. */
function eventTime(event: Event): number {
  const now = perfNow();
  const stamp = event.timeStamp;
  return typeof stamp === 'number' && stamp > 0 && stamp <= now + 1 ? stamp : now;
}

function isRageClick(samples: ClickSample[], event: MouseEvent): boolean {
  const now = Date.now();
  samples.push({ time: now, x: event.clientX, y: event.clientY });
  while ((samples[0]?.time ?? now) < now - RAGE_CLICK_WINDOW_MS) samples.shift();
  const nearby = samples.filter(
    (sample) =>
      Math.hypot(sample.x - event.clientX, sample.y - event.clientY) <= RAGE_CLICK_MAX_DISTANCE,
  );
  if (nearby.length < RAGE_CLICK_MIN_CLICKS) return false;
  samples.length = 0;
  return true;
}

function isDeadClick(element: HTMLElement, selectionAtClick: string): boolean {
  if (!canBeDeadClick(element) || !element.isConnected || isDisabled(element)) return false;
  return !selectionChangedAround(element, selectionAtClick);
}

function currentSelection(): string {
  try {
    return window.getSelection?.()?.toString() ?? '';
  } catch {
    // Selection can be unavailable in some embedded browsers.
    return '';
  }
}

/** Selecting text where the user clicked is a reaction, even if the page did not change. */
function selectionChangedAround(element: HTMLElement, before: string): boolean {
  try {
    const selection = window.getSelection?.();
    if (!selection || !selection.toString() || selection.toString() === before) return false;
    const anchor = selection.anchorNode;
    return !!anchor && (element.contains(anchor) || anchor.contains(element));
  } catch {
    return false;
  }
}

function closestInteractiveElement(
  element: Element,
  actionNameAttribute: string,
): HTMLElement | undefined {
  let current: Element | null = element;
  while (current) {
    if (current instanceof HTMLElement && current.hasAttribute(actionNameAttribute)) {
      return current;
    }
    current = current.parentElement;
  }
  const candidate = element.closest(
    'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[tabindex]',
  );
  return candidate instanceof HTMLElement ? candidate : undefined;
}

function canBeDeadClick(element: HTMLElement): boolean {
  if (
    element instanceof HTMLAnchorElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLLabelElement ||
    element.isContentEditable
  ) {
    return false;
  }
  return (
    element instanceof HTMLButtonElement ||
    element.getAttribute('role') === 'button' ||
    element.hasAttribute('tabindex')
  );
}

function isDisabled(element: HTMLElement): boolean {
  return (
    element.getAttribute('aria-disabled') === 'true' ||
    ('disabled' in element && Boolean((element as HTMLButtonElement).disabled))
  );
}
