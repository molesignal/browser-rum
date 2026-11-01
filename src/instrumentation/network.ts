import { perfNow } from '../clock.js';
import {
  generateTraceparent,
  parseTraceparent,
  traceparentFromServerTiming,
} from '../utils.js';
import type { TraceContext } from '../utils.js';
import type { Cleanup, InstrumentationHooks } from './types.js';

export type RequestKind = 'fetch' | 'xhr';

/** One fetch or XMLHttpRequest, from the call that started it to its outcome. */
export interface RequestRecord {
  kind: RequestKind;
  method: string;
  /** The absolute URL, as requested (not sanitized). */
  url: string;
  /** `performance.now()` when the request was issued. */
  startRel: number;
  /** Epoch milliseconds when the request was issued. */
  startDate: number;
  /** `performance.now()` when the response arrived or the request failed. */
  endRel?: number;
  status?: number;
  statusText?: string;
  /** The request failed before any response (offline, DNS, CORS, ...). */
  failed?: boolean;
  /** The request was cancelled by the application. */
  aborted?: boolean;
  /** The headers asked for by `trackResourceHeaders`. */
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** The name of the error thrown by `fetch`, such as `TypeError`. */
  errorName?: string;
  errorMessage?: string;
  trace?: TraceContext;
}

export interface RequestListener {
  /** A request is about to be sent. */
  started(record: RequestRecord): void;
  /** The response headers arrived (fetch) or the request ended (XHR). */
  finished(record: RequestRecord): void;
}

/**
 * Wraps `fetch` and `XMLHttpRequest`. It injects a W3C `traceparent` where
 * that is allowed, reads the trace context back from the request or response,
 * and tells `listener` what happened.
 */
export function instrumentNetwork(
  hooks: InstrumentationHooks,
  listener: RequestListener,
): Cleanup {
  const cleanups = [instrumentFetch(hooks, listener), instrumentXhr(hooks, listener)];
  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}

/** Whether the trace a request starts is one the back end is asked to keep. */
function traceIsSampled(hooks: InstrumentationHooks): boolean {
  return Math.random() * 100 < hooks.config.traceSampleRate;
}

function instrumentFetch(hooks: InstrumentationHooks, listener: RequestListener): Cleanup {
  if (typeof window.fetch !== 'function') return () => undefined;
  const originalFetch = window.fetch;

  const wrappedFetch: typeof window.fetch = async function (
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = resolveRequestUrl(input);
    if (!isTrackable(url, hooks)) {
      return originalFetch.call(this, input, init);
    }

    const traced = hooks.config.trackResources && hooks.shouldReadTrace(url);
    let requestTraceparent = readRequestHeader(input, init, 'traceparent');
    let tracedInput = input;
    let tracedInit = init;
    if (traced && !requestTraceparent) {
      requestTraceparent = generateTraceparent(traceIsSampled(hooks));
      [tracedInput, tracedInit] = injectFetchTraceparent(input, init, requestTraceparent);
    }

    const record: RequestRecord = {
      kind: 'fetch',
      method: resolveRequestMethod(input, init),
      url,
      startRel: perfNow(),
      startDate: Date.now(),
      trace: traced ? parseTraceparent(requestTraceparent) : undefined,
    };
    listener.started(record);

    try {
      const response = await originalFetch.call(this, tracedInput, tracedInit);
      record.endRel = perfNow();
      record.status = response.status;
      record.statusText = response.statusText || undefined;
      if (traced) record.trace = responseTraceContext(response, requestTraceparent);
      record.requestHeaders = keptHeaders(hooks, requestHeaderPairs(input, init));
      record.responseHeaders = keptHeaders(hooks, [...response.headers.entries()]);
      listener.finished(record);
      return response;
    } catch (error) {
      record.endRel = perfNow();
      record.failed = true;
      record.status = 0;
      record.aborted = isAbortError(error);
      if (error instanceof Error) {
        record.errorName = error.name;
        record.errorMessage = error.message;
      } else {
        record.errorMessage = String(error);
      }
      listener.finished(record);
      throw error;
    }
  };

  window.fetch = wrappedFetch;
  return () => {
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
  };
}

interface XhrState {
  record?: RequestRecord;
  method: string;
  url: string;
  tracked: boolean;
  traceparent?: string;
}

function instrumentXhr(hooks: InstrumentationHooks, listener: RequestListener): Cleanup {
  if (typeof XMLHttpRequest === 'undefined') return () => undefined;
  const prototype = XMLHttpRequest.prototype;
  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  const originalSetRequestHeader = prototype.setRequestHeader;
  const requests = new WeakMap<XMLHttpRequest, XhrState>();

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
      method: String(method).toUpperCase(),
      url: absoluteUrl,
      tracked: isTrackable(absoluteUrl, hooks),
    });
    originalOpen.call(this, method, url, async, username ?? null, password ?? null);
  };

  const wrappedSetRequestHeader = function (
    this: XMLHttpRequest,
    name: string,
    value: string,
  ): void {
    const state = requests.get(this);
    if (state && name.toLowerCase() === 'traceparent') state.traceparent = value;
    originalSetRequestHeader.call(this, name, value);
  };

  const wrappedSend = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const state = requests.get(this);
    if (!state?.tracked) {
      originalSend.call(this, body ?? null);
      return;
    }

    const traced = hooks.config.trackResources && hooks.shouldReadTrace(state.url);
    if (traced && !state.traceparent) {
      state.traceparent = generateTraceparent(traceIsSampled(hooks));
      try {
        originalSetRequestHeader.call(this, 'traceparent', state.traceparent);
      } catch {
        // The request still proceeds if a browser refuses trace header injection.
        state.traceparent = undefined;
      }
    }
    const record: RequestRecord = {
      kind: 'xhr',
      method: state.method,
      url: state.url,
      startRel: perfNow(),
      startDate: Date.now(),
      trace: traced ? parseTraceparent(state.traceparent) : undefined,
    };
    state.record = record;
    listener.started(record);

    let aborted = false;
    this.addEventListener('abort', () => {
      aborted = true;
    });
    this.addEventListener(
      'loadend',
      () => {
        record.endRel = perfNow();
        record.status = this.status;
        record.statusText = this.statusText || undefined;
        record.aborted = aborted;
        record.failed = this.status === 0;
        if (traced) record.trace = xhrTraceContext(this, state.traceparent);
        record.responseHeaders = keptHeaders(hooks, xhrResponseHeaders(this));
        listener.finished(record);
      },
      { once: true },
    );
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

/** Headers that hold credentials are never kept, whatever is asked for. */
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
]);

/** The headers `trackResourceHeaders` asks for, with their names in lower case. */
function keptHeaders(
  hooks: InstrumentationHooks,
  pairs: Array<[string, string]>,
): Record<string, string> | undefined {
  const asked = hooks.config.trackResourceHeaders;
  if (asked.length === 0) return undefined;
  const kept: Record<string, string> = {};
  for (const [rawName, value] of pairs) {
    const name = rawName.toLowerCase();
    if (SECRET_HEADERS.has(name)) continue;
    if (asked.some((pattern) => (typeof pattern === 'string' ? pattern.toLowerCase() === name : pattern.test(name)))) {
      kept[name] = value.slice(0, 1_024);
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function requestHeaderPairs(input: RequestInfo | URL, init?: RequestInit): Array<[string, string]> {
  try {
    const headers = new Headers(
      init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
    );
    return [...headers.entries()];
  } catch {
    return [];
  }
}

function xhrResponseHeaders(request: XMLHttpRequest): Array<[string, string]> {
  try {
    return (request.getAllResponseHeaders() ?? '')
      .split(/\r?\n/)
      .map((line): [string, string] => {
        const at = line.indexOf(':');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      })
      .filter(([name]) => name.length > 0);
  } catch {
    return [];
  }
}

/** The trace of a finished XHR: the response, else `Server-Timing`, else what was sent. */
function xhrTraceContext(
  request: XMLHttpRequest,
  requestTraceparent: string | undefined,
): TraceContext | undefined {
  let responseTraceparent: string | null = null;
  let serverTiming: string | null = null;
  try {
    responseTraceparent = request.getResponseHeader('traceparent');
    serverTiming = request.getResponseHeader('server-timing');
  } catch {
    // Cross-origin XHR may not expose response headers.
  }
  return parseTraceparent(
    responseTraceparent ?? traceparentFromServerTiming(serverTiming) ?? requestTraceparent,
  );
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

/** Only http(s) requests that are not the SDK's own and not excluded by the application. */
function isTrackable(url: string, hooks: InstrumentationHooks): boolean {
  return /^https?:/i.test(url) && !hooks.isSdkUrl(url) && hooks.shouldTrackUrl(url);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
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

function injectFetchTraceparent(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  traceparent: string,
): [RequestInfo | URL, RequestInit | undefined] {
  try {
    const requestHeaders =
      typeof Request !== 'undefined' && input instanceof Request
        ? input.headers
        : undefined;
    const headers = new Headers(init?.headers ?? requestHeaders);
    headers.set('traceparent', traceparent);
    if (typeof Request !== 'undefined' && input instanceof Request && !init) {
      return [new Request(input, { headers }), undefined];
    }
    return [input, { ...init, headers }];
  } catch {
    return [input, init];
  }
}

function resolveUrl(value: string): string {
  try {
    return new URL(value, window.location.href).toString();
  } catch {
    return value;
  }
}
