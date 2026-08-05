import type { RumContext, UrlMatcher } from './types.js';

export const SDK_NAME = '@molesignal/browser-rum';
declare const __MOLESIGNAL_RUM_VERSION__: string | undefined;
export const SDK_VERSION =
  typeof __MOLESIGNAL_RUM_VERSION__ === 'string'
    ? __MOLESIGNAL_RUM_VERSION__
    : '0.0.0-dev';

const SENSITIVE_KEY =
  /(?:password|passwd|secret|token|authorization|cookie|set-cookie|api[-_]?key|credit[-_]?card|cvv)/i;

export function nowMicros(): number {
  return Date.now() * 1_000;
}

export function durationNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function generateId(prefix: string): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return `${prefix}_${cryptoObject.randomUUID().replace(/-/g, '')}`;
  }
  const random = `${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
  return `${prefix}_${Date.now().toString(36)}${random}`;
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

export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
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

export function pagePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
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

export function generateTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
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

function isPlainObject(value: unknown): value is RumContext {
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
