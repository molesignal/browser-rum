import { storageKey } from '../environment.js';

/**
 * Numbers the replay segments of a session. Tabs of the same session share
 * `localStorage`, so their segments do not reuse a number; without storage the
 * count is kept in memory.
 */
export class ReplaySequence {
  private readonly prefix: string;
  private readonly memory = new Map<string, number>();

  constructor(applicationId: string) {
    this.prefix = `molesignal_rum_replay_${storageKey(applicationId)}_`;
  }

  next(sessionId: string): number {
    const key = this.prefix + sessionId;
    let value = this.memory.get(sessionId) ?? 0;
    try {
      const stored = Number(localStorage.getItem(key));
      if (Number.isFinite(stored) && stored > value) value = Math.floor(stored);
    } catch {
      // Storage can be denied in private contexts.
    }
    value += 1;
    this.memory.set(sessionId, value);
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // The in-memory count still keeps this tab consistent.
    }
    return value;
  }

  /**
   * Removes the stored counters of sessions other than `currentSessionId`. The
   * in-memory counts stay, so late segments of an old session keep their order.
   */
  prune(currentSessionId: string): void {
    try {
      if (typeof localStorage === 'undefined' || typeof localStorage.key !== 'function') return;
      const stale: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(this.prefix) && key !== this.prefix + currentSessionId) {
          stale.push(key);
        }
      }
      for (const key of stale) localStorage.removeItem(key);
    } catch {
      // Storage can be denied in private contexts.
    }
  }

  clear(): void {
    this.memory.clear();
    this.prune('');
  }
}
