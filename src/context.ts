import { normalizeAccount, normalizeUser } from './identity.js';
import type { RumEventAccount, RumEventUser } from './events.js';
import type { RumAccount, RumContext, RumUser } from './types.js';
import { clampText, sanitizeContext } from './utils.js';

const NAMED_USER_FIELDS = new Set(['id', 'name', 'email']);

/** The attributes the application attaches to every event: user, account, global context. */
export class ContextStore {
  private user?: RumUser;
  private account?: RumAccount;
  private globalContext: RumContext;
  anonymousId?: string;

  constructor(initial: { user?: RumUser; account?: RumAccount; globalContext: RumContext }) {
    this.user = initial.user ? { ...initial.user } : undefined;
    this.account = initial.account ? { ...initial.account } : undefined;
    this.globalContext = { ...initial.globalContext };
  }

  setUser(user: unknown): void {
    this.user = normalizeUser(user);
  }

  getUser(): RumUser | undefined {
    return this.user ? { ...this.user } : undefined;
  }

  setUserProperty(key: string, value: unknown): void {
    if (typeof key !== 'string' || !key.trim()) return;
    this.user = setProperty(this.user, key, value, NAMED_USER_FIELDS);
  }

  removeUserProperty(key: string): void {
    if (!this.user) return;
    const { [key]: _removed, ...rest } = this.user;
    this.user = Object.keys(rest).length > 0 ? rest : undefined;
  }

  clearUser(): void {
    this.user = undefined;
  }

  setAccount(account: unknown): void {
    this.account = normalizeAccount(account);
  }

  getAccount(): RumAccount | undefined {
    return this.account ? { ...this.account } : undefined;
  }

  setAccountProperty(key: string, value: unknown): void {
    if (typeof key !== 'string' || !key.trim()) return;
    this.account = setProperty(this.account, key, value, new Set(['id', 'name']));
  }

  removeAccountProperty(key: string): void {
    if (!this.account) return;
    const { [key]: _removed, ...rest } = this.account;
    this.account = Object.keys(rest).length > 0 ? rest : undefined;
  }

  clearAccount(): void {
    this.account = undefined;
  }

  setGlobalContext(context: RumContext): void {
    this.globalContext = sanitizeContext(context);
  }

  setGlobalContextProperty(key: string, value: unknown): void {
    if (typeof key !== 'string' || !key.trim()) return;
    this.globalContext = { ...this.globalContext, ...sanitizeContext({ [key]: value }) };
  }

  removeGlobalContextProperty(key: string): void {
    const { [key]: _removed, ...rest } = this.globalContext;
    this.globalContext = rest;
  }

  clearGlobalContext(): void {
    this.globalContext = {};
  }

  getGlobalContext(): RumContext {
    return { ...this.globalContext };
  }

  /** `usr` of an event: the user's attributes plus the anonymous id, if any. */
  eventUser(): RumEventUser | undefined {
    if (!this.user && !this.anonymousId) return undefined;
    const usr: RumEventUser = { ...this.user };
    if (this.anonymousId) usr.anonymous_id = clampText(this.anonymousId, 256);
    return usr;
  }

  eventAccount(): RumEventAccount | undefined {
    return this.account ? { ...this.account } : undefined;
  }
}

function setProperty<T extends Record<string, unknown>>(
  target: T | undefined,
  key: string,
  value: unknown,
  named: Set<string>,
): T {
  const [entry] = Object.entries(sanitizeContext({ [key]: value }));
  const next: Record<string, unknown> = { ...target };
  if (!entry) {
    delete next[key];
  } else if (named.has(key) && typeof entry[1] === 'string') {
    next[key] = clampText(entry[1], 256);
  } else {
    next[key] = entry[1];
  }
  return next as T;
}
