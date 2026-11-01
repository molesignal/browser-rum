import { perfNow, toNanoseconds, unrefTimer } from '../clock.js';
import type { Cleanup } from '../instrumentation/types.js';
import type { ViewState } from './tracker.js';

/** The page is measured at most this often while it scrolls. */
const MEASURE_INTERVAL_MS = 250;
/** Less than this further down is not worth reporting the view again. */
const MIN_DEPTH_CHANGE_PX = 16;

export interface ScrollState {
  /** From the top of the page to the bottom of the window, at its furthest. */
  maxDepth: number;
  maxDepthScrollTop: number;
  maxScrollHeight: number;
  maxScrollHeightTime?: number;
}

function measure(view: ViewState): boolean {
  const element = document.scrollingElement ?? document.documentElement;
  if (!element) return false;

  const top = Math.max(0, window.scrollY ?? element.scrollTop ?? 0);
  const height = Math.round(element.scrollHeight);
  const depth = Math.min(Math.round(top + window.innerHeight), height);

  const scroll = view.scroll;
  const deeper = depth - (scroll?.maxDepth ?? 0) >= MIN_DEPTH_CHANGE_PX;
  const taller = height > (scroll?.maxScrollHeight ?? 0);
  if (!deeper && !taller) return false;

  view.scroll = {
    maxDepth: deeper ? depth : (scroll?.maxDepth ?? depth),
    maxDepthScrollTop: deeper ? Math.round(top) : (scroll?.maxDepthScrollTop ?? Math.round(top)),
    maxScrollHeight: taller ? height : (scroll?.maxScrollHeight ?? height),
    maxScrollHeightTime: taller
      ? toNanoseconds(perfNow() - view.startRel)
      : scroll?.maxScrollHeightTime,
  };
  return true;
}

/**
 * Follows how far down the page each view goes, and how long the page grows to be. `current` is
 * the view of the moment; `changed` reports it again. Returned: what measures the view of the
 * moment right away, and what stops the following.
 */
export function instrumentScroll(
  current: () => ViewState | undefined,
  changed: (view: ViewState) => void,
): { measureNow: () => void; stop: Cleanup } {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  const measureNow = (): void => {
    const view = current();
    if (view && !view.ended && measure(view)) changed(view);
  };

  const onScroll = (): void => {
    if (timer !== undefined) return;
    timer = unrefTimer(
      globalThis.setTimeout(() => {
        timer = undefined;
        measureNow();
      }, MEASURE_INTERVAL_MS),
    );
  };

  const options = { capture: true, passive: true } as const;
  window.addEventListener('scroll', onScroll, options);
  window.addEventListener('load', measureNow);

  return {
    measureNow,
    stop() {
      window.removeEventListener('scroll', onScroll, options);
      window.removeEventListener('load', measureNow);
      if (timer !== undefined) globalThis.clearTimeout(timer);
      timer = undefined;
    },
  };
}
