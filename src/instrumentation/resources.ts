import { perfNow, relativeToEpoch, toNanoseconds, unrefTimer } from '../clock.js';
import type {
  RumResourceBody,
  RumResourcePhase,
  RumResourceType,
} from '../events.js';
import { compact, generateUuid, normalizeHttpMethod } from '../utils.js';
import type { ErrorRecorder } from './errors.js';
import type { RequestListener, RequestRecord } from './network.js';
import type { Cleanup, InstrumentationHooks } from './types.js';

/**
 * A request's timing entry appears when its response body has been read, so a
 * request whose body the application never reads would wait for ever. After this
 * long it is reported with what the SDK measured itself.
 */
const ENTRY_WAIT_MS = 2_000;
/** How long a request reported without its entry is remembered, to ignore the entry if it comes late. */
const MEASURED_MEMORY_MS = 2 * 60_000;
const MEASURED_MEMORY_LIMIT = 200;
/** An entry that finished this recently counts as the page doing something. */
const FRESH_ENTRY_MS = 100;
/** An entry that arrives before its request finished is kept this long. */
const EARLY_ENTRY_TTL_MS = 2_000;
const SWEEP_INTERVAL_MS = 250;
const SETTLE_POLL_MS = 50;
const SETTLE_MAX_WAIT_MS = 500;

interface AwaitingRequest {
  record: RequestRecord;
  deadline: number;
}

interface EarlyEntry {
  entry: PerformanceResourceTiming;
  deadline: number;
}

interface MeasuredRequest {
  record: RequestRecord;
  forgetAt: number;
}

export interface ResourceCollector extends RequestListener {
  /** Reports the initial page request, from the navigation timing entry. */
  collectDocument(): void;
  /**
   * Resolves once the requests that began between `fromRel` and `untilRel` and
   * have already finished are reported with their timings. Used before an action
   * is closed, so that the action's counters include them.
   */
  settle(fromRel: number, untilRel: number): Promise<void>;
  /** Reports every request that is still waiting for its timing entry, as measured. */
  flushPending(): void;
  stop: Cleanup;
}

export function createResourceCollector(
  hooks: InstrumentationHooks,
  errors: ErrorRecorder,
): ResourceCollector {
  const inflight = new Set<RequestRecord>();
  let awaiting: AwaitingRequest[] = [];
  let early: EarlyEntry[] = [];
  let measured: MeasuredRequest[] = [];
  let sweepTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let observer: PerformanceObserver | undefined;
  let stopped = false;

  const track = hooks.config.trackResources;

  const emitEntry = (entry: PerformanceResourceTiming, record?: RequestRecord): void => {
    const body = resourceBody(entry, record, hooks);
    if (!body) return;
    hooks.record({
      type: 'resource',
      date: record?.startDate ?? relativeToEpoch(entry.startTime),
      rel: entry.startTime,
      body,
    });
  };

  const emitRecord = (record: RequestRecord): void => {
    if (track) {
      const body = resourceBody(undefined, record, hooks);
      if (body) {
        hooks.record({ type: 'resource', date: record.startDate, rel: record.startRel, body });
      }
    }
  };

  const reportNetworkError = (record: RequestRecord): void => {
    if (record.aborted) return;
    const failedStatus = (record.status ?? 0) >= 400;
    if (!record.failed && !failedStatus) return;
    const url = hooks.sanitizeUrl(record.url);
    const method = normalizeHttpMethod(record.method);
    const status = record.status ?? 0;
    const label = record.kind === 'fetch' ? 'Fetch' : 'XHR';
    const message = record.failed
      ? record.kind === 'fetch' && record.errorMessage
        ? `${record.errorMessage} ${url}`
        : `${label} error ${record.method} ${url}`
      : `${record.method} ${url} failed with status ${status}${
          record.statusText ? ` ${record.statusText}` : ''
        }`;
    errors.record({
      message,
      type: record.failed ? (record.errorName ?? 'NetworkError') : 'HTTPError',
      source: 'network',
      handling: 'handled',
      resource: compact({ method, status_code: status, url }),
      startRel: record.startRel,
    });
  };

  /** A request is over: report it with its timing entry when there is one. */
  const complete = (record: RequestRecord, entry?: PerformanceResourceTiming): void => {
    if (track) {
      if (entry) {
        emitEntry(entry, record);
      } else {
        emitRecord(record);
        measured.push({ record, forgetAt: Date.now() + MEASURED_MEMORY_MS });
        if (measured.length > MEASURED_MEMORY_LIMIT) measured.shift();
        scheduleSweep();
      }
    }
    reportNetworkError(record);
  };

  const findEarlyEntry = (record: RequestRecord): PerformanceResourceTiming | undefined => {
    const index = early.findIndex((item) => entryMatches(record, item.entry));
    if (index < 0) return undefined;
    const [item] = early.splice(index, 1);
    return item?.entry;
  };

  const handleEntry = (entry: PerformanceResourceTiming): void => {
    if (!/^https?:/i.test(entry.name) || hooks.isSdkUrl(entry.name) || !hooks.shouldTrackUrl(entry.name)) {
      return;
    }
    // Entries replayed from the buffer at startup are history, not activity.
    if (perfNow() - entry.responseEnd < FRESH_ENTRY_MS) hooks.activity.resourceLoaded();
    if (!isRequestEntry(entry)) {
      emitEntry(entry);
      return;
    }

    // The request was already reported from the SDK's own measurements.
    const reported = measured.findIndex((item) => entryMatches(item.record, entry));
    if (reported >= 0) {
      measured.splice(reported, 1);
      return;
    }
    const waiting = awaiting.findIndex((item) => entryMatches(item.record, entry));
    if (waiting >= 0) {
      const [item] = awaiting.splice(waiting, 1);
      if (item) complete(item.record, entry);
      return;
    }
    const running = [...inflight].some((record) => entryMatches(record, entry, true));
    if (running) {
      early.push({ entry, deadline: Date.now() + EARLY_ENTRY_TTL_MS });
      scheduleSweep();
      return;
    }
    // A request that the SDK did not see (made before it started, or by a worker).
    emitEntry(entry);
  };

  const sweep = (): void => {
    sweepTimer = undefined;
    const now = Date.now();
    const expired = awaiting.filter((item) => item.deadline <= now);
    awaiting = awaiting.filter((item) => item.deadline > now);
    for (const item of expired) complete(item.record);
    early = early.filter((item) => item.deadline > now);
    measured = measured.filter((item) => item.forgetAt > now);
    scheduleSweep();
  };

  function scheduleSweep(): void {
    if (stopped || sweepTimer !== undefined) return;
    if (awaiting.length === 0 && early.length === 0 && measured.length === 0) return;
    sweepTimer = unrefTimer(globalThis.setTimeout(sweep, SWEEP_INTERVAL_MS));
  }

  const drain = (): void => {
    if (!observer) return;
    try {
      for (const entry of observer.takeRecords()) {
        handleEntry(entry as PerformanceResourceTiming);
      }
    } catch {
      // takeRecords is optional in older engines.
    }
  };

  if (track && typeof PerformanceObserver !== 'undefined') {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) handleEntry(entry as PerformanceResourceTiming);
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      observer = undefined;
    }
  }

  return {
    started(record) {
      inflight.add(record);
      hooks.activity.requestStarted();
    },

    finished(record) {
      inflight.delete(record);
      hooks.activity.requestEnded();
      if (!track) {
        reportNetworkError(record);
        return;
      }
      const entry = findEarlyEntry(record);
      if (entry || !observer) {
        // Without resource timing there is nothing to wait for.
        complete(record, entry);
        return;
      }
      awaiting.push({ record, deadline: Date.now() + ENTRY_WAIT_MS });
      scheduleSweep();
    },

    collectDocument() {
      if (!track || typeof performance === 'undefined') return;
      try {
        const navigation = performance.getEntriesByType('navigation')[0] as
          | PerformanceNavigationTiming
          | undefined;
        if (!navigation || navigation.responseEnd <= 0) return;
        const body = documentBody(navigation, hooks);
        hooks.record({
          type: 'resource',
          date: relativeToEpoch(navigation.startTime),
          rel: Math.max(navigation.startTime, 0),
          body,
        });
      } catch {
        // Navigation timing is optional.
      }
    },

    async settle(fromRel, untilRel) {
      const inWindow = (item: AwaitingRequest): boolean =>
        item.record.startRel >= fromRel && item.record.startRel <= untilRel;
      drain();
      const deadline = Date.now() + SETTLE_MAX_WAIT_MS;
      while (awaiting.some(inWindow) && Date.now() < deadline && !stopped) {
        await new Promise<void>((resolve) =>
          unrefTimer(globalThis.setTimeout(resolve, SETTLE_POLL_MS)),
        );
        drain();
      }
      const stale = awaiting.filter(inWindow);
      awaiting = awaiting.filter((item) => !inWindow(item));
      for (const item of stale) complete(item.record);
    },

    flushPending() {
      drain();
      const pending = awaiting;
      awaiting = [];
      for (const item of pending) complete(item.record);
    },

    stop() {
      if (stopped) return;
      stopped = true;
      drain();
      observer?.disconnect();
      observer = undefined;
      if (sweepTimer !== undefined) globalThis.clearTimeout(sweepTimer);
      sweepTimer = undefined;
      const pending = awaiting;
      awaiting = [];
      early = [];
      measured = [];
      inflight.clear();
      for (const item of pending) complete(item.record);
    },
  };
}

function isRequestEntry(entry: PerformanceResourceTiming): boolean {
  return entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest';
}

function entryMatches(
  record: RequestRecord,
  entry: PerformanceResourceTiming,
  allowUnfinished = false,
): boolean {
  if (stripHash(record.url) !== stripHash(entry.name)) return false;
  const kind = entry.initiatorType === 'xmlhttprequest' ? 'xhr' : entry.initiatorType;
  if (kind !== record.kind) return false;
  if (entry.startTime < record.startRel - 20) return false;
  if (record.endRel !== undefined) return entry.startTime <= record.endRel + 20;
  return allowUnfinished;
}

function stripHash(url: string): string {
  const index = url.indexOf('#');
  return index >= 0 ? url.slice(0, index) : url;
}

/** The `resource` object for a request, its timing entry, or both. */
function resourceBody(
  entry: PerformanceResourceTiming | undefined,
  record: RequestRecord | undefined,
  hooks: InstrumentationHooks,
): RumResourceBody | undefined {
  const rawUrl = record?.url ?? entry?.name;
  if (!rawUrl) return undefined;
  const type = record ? record.kind : resourceTypeOf(entry as PerformanceResourceTiming);
  const body: RumResourceBody = {
    id: generateUuid(),
    type,
    url: hooks.sanitizeUrl(rawUrl),
  };
  if (record?.requestHeaders) body.request = { headers: record.requestHeaders };
  if (record?.responseHeaders) body.response = { headers: record.responseHeaders };

  const method = normalizeHttpMethod(record?.method);
  if (method) body.method = method;
  const status = record?.status ?? (entry && entry.responseStatus > 0 ? entry.responseStatus : undefined);
  if (status !== undefined) body.status_code = status;

  if (entry) {
    Object.assign(body, timingFields(entry));
  } else if (record?.endRel !== undefined) {
    body.duration = toNanoseconds(record.endRel - record.startRel);
  }
  if (record?.trace) {
    body.trace_id = record.trace.traceId;
    body.span_id = record.trace.parentSpanId;
  }
  return compact(body);
}

/** The page's own request, reported as a `document` resource. */
function documentBody(
  navigation: PerformanceNavigationTiming,
  hooks: InstrumentationHooks,
): RumResourceBody {
  const fields = timingFields(navigation);
  const origin = navigation.startTime;
  return compact({
    id: generateUuid(),
    type: 'document' as const,
    method: 'GET' as const,
    url: hooks.sanitizeUrl(navigation.name || window.location.href),
    status_code: navigation.responseStatus > 0 ? navigation.responseStatus : undefined,
    ...fields,
    duration: toNanoseconds(navigation.responseEnd - origin),
  });
}

/** Sizes, protocol and phases of a timing entry. */
function timingFields(entry: PerformanceResourceTiming): Partial<RumResourceBody> {
  const fields: Partial<RumResourceBody> = {};
  if (entry.duration >= 0) fields.duration = toNanoseconds(entry.duration);

  if (entry.decodedBodySize > 0 || entry.encodedBodySize > 0 || entry.transferSize > 0) {
    fields.size = Math.max(0, Math.round(entry.decodedBodySize));
    fields.encoded_body_size = Math.max(0, Math.round(entry.encodedBodySize));
    fields.decoded_body_size = Math.max(0, Math.round(entry.decodedBodySize));
    fields.transfer_size = Math.max(0, Math.round(entry.transferSize));
  }
  if (entry.nextHopProtocol) fields.protocol = entry.nextHopProtocol;
  const deliveryType = deliveryTypeOf(entry);
  if (deliveryType) fields.delivery_type = deliveryType;
  const blocking = (entry as { renderBlockingStatus?: string }).renderBlockingStatus;
  if (blocking === 'blocking' || blocking === 'non-blocking') {
    fields.render_blocking_status = blocking;
  }
  return { ...fields, ...phases(entry) };
}

type Phases = Partial<
  Pick<RumResourceBody, 'worker' | 'redirect' | 'dns' | 'connect' | 'ssl' | 'first_byte' | 'download'>
>;

/**
 * The phases of a request, as offsets from its start. Entries whose timestamps
 * are not in order (cross-origin responses without `Timing-Allow-Origin`) have
 * no usable phases.
 */
function phases(entry: PerformanceResourceTiming): Phases {
  const origin = entry.startTime;
  if (
    !inOrder(
      origin,
      entry.fetchStart,
      entry.domainLookupStart,
      entry.domainLookupEnd,
      entry.connectStart,
      entry.connectEnd,
      entry.requestStart,
      entry.responseStart,
      entry.responseEnd,
    )
  ) {
    return {};
  }
  const result: Phases = {
    first_byte: phase(origin, entry.requestStart, entry.responseStart),
    download: phase(origin, entry.responseStart, entry.responseEnd),
  };
  // A reused connection has no connect, TLS or DNS phase.
  if (entry.connectEnd !== entry.fetchStart) {
    result.connect = phase(origin, entry.connectStart, entry.connectEnd);
    if (entry.secureConnectionStart > 0 && inOrder(entry.connectStart, entry.secureConnectionStart, entry.connectEnd)) {
      result.ssl = phase(origin, entry.secureConnectionStart, entry.connectEnd);
    }
  }
  if (entry.domainLookupEnd !== entry.fetchStart) {
    result.dns = phase(origin, entry.domainLookupStart, entry.domainLookupEnd);
  }
  if (entry.redirectEnd > origin) {
    result.redirect = phase(origin, entry.redirectStart, entry.redirectEnd);
  }
  if (entry.workerStart > 0 && entry.workerStart <= entry.fetchStart) {
    result.worker = phase(origin, entry.workerStart, entry.fetchStart);
  }
  return result;
}

function phase(origin: number, start: number, end: number): RumResourcePhase {
  return { start: toNanoseconds(start - origin), duration: toNanoseconds(end - start) };
}

function inOrder(...values: number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] as number) < (values[index - 1] as number)) return false;
  }
  return true;
}

function deliveryTypeOf(
  entry: PerformanceResourceTiming,
): RumResourceBody['delivery_type'] | undefined {
  const delivery = (entry as { deliveryType?: string }).deliveryType;
  if (delivery !== undefined) {
    if (delivery === 'cache' || delivery === 'navigational-prefetch') return delivery;
    return 'other';
  }
  return entry.transferSize === 0 && entry.decodedBodySize > 0 ? 'cache' : 'other';
}

const EXTENSION_TYPES: Array<[RumResourceType, RegExp]> = [
  ['css', /^css$/],
  ['js', /^(?:js|mjs|cjs)$/],
  ['font', /^(?:woff2?|ttf|otf|eot)$/],
  ['image', /^(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|apng)$/],
  ['media', /^(?:mp3|mp4|m4a|m4v|webm|ogg|ogv|oga|wav|aac|flac|mov|m3u8|mpd)$/],
];

/** Maps a resource entry to a contract resource type. */
export function resourceTypeOf(entry: PerformanceResourceTiming): RumResourceType {
  switch (entry.initiatorType) {
    case 'xmlhttprequest':
      return 'xhr';
    case 'fetch':
      return 'fetch';
    case 'beacon':
      return 'beacon';
    case 'iframe':
    case 'frame':
    case 'navigation':
      return 'document';
    case 'script':
      return 'js';
    case 'img':
    case 'image':
      return 'image';
    case 'video':
    case 'audio':
    case 'track':
      return 'media';
    default:
      break;
  }
  const extension = extensionOf(entry.name);
  if (extension) {
    for (const [type, pattern] of EXTENSION_TYPES) {
      if (pattern.test(extension)) return type;
    }
  }
  return 'other';
}

function extensionOf(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf('.');
    return dot >= 0 ? pathname.slice(dot + 1).toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
