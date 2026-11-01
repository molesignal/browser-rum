import type { RumContext, UrlMatcher } from './types.js';

export const SDK_NAME = 'molesignal-browser-rum';
declare const __MOLESIGNAL_RUM_VERSION__: string | undefined;
export const SDK_VERSION =
  typeof __MOLESIGNAL_RUM_VERSION__ === 'string'
    ? __MOLESIGNAL_RUM_VERSION__
    : '0.0.0-dev';

const SENSITIVE_KEY =
  /(?:password|passwd|secret|token|authorization|cookie|set-cookie|api[-_]?key|credit[-_]?card|cvv)/i;

const HTTP_METHODS = new Set([
  'POST',
  'GET',
  'HEAD',
  'PUT',
  'DELETE',
  'PATCH',
  'TRACE',
  'OPTIONS',
  'CONNECT',
]);

export type HttpMethod =
  | 'POST'
  | 'GET'
  | 'HEAD'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'TRACE'
  | 'OPTIONS'
  | 'CONNECT';

/** The contract only knows the standard HTTP methods; anything else is left out. */
export function normalizeHttpMethod(value: string | undefined): HttpMethod | undefined {
  const method = value?.toUpperCase();
  return method && HTTP_METHODS.has(method) ? (method as HttpMethod) : undefined;
}

/** A random RFC 4122 version 4 UUID; it always satisfies the contract's identifier pattern. */
export function generateUuid(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A prefixed random identifier for SDK-internal records such as queue rows. */
export function generateId(prefix: string): string {
  return `${prefix}_${generateUuid().replace(/-/g, '')}`;
}

export function sample(rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 100) return true;
  return Math.random() * 100 < rate;
}

export function sanitizeContext(value: unknown): RumContext {
  const sanitized = sanitizeValue(value);
  return isPlainObject(sanitized) ? sanitized : {};
}

export function sanitizeValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return truncate(value, 4_096);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (depth >= 6) return '[Max depth]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message, 4_096),
      stack: value.stack ? truncate(value.stack, 16_384) : undefined,
    };
  }
  if (typeof Node !== 'undefined' && value instanceof Node) {
    return nodeDescription(value);
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value
      .slice(0, 100)
      .map((entry) => sanitizeValue(entry, depth + 1, seen))
      .filter((entry) => entry !== undefined);
    seen.delete(value);
    return result;
  }

  const result: RumContext = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= 100) break;
    result[key] = SENSITIVE_KEY.test(key)
      ? '[Redacted]'
      : sanitizeValue(entry, depth + 1, seen);
    if (result[key] === undefined) delete result[key];
    count += 1;
  }
  seen.delete(value);
  return result;
}

/** Shortens `value` and marks the cut with an ellipsis. */
export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** Shortens `value` to at most `limit` characters, for fields with a hard length limit. */
export function clampText(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

export function sanitizeUrl(
  raw: string,
  includeQueryString: boolean,
  base?: string,
): string {
  try {
    const url = new URL(raw, base);
    url.username = '';
    url.password = '';
    url.hash = '';
    if (!includeQueryString) url.search = '';
    return url.toString();
  } catch {
    const withoutHash = raw.split('#', 1)[0] ?? raw;
    return includeQueryString ? withoutHash : (withoutHash.split('?', 1)[0] ?? withoutHash);
  }
}

/**
 * Like `sanitizeUrl`, but keeps a fragment that is a client-side route
 * (`#/orders`, `#!/orders`) so hash-routed applications still get distinct
 * views. A query inside the fragment follows `includeQueryString`.
 */
export function sanitizeViewUrl(
  raw: string,
  includeQueryString: boolean,
  base?: string,
): string {
  const clean = sanitizeUrl(raw, includeQueryString, base);
  try {
    const hash = routeHash(new URL(raw, base).hash, includeQueryString);
    return hash ? `${clean}${hash}` : clean;
  } catch {
    return clean;
  }
}

/** The default name of a view: its path, plus a route-style fragment. */
export function viewPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${routeHash(parsed.hash, false)}`;
  } catch {
    return url;
  }
}

function routeHash(hash: string, includeQueryString: boolean): string {
  if (!/^#!?\//.test(hash)) return '';
  if (includeQueryString) return hash;
  const query = hash.indexOf('?');
  return query >= 0 ? hash.slice(0, query) : hash;
}

export function matchesUrl(url: string, matchers: UrlMatcher[]): boolean {
  return matchers.some((matcher) => {
    try {
      if (typeof matcher === 'string') return url.includes(matcher);
      if (matcher instanceof RegExp) {
        matcher.lastIndex = 0;
        return matcher.test(url);
      }
      return matcher(url);
    } catch {
      return false;
    }
  });
}

export interface TraceContext {
  traceId: string;
  parentSpanId: string;
}

/** A new W3C trace context; a back end that follows it keeps the trace when `sampled` says so. */
export function generateTraceparent(sampled = true): string {
  return `00-${randomHex(16)}-${randomHex(8)}-${sampled ? '01' : '00'}`;
}

export function parseTraceparent(value: string | null | undefined): TraceContext | undefined {
  if (!value) return undefined;
  const match = value
    .trim()
    .match(/^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}(?:-|$)/i);
  if (!match?.[1] || !match[2]) return undefined;
  if (/^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
  return {
    traceId: match[1].toLowerCase(),
    parentSpanId: match[2].toLowerCase(),
  };
}

export function traceparentFromServerTiming(value: string | null): string | undefined {
  if (!value) return undefined;
  for (const metric of value.split(',')) {
    const name = metric.split(';', 1)[0]?.trim().toLowerCase();
    if (name !== 'traceparent') continue;
    const description = metric.match(/;\s*desc=(?:"([^"]+)"|([^;,\s]+))/i);
    return description?.[1] ?? description?.[2];
  }
  return undefined;
}

export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Marks the errors handed to `onError`, so that an application that logs them
 * with `console.error` does not see them come back as `console` error events.
 */
export const INTERNAL_ERROR_FLAG = Symbol.for('molesignal.rum.internal');

export function reportInternalError(
  handler: ((error: Error) => void) | undefined,
  error: unknown,
  prefix: string,
): void {
  if (!handler) return;
  const normalized =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error));
  try {
    const wrapped = new Error(`${prefix}: ${normalized.message}`);
    (wrapped as Error & { cause?: unknown }).cause = normalized;
    (wrapped as unknown as Record<symbol, unknown>)[INTERNAL_ERROR_FLAG] = true;
    handler(wrapped);
  } catch {
    // User-provided diagnostics must never break the monitored application.
  }
}

export function isBrowserEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof navigator !== 'undefined'
  );
}

/** Drops keys whose value is undefined, in place. */
export function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

export function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return value.length * 2;
}

export function isPlainObject(value: unknown): value is RumContext {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodeDescription(node: Node): string {
  if (typeof Element !== 'undefined' && node instanceof Element) {
    return `<${node.tagName.toLowerCase()}>`;
  }
  return `[${node.nodeName}]`;
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  if (bytes.every((value) => value === 0)) bytes[bytes.length - 1] = 1;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}
