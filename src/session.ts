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
}

export interface SessionResult {
  session: RumSession;
  created: boolean;
}

export class SessionManager {
  private readonly storageKey: string;
  private session: RumSession;
  private readonly completedReplaySequences = new Map<string, number>();

  constructor(private readonly config: NormalizedRumConfiguration) {
    this.storageKey = `molesignal_rum_session_${config.applicationId.replace(
      /[^\w.-]/g,
      '_',
    )}`;
    const stored = this.read();
    const now = nowMicros();
    this.session =
      stored && !this.isExpired(stored, now) ? stored : this.createSession(now);
    this.persist();
  }

  ensure(touch = true): SessionResult {
    const now = nowMicros();
    let created = false;
    if (this.isExpired(this.session, now)) {
      this.completedReplaySequences.set(this.session.id, this.session.replaySequence);
      this.session = this.createSession(now);
      created = true;
    }
    if (touch) {
      this.session.lastActivityMicros = now;
      this.persist();
    }
    return { session: this.session, created };
  }

  current(): RumSession {
    return this.ensure(false).session;
  }

  markReported(sessionId: string): void {
    if (this.session.id !== sessionId) return;
    this.session.reported = true;
    this.persist();
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
}
