import {
  durationNow,
  parseTraceparent,
  traceparentFromServerTiming,
} from '../utils.js';
import type { TraceContext } from '../utils.js';
import type { Cleanup, InstrumentationHooks } from './types.js';

interface RequestMetadata {
  method: string;
  url: string;
  startedAt: number;
  traceparent?: string;
  tracked: boolean;
}

export function instrumentNetwork(hooks: InstrumentationHooks): Cleanup {
  const cleanups = [instrumentFetch(hooks), instrumentXhr(hooks)];
  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}

function instrumentFetch(hooks: InstrumentationHooks): Cleanup {
  if (typeof window.fetch !== 'function') return () => undefined;
  const originalFetch = window.fetch;

  const wrappedFetch: typeof window.fetch = async function (
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = resolveRequestUrl(input);
    if (!url || hooks.isSdkUrl(url) || !hooks.shouldTrackUrl(url)) {
      return originalFetch.call(this, input, init);
    }

    const method = resolveRequestMethod(input, init);
    const requestTraceparent = readRequestHeader(input, init, 'traceparent');
    const startedAt = durationNow();
    hooks.markActivity();
    hooks.markChange();

    try {
      const response = await originalFetch.call(this, input, init);
      const traceContext = hooks.shouldReadTrace(url)
        ? responseTraceContext(response, requestTraceparent)
        : undefined;
      recordRequest(hooks, {
        method,
        url,
        durationMs: durationNow() - startedAt,
        status: response.status,
        traceContext,
        initiator: 'fetch',
        responseSize: numericHeader(response.headers, 'content-length'),
      });
      return response;
    } catch (error) {
      recordRequest(hooks, {
        method,
        url,
        durationMs: durationNow() - startedAt,
        status: 599,
        traceContext: hooks.shouldReadTrace(url)
          ? parseTraceparent(requestTraceparent)
          : undefined,
        initiator: 'fetch',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  window.fetch = wrappedFetch;
  return () => {
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
  };
}

function instrumentXhr(hooks: InstrumentationHooks): Cleanup {
  if (typeof XMLHttpRequest === 'undefined') return () => undefined;
  const prototype = XMLHttpRequest.prototype;
  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  const originalSetRequestHeader = prototype.setRequestHeader;
  const requests = new WeakMap<XMLHttpRequest, RequestMetadata>();

  const wrappedOpen = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ): void {
    const absoluteUrl = resolveUrl(String(url));
    requests.set(this, {
      method: method.toUpperCase(),
      url: absoluteUrl,
      startedAt: 0,
      tracked:
        !hooks.isSdkUrl(absoluteUrl) &&
        hooks.shouldTrackUrl(absoluteUrl),
    });
    originalOpen.call(this, method, url, async, username ?? null, password ?? null);
  };

  const wrappedSetRequestHeader = function (
    this: XMLHttpRequest,
    name: string,
    value: string,
  ): void {
    const metadata = requests.get(this);
    if (metadata && name.toLowerCase() === 'traceparent') metadata.traceparent = value;
    originalSetRequestHeader.call(this, name, value);
  };

  const wrappedSend = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const metadata = requests.get(this);
    if (!metadata?.tracked) {
      originalSend.call(this, body ?? null);
      return;
    }

    metadata.startedAt = durationNow();
    hooks.markActivity();
    hooks.markChange();
    const onLoadEnd = (): void => {
      let responseTraceparent: string | null = null;
      let serverTiming: string | null = null;
      let responseSize: number | undefined;
      try {
        responseTraceparent = this.getResponseHeader('traceparent');
        serverTiming = this.getResponseHeader('server-timing');
        const contentLength = this.getResponseHeader('content-length');
        if (contentLength) {
          const parsed = Number(contentLength);
          if (Number.isFinite(parsed)) responseSize = parsed;
        }
      } catch {
        // Cross-origin XHR may not expose response headers.
      }
      const traceContext = hooks.shouldReadTrace(metadata.url)
        ? parseTraceparent(
            responseTraceparent ??
              traceparentFromServerTiming(serverTiming) ??
              metadata.traceparent,
          )
        : undefined;
      recordRequest(hooks, {
        method: metadata.method,
        url: metadata.url,
        durationMs: durationNow() - metadata.startedAt,
        status: this.status || 599,
        traceContext,
        initiator: 'xmlhttprequest',
        responseSize,
      });
    };
    this.addEventListener('loadend', onLoadEnd, { once: true });
    originalSend.call(this, body ?? null);
  };

  prototype.open = wrappedOpen;
  prototype.setRequestHeader = wrappedSetRequestHeader;
  prototype.send = wrappedSend;

  return () => {
    if (prototype.open === wrappedOpen) prototype.open = originalOpen;
    if (prototype.setRequestHeader === wrappedSetRequestHeader) {
      prototype.setRequestHeader = originalSetRequestHeader;
    }
    if (prototype.send === wrappedSend) prototype.send = originalSend;
  };
}

function recordRequest(
  hooks: InstrumentationHooks,
  input: {
    method: string;
    url: string;
    durationMs: number;
    status: number;
    traceContext?: TraceContext;
    initiator: string;
    responseSize?: number;
    error?: string;
  },
): void {
  const sanitizedUrl = hooks.sanitizeUrl(input.url);
  let path = sanitizedUrl;
  try {
    const parsed = new URL(sanitizedUrl);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    // Keep the sanitized value for non-standard URL schemes.
  }
  hooks.recordAction({
    type: 'resource',
    name: `${input.method} ${path}`,
    url: sanitizedUrl,
    durationMs: Math.max(0, input.durationMs),
    status: input.status,
    traceContext: input.traceContext,
    context: {
      method: input.method,
      initiator: input.initiator,
      response_size: input.responseSize,
      error: input.error,
    },
  });
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return resolveUrl(input);
  if (input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return resolveUrl(input.url);
  return '';
}

function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return 'GET';
}

function readRequestHeader(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  try {
    const initHeaders = new Headers(init?.headers);
    const fromInit = initHeaders.get(name);
    if (fromInit) return fromInit;
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return input.headers.get(name) ?? undefined;
    }
  } catch {
    // Invalid application headers should be handled by fetch itself.
  }
  return undefined;
}

function responseTraceContext(
  response: Response,
  requestTraceparent: string | undefined,
): TraceContext | undefined {
  try {
    const direct = response.headers.get('traceparent');
    const serverTiming = traceparentFromServerTiming(response.headers.get('server-timing'));
    return parseTraceparent(direct ?? serverTiming ?? requestTraceparent);
  } catch {
    return parseTraceparent(requestTraceparent);
  }
}

function numericHeader(headers: Headers, name: string): number | undefined {
  try {
    const value = headers.get(name);
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resolveUrl(value: string): string {
  try {
    return new URL(value, window.location.href).toString();
  } catch {
    return value;
  }
}
