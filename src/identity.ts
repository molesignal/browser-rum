import type { RumAccount, RumUser } from './types.js';
import { clampText, isPlainObject, sanitizeContext } from './utils.js';

const NAMED_FIELD_LIMIT = 256;

/**
 * Validates a user supplied through `init` or `setUser`. The contract keeps
 * `usr.id`, `usr.name` and `usr.email` (each up to 256 characters) as columns
 * and every other key as free-form properties.
 */
export function normalizeUser(user: unknown): RumUser {
  if (!isPlainObject(user)) {
    throw new TypeError('MoleSignal RUM user must be an object');
  }
  const normalized = normalizeIdentity(user, ['id', 'name', 'email']);
  if (normalized.id === undefined && normalized.name === undefined && normalized.email === undefined) {
    throw new TypeError(
      'MoleSignal RUM user needs at least one non-empty "id", "name", or "email"',
    );
  }
  return normalized as RumUser;
}

export function normalizeAccount(account: unknown): RumAccount {
  if (!isPlainObject(account)) {
    throw new TypeError('MoleSignal RUM account must be an object');
  }
  const normalized = normalizeIdentity(account, ['id', 'name']);
  if (normalized.id === undefined && normalized.name === undefined) {
    throw new TypeError('MoleSignal RUM account needs a non-empty "id" or "name"');
  }
  return normalized as RumAccount;
}

function normalizeIdentity(
  value: Record<string, unknown>,
  named: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...sanitizeContext(value) };
  for (const field of named) {
    const raw = value[field];
    if (typeof raw === 'string' && raw.trim()) {
      result[field] = clampText(raw.trim(), NAMED_FIELD_LIMIT);
    } else {
      delete result[field];
    }
  }
  return result;
}
