import type { NormalizedRumConfiguration } from '../config.js';
import { unrefTimer } from '../clock.js';
import { generateUuid, sample } from '../utils.js';
import type { SessionState, SessionStore } from './store.js';

/**
 * What the manager observed about the shared session since it last looked.
 * `started` is the first live session after none (or after `expired` / `ended`),
 * `switched` means another tab renewed the session under this one.
 */
export type SessionChange =
  | { type: 'started'; session: SessionState }
  | { type: 'switched'; session: SessionState; previous: SessionState }
  | { type: 'expired'; previous: SessionState }
  | { type: 'ended'; previous: SessionState };

/** Activity extends the stored expiry at most this often, to limit cookie writes. */
const EXTEND_STEP_MS = 1_000;

/**
 * Owns the lifecycle of the cookie-backed session: 15 minutes without
 * activity (configurable) or 4 hours in total end it, and the next user
 * activity starts a new one with a fresh sampling decision.
 */
export class SessionManager {
  private seen?: SessionState;
  private expiryTimer?: ReturnType<typeof globalThis.setTimeout>;
  private scheduledFor = 0;
  private active = true;

  constructor(
    private readonly config: NormalizedRumConfiguration,
    private readonly store: SessionStore,
    private readonly listener: (change: SessionChange) => void,
  ) {}

  get storageKind(): SessionStore['kind'] {
    return this.store.kind;
  }

  /** The live shared session, if any. Never starts one. */
  get(): SessionState | undefined {
    const now = Date.now();
    const live = this.readLive(now);
    this.observe(live);
    return live;
  }

  /** User activity: extends the live session, or starts a new one. */
  touch(): SessionState {
    const now = Date.now();
    let session = this.readLive(now);
    if (!session) {
      session = this.create(now);
      this.store.write(session);
      // Two tabs can start a session in the same instant; the last write wins.
      const winner = this.readLive(now);
      if (winner) session = winner;
    } else {
      const expire = this.nextExpire(session, now);
      if (expire - session.expire >= EXTEND_STEP_MS) {
        session = { ...session, expire };
        this.store.write(session);
      }
    }
    this.observe(session);
    return session;
  }

  /** Changes the replay decision of the live session (shared with other tabs). */
  setReplay(replay: SessionState['replay']): SessionState | undefined {
    const session = this.readLive(Date.now());
    if (!session) return undefined;
    if (session.replay === replay) return session;
    const next = { ...session, replay };
    this.store.write(next);
    this.observe(next);
    return next;
  }

  /** `stopSession()`: the session is over for every tab until the next activity. */
  end(): void {
    const previous = this.seen ?? this.readLive(Date.now());
    this.store.clear();
    this.clearTimer();
    this.seen = undefined;
    if (previous && this.active) this.listener({ type: 'ended', previous });
  }

  /** Stops watching; the shared session stays for the next page or tab. */
  stop(): void {
    this.active = false;
    this.clearTimer();
  }

  /** Stops watching and forgets the session, after consent is withdrawn. */
  clear(): void {
    this.stop();
    this.seen = undefined;
    this.store.clear();
  }

  private readLive(now: number): SessionState | undefined {
    const state = this.store.read();
    return state && !this.isExpired(state, now) ? state : undefined;
  }

  private isExpired(state: SessionState, now: number): boolean {
    return now >= state.expire || now >= state.created + this.config.maxSessionDuration;
  }

  private nextExpire(session: SessionState, now: number): number {
    return Math.min(
      now + this.config.sessionInactivityTimeout,
      session.created + this.config.maxSessionDuration,
    );
  }

  private create(now: number): SessionState {
    const tracked = sample(this.config.sessionSampleRate);
    return {
      id: generateUuid(),
      created: now,
      expire: now + this.config.sessionInactivityTimeout,
      tracked,
      replay: tracked && sample(this.config.sessionReplaySampleRate) ? 1 : 0,
    };
  }

  private observe(live: SessionState | undefined): void {
    if (!this.active) return;
    const previous = this.seen;
    this.seen = live;
    if (live) this.scheduleExpiryCheck(live);
    else this.clearTimer();

    if (live && !previous) {
      this.listener({ type: 'started', session: live });
    } else if (live && previous && live.id !== previous.id) {
      this.listener({ type: 'switched', session: live, previous });
    } else if (!live && previous) {
      this.listener({ type: 'expired', previous });
    }
  }

  /**
   * A single timer watches the expiry instead of polling. When it fires the
   * shared state is read again: another tab may have extended the session.
   */
  private scheduleExpiryCheck(session: SessionState): void {
    const expiresAt = Math.min(session.expire, session.created + this.config.maxSessionDuration);
    if (this.expiryTimer !== undefined && this.scheduledFor === expiresAt) return;
    this.clearTimer();
    this.scheduledFor = expiresAt;
    const delay = Math.max(50, expiresAt - Date.now() + 50);
    this.expiryTimer = unrefTimer(
      globalThis.setTimeout(() => {
        this.expiryTimer = undefined;
        this.get();
      }, delay),
    );
  }

  private clearTimer(): void {
    if (this.expiryTimer !== undefined) {
      globalThis.clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
  }
}
