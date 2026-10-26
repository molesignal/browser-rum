/**
 * Time helpers. The event contract measures `date` in epoch milliseconds and
 * every duration, or time relative to the start of a view, in integer
 * nanoseconds. Inside the SDK a "relative" time is a `performance.now()`
 * timestamp in milliseconds.
 */

export function perfNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Milliseconds to the contract's integer nanoseconds; negative or invalid input becomes 0. */
export function toNanoseconds(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 0;
  return Math.round(milliseconds * 1_000_000);
}

/**
 * Epoch milliseconds of a `performance.now()` timestamp. The conversion is
 * anchored to the current wall clock instead of `performance.timeOrigin`, so a
 * machine that slept since the page loaded does not skew recent entries.
 */
export function relativeToEpoch(relative: number): number {
  return Math.max(0, Math.round(Date.now() - (perfNow() - relative)));
}

export function epochToRelative(epoch: number): number {
  return perfNow() - (Date.now() - epoch);
}

/** Epoch milliseconds at which the current page load started. */
export function timeOriginEpoch(): number {
  if (
    typeof performance !== 'undefined' &&
    typeof performance.timeOrigin === 'number' &&
    performance.timeOrigin > 0
  ) {
    return Math.round(performance.timeOrigin);
  }
  return Math.round(Date.now() - perfNow());
}

/** Starts a timer that never keeps a Node process alive (a no-op in browsers). */
export function unrefTimer<T>(handle: T): T {
  const candidate = handle as unknown as { unref?: () => void };
  if (typeof candidate === 'object' && candidate !== null && typeof candidate.unref === 'function') {
    candidate.unref();
  }
  return handle;
}
