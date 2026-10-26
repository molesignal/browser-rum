import type { NormalizedRumConfiguration } from '../config.js';
import { generateUuid } from '../utils.js';

/**
 * The session as shared between tabs. It lives in one cookie so that every tab
 * of the application sees the same session id, expiry and sampling decision.
 */
export interface SessionState {
  id: string;
  /** Epoch milliseconds at which the session started. */
  created: number;
  /** Epoch milliseconds at which the session expires if there is no more activity. */
  expire: number;
  /** False when the session was not selected by `sessionSampleRate`. */
  tracked: boolean;
  /** 0: no replay, 1: replay sampled, 2: replay forced by `startSessionReplayRecording()`. */
  replay: 0 | 1 | 2;
}

export interface SessionStore {
  readonly kind: 'cookie' | 'memory';
  read(): SessionState | undefined;
  write(state: SessionState): void;
  clear(): void;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const EPOCH_PAST = 'Thu, 01 Jan 1970 00:00:00 GMT';

export function encodeSession(state: SessionState): string {
  return [
    `id=${state.id}`,
    `created=${state.created}`,
    `expire=${state.expire}`,
    `tracked=${state.tracked ? 1 : 0}`,
    `replay=${state.replay}`,
  ].join('&');
}

export function decodeSession(raw: string): SessionState | undefined {
  const values = new Map<string, string>();
  for (const pair of raw.split('&')) {
    const separator = pair.indexOf('=');
    if (separator > 0) values.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const id = values.get('id');
  const created = Number(values.get('created'));
  const expire = Number(values.get('expire'));
  const replay = Number(values.get('replay') ?? 0);
  if (
    !id ||
    !SESSION_ID_PATTERN.test(id) ||
    !Number.isFinite(created) ||
    !Number.isFinite(expire) ||
    (replay !== 0 && replay !== 1 && replay !== 2)
  ) {
    return undefined;
  }
  return {
    id,
    created,
    expire,
    tracked: values.get('tracked') !== '0',
    replay,
  };
}

export class MemorySessionStore implements SessionStore {
  readonly kind = 'memory';
  private state?: SessionState;

  read(): SessionState | undefined {
    return this.state ? { ...this.state } : undefined;
  }

  write(state: SessionState): void {
    this.state = { ...state };
  }

  clear(): void {
    this.state = undefined;
  }
}

export interface CookieOptions {
  domain?: string;
  secure: boolean;
  crossSite: boolean;
}

export class CookieSessionStore implements SessionStore {
  readonly kind = 'cookie';

  constructor(
    private readonly name: string,
    private readonly options: CookieOptions,
    private readonly maxDuration: number,
  ) {}

  read(): SessionState | undefined {
    const raw = readCookie(this.name);
    return raw === undefined ? undefined : decodeSession(raw);
  }

  write(state: SessionState): void {
    const expires = new Date(Math.min(state.expire, state.created + this.maxDuration));
    writeCookie(this.name, encodeSession(state), expires, this.options);
  }

  clear(): void {
    writeCookie(this.name, '', new Date(EPOCH_PAST), this.options);
  }
}

/**
 * The cookie store when the browser accepts and returns cookies; otherwise a
 * per-page store, which still tracks one session but cannot share it between
 * tabs or page loads.
 */
export function createSessionStore(config: NormalizedRumConfiguration): SessionStore {
  if (typeof document === 'undefined') return new MemorySessionStore();
  const domain =
    config.sessionCookieDomain ??
    (config.trackSessionAcrossSubdomains ? detectCookieDomain() : undefined);
  const options: CookieOptions = {
    domain,
    secure:
      config.useCrossSiteSessionCookie ||
      (typeof window !== 'undefined' && window.location.protocol === 'https:'),
    crossSite: config.useCrossSiteSessionCookie,
  };
  const name = `_msrum_s_${config.applicationId.replace(/[^\w-]/g, '_').slice(0, 60)}`;
  if (!cookiesWork(options)) return new MemorySessionStore();
  return new CookieSessionStore(name, options, config.maxSessionDuration);
}

let cachedCookieDomain: string | null | undefined;

/**
 * The registrable domain of the page (`example.com` for `app.example.com`),
 * found by asking the browser which parent domains accept a cookie.
 */
export function detectCookieDomain(): string | undefined {
  if (cachedCookieDomain !== undefined) return cachedCookieDomain ?? undefined;
  cachedCookieDomain = null;
  if (typeof window === 'undefined') return undefined;
  const hostname = window.location.hostname;
  if (!hostname || hostname.includes(':') || /^[\d.]+$/.test(hostname)) return undefined;
  const labels = hostname.split('.');
  for (let index = labels.length - 2; index >= 0; index -= 1) {
    const candidate = labels.slice(index).join('.');
    const name = `_msrum_probe_${generateUuid().slice(0, 8)}`;
    const options: CookieOptions = {
      domain: candidate,
      secure: window.location.protocol === 'https:',
      crossSite: false,
    };
    writeCookie(name, '1', new Date(Date.now() + 60_000), options);
    const accepted = readCookie(name) === '1';
    writeCookie(name, '', new Date(EPOCH_PAST), options);
    if (accepted) {
      cachedCookieDomain = candidate;
      return candidate;
    }
  }
  return undefined;
}

function cookiesWork(options: CookieOptions): boolean {
  const name = `_msrum_probe_${generateUuid().slice(0, 8)}`;
  writeCookie(name, '1', new Date(Date.now() + 60_000), { ...options, domain: undefined });
  const accepted = readCookie(name) === '1';
  writeCookie(name, '', new Date(EPOCH_PAST), { ...options, domain: undefined });
  return accepted;
}

function readCookie(name: string): string | undefined {
  let cookies: string;
  try {
    cookies = document.cookie;
  } catch {
    return undefined;
  }
  if (!cookies) return undefined;
  const prefix = `${name}=`;
  for (const part of cookies.split(';')) {
    const entry = part.trim();
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return undefined;
}

function writeCookie(
  name: string,
  value: string,
  expires: Date,
  options: CookieOptions,
): void {
  const attributes = [
    `${name}=${value}`,
    `expires=${expires.toUTCString()}`,
    'path=/',
    `SameSite=${options.crossSite ? 'None' : 'Lax'}`,
  ];
  if (options.domain) attributes.push(`domain=${options.domain}`);
  if (options.secure) attributes.push('Secure');
  try {
    document.cookie = attributes.join(';');
  } catch {
    // Cookies can be blocked, for example in sandboxed iframes.
  }
}
