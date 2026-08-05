import type { NormalizedRumConfiguration } from './config.js';
import { generateId, nowMicros, sample } from './utils.js';

export interface RumSession {
  id: string;
  startedAtMicros: number;
  lastActivityMicros: number;
  sampled: boolean;
  replaySampled: boolean;
  reported: boolean;
  replaySequence: number;
  landingPage?: string;
  lastPage?: string;
  viewCount: number;
  actionCount: number;
  errorCount: number;
  dirty: boolean;
}

export interface SessionResult {
  session: RumSession;
  created: boolean;
  previous?: RumSession;
}

export class SessionManager {
  private readonly storageKey: string;
  private session: RumSession;
  private completedOnLoad?: RumSession;
  private readonly completedReplaySequences = new Map<string, number>();

  constructor(private readonly config: NormalizedRumConfiguration) {
    this.storageKey = `molesignal_rum_session_${config.applicationId.replace(
      /[^\w.-]/g,
      '_',
    )}`;
    const stored = this.read();
    const now = nowMicros();
    if (stored && !this.isExpired(stored, now)) {
      this.session = stored;
    } else {
      this.completedOnLoad = stored;
      if (stored) {
        this.completedReplaySequences.set(stored.id, stored.replaySequence);
      }
      this.session = this.createSession(now);
    }
    this.persist();
  }

  ensure(touch = true): SessionResult {
    const now = nowMicros();
    let created = false;
    let previous = this.completedOnLoad;
    this.completedOnLoad = undefined;
    if (this.isExpired(this.session, now)) {
      this.completedReplaySequences.set(this.session.id, this.session.replaySequence);
      previous = this.session;
      this.session = this.createSession(now);
      created = true;
    }
    if (touch) {
      this.session.lastActivityMicros = now;
      this.persist();
    }
    return { session: this.session, created, previous };
  }

  current(): RumSession {
    return this.session;
  }

  recordAction(sessionId: string, type: string, page?: string): void {
    if (this.session.id !== sessionId) return;
    this.updatePage(this.session, page);
    if (type === 'view') this.session.viewCount += 1;
    else this.session.actionCount += 1;
    this.session.dirty = true;
    this.persist();
  }

  recordError(sessionId: string, page?: string): void {
    if (this.session.id !== sessionId) return;
    this.updatePage(this.session, page);
    this.session.errorCount += 1;
    this.session.dirty = true;
    this.persist();
  }

  touchPage(sessionId: string, page?: string): void {
    if (this.session.id !== sessionId) return;
    this.updatePage(this.session, page);
    this.persist();
  }

  markDirty(sessionId: string): void {
    if (this.session.id !== sessionId) return;
    this.session.dirty = true;
    this.persist();
  }

  finish(sessionId: string): void {
    if (this.session.id !== sessionId) return;
    const now = nowMicros();
    const inactivityBoundary =
      this.session.lastActivityMicros + this.config.sessionInactivityTimeout * 1_000;
    const maximumBoundary =
      this.session.startedAtMicros + this.config.maxSessionDuration * 1_000;
    this.session.lastActivityMicros = Math.max(
      this.session.lastActivityMicros,
      Math.min(now, inactivityBoundary, maximumBoundary),
    );
    this.session.dirty = true;
    this.persist();
  }

  needsReport(session: RumSession): boolean {
    return session.sampled && (!session.reported || session.dirty);
  }

  markReported(sessionId: string): void {
    if (this.session.id !== sessionId) return;
    this.session.reported = true;
    this.session.dirty = false;
    this.persist();
  }

  clear(): void {
    this.completedOnLoad = undefined;
    this.completedReplaySequences.clear();
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.removeItem(this.storageKey);
    } catch {
      // Storage can be denied in private contexts.
    }
  }

  nextReplaySequence(sessionId: string): number {
    if (this.session.id === sessionId) {
      this.session.replaySequence += 1;
      this.persist();
      return this.session.replaySequence;
    }
    const next = (this.completedReplaySequences.get(sessionId) ?? 0) + 1;
    this.completedReplaySequences.set(sessionId, next);
    return next;
  }

  private createSession(now: number): RumSession {
    const sampled = sample(this.config.sessionSampleRate);
    return {
      id: generateId('ses'),
      startedAtMicros: now,
      lastActivityMicros: now,
      sampled,
      replaySampled: sampled && sample(this.config.sessionReplaySampleRate),
      reported: false,
      replaySequence: 0,
      viewCount: 0,
      actionCount: 0,
      errorCount: 0,
      dirty: true,
    };
  }

  private isExpired(session: RumSession, now: number): boolean {
    const inactivityMicros = this.config.sessionInactivityTimeout * 1_000;
    const maximumMicros = this.config.maxSessionDuration * 1_000;
    return (
      now - session.lastActivityMicros > inactivityMicros ||
      now - session.startedAtMicros > maximumMicros ||
      now < session.startedAtMicros
    );
  }

  private read(): RumSession | undefined {
    if (typeof sessionStorage === 'undefined') return undefined;
    try {
      const raw = sessionStorage.getItem(this.storageKey);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Partial<RumSession>;
      if (
        typeof parsed.id !== 'string' ||
        typeof parsed.startedAtMicros !== 'number' ||
        typeof parsed.lastActivityMicros !== 'number' ||
        typeof parsed.sampled !== 'boolean' ||
        typeof parsed.replaySampled !== 'boolean'
      ) {
        return undefined;
      }
      return {
        id: parsed.id,
        startedAtMicros: parsed.startedAtMicros,
        lastActivityMicros: parsed.lastActivityMicros,
        sampled: parsed.sampled,
        replaySampled: parsed.replaySampled,
        reported: parsed.reported === true,
        replaySequence:
          typeof parsed.replaySequence === 'number' && parsed.replaySequence >= 0
            ? Math.floor(parsed.replaySequence)
            : 0,
        landingPage:
          typeof parsed.landingPage === 'string' ? parsed.landingPage : undefined,
        lastPage: typeof parsed.lastPage === 'string' ? parsed.lastPage : undefined,
        viewCount: nonNegativeInteger(parsed.viewCount),
        actionCount: nonNegativeInteger(parsed.actionCount),
        errorCount: nonNegativeInteger(parsed.errorCount),
        // Upgrade previously persisted sessions by sending one aggregate update.
        dirty: parsed.dirty !== false,
      };
    } catch {
      return undefined;
    }
  }

  private persist(): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify(this.session));
    } catch {
      // Storage can be denied in private contexts. The in-memory session still works.
    }
  }

  private updatePage(session: RumSession, page: string | undefined): void {
    if (!page) return;
    session.landingPage ??= page;
    session.lastPage = page;
  }
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}
