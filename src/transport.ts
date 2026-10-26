import { unrefTimer } from './clock.js';
import type { NormalizedRumConfiguration } from './config.js';
import { rumEndpoint } from './config.js';
import type { RumEvent, RumEventType } from './events.js';
import {
  IndexedDbQueueStorage,
  LEASE_RENEW_MS,
  type PersistedQueueEntry,
} from './persistence.js';
import type {
  RumContext,
  RumQueueDropReason,
  RumRequestKind,
  RumTransport,
  RumTransportRequest,
  RumTransportResponse,
  RumTransportStats,
} from './types.js';
import {
  byteLength,
  generateId,
  reportInternalError,
  SDK_VERSION,
} from './utils.js';

interface QueueEntryBase extends PersistedQueueEntry {
  attempts: number;
  nextAttemptAt: number;
}

interface EventEntry extends QueueEntryBase {
  kind: 'event';
  event: RumEvent;
}

interface ReplayEnvelope extends QueueEntryBase {
  kind: 'replay_event';
  sessionId: string;
  event: RumContext;
}

interface ReplaySegment extends QueueEntryBase {
  kind: 'replay_segment';
  sessionId: string;
  seq: number;
  events: RumContext[];
}

type StoredEntry = EventEntry | ReplayEnvelope | ReplaySegment;

interface RejectedEvent {
  index: number;
  reason: string;
}

interface SendResult {
  decision: 'ok' | 'drop' | 'retry';
  dropReason?: RumQueueDropReason;
  retryAfterMs?: number;
  /** Events the server accepted the request for but refused individually. */
  rejected?: RejectedEvent[];
}

/** Chrome allows about 64 KiB of keepalive request bodies in flight. */
const MAX_KEEPALIVE_BODY_BYTES = 60 * 1024;
const TARGET_EVENTS_REQUEST_BYTES = 512 * 1024;
const TARGET_REPLAY_SEGMENT_BYTES = 1024 * 1024;
const MAX_REPLAY_REQUEST_BYTES = 8 * 1024 * 1024;
/** The server takes 5 MiB per request; one event is never worth more than this. */
const MAX_EVENT_BYTES = 1024 * 1024;

/**
 * Which events are given up first when the queue is full, and which go first
 * into a request that may be the last one. Lower is more important.
 */
const IMPORTANCE: Record<RumEventType, number> = {
  view: 0,
  error: 1,
  action: 2,
  vital: 3,
  long_task: 4,
  resource: 5,
};
/** Raw replay events are worth less than the events that explain them. */
const EVICTION_ORDER: Array<RumEventType | 'replay'> = [
  'resource',
  'long_task',
  'replay',
  'vital',
  'action',
  'error',
  'view',
];

function viewRevision(event: RumEvent): number {
  return event.type === 'view' ? event.view.revision : 0;
}

export class EventTransport {
  private queue: EventEntry[] = [];
  private replayQueue: ReplayEnvelope[] = [];
  private replayRetrySegments: ReplaySegment[] = [];
  private readonly endpoints: Record<RumRequestKind, string>;
  private readonly transport: RumTransport;
  private readonly storage: IndexedDbQueueStorage<PersistedQueueEntry>;
  private readonly restorePromise: Promise<void>;
  private storageChain: Promise<void> = Promise.resolve();
  private eventTimer?: ReturnType<typeof globalThis.setInterval>;
  private replayTimer?: ReturnType<typeof globalThis.setInterval>;
  private leaseTimer?: ReturnType<typeof globalThis.setInterval>;
  private eventFlush?: Promise<void>;
  private eventFollowUp?: Promise<void>;
  private replayFlush?: Promise<void>;
  private replayFollowUp?: Promise<void>;
  private stopped = false;
  private readonly stats: Omit<RumTransportStats, 'queued'> = {
    sent: 0,
    retried: 0,
    restored: 0,
    dropped: 0,
    droppedByReason: {
      queue_full: 0,
      serialization: 0,
      payload_too_large: 0,
      rejected: 0,
    },
  };

  constructor(
    private readonly config: NormalizedRumConfiguration,
    /** The tab that sends this queue; its rows are restored by the next page load in the tab. */
    private readonly owner: string,
    private readonly nextReplaySequence: (sessionId: string) => number,
  ) {
    this.endpoints = {
      events: rumEndpoint(config.site, 'events'),
      replay: rumEndpoint(config.site, 'replay'),
    };
    this.transport = config.transport ?? new FetchRumTransport();
    this.storage = new IndexedDbQueueStorage(config);
    this.restorePromise = this.restore();
  }

  start(): void {
    if (this.stopped) return;
    if (this.eventTimer === undefined) {
      this.eventTimer = unrefTimer(
        globalThis.setInterval(() => {
          void this.flushEvents(false, false);
        }, this.config.flushInterval),
      );
    }
    if (this.replayTimer === undefined) {
      this.replayTimer = unrefTimer(
        globalThis.setInterval(() => {
          void this.flushReplay(false, false);
        }, this.config.replayFlushInterval),
      );
    }
    if (this.leaseTimer === undefined) {
      this.leaseTimer = unrefTimer(
        globalThis.setInterval(() => {
          void this.storage.renewLease(this.owner).catch(() => undefined);
        }, LEASE_RENEW_MS),
      );
    }
    void this.restorePromise.then(() => this.flush(false, false));
  }

  /**
   * Queues an event. A view that is already waiting in the queue is replaced by
   * its newer revision: the server only keeps the highest one anyway.
   */
  enqueue(event: RumEvent): boolean {
    if (this.stopped) return false;
    if (event.type === 'view') {
      const waiting = this.queue.find(
        (entry) => entry.event.type === 'view' && entry.event.view.id === event.view.id,
      );
      if (waiting) {
        if (event.view.revision >= viewRevision(waiting.event)) {
          waiting.event = event;
          this.persist(waiting);
        }
        return true;
      }
    }
    if (!this.makeRoom(event.type)) return false;
    const entry: EventEntry = {
      ...this.entryBase('event'),
      kind: 'event',
      event,
    };
    this.queue.push(entry);
    this.persist(entry);
    if (this.queue.length >= this.config.batchSize) {
      void this.flushEvents(false, false);
    }
    return true;
  }

  enqueueReplay(sessionId: string, event: RumContext): boolean {
    if (this.stopped || !this.makeRoom('replay')) return false;
    const entry: ReplayEnvelope = {
      ...this.entryBase('replay_event'),
      kind: 'replay_event',
      sessionId,
      event,
    };
    this.replayQueue.push(entry);
    this.persist(entry);
    if (event.type === 2 || this.replayQueue.length >= this.config.replayBatchSize) {
      void this.flushReplay(false, false);
    }
    return true;
  }

  isSdkUrl(url: string): boolean {
    return Object.values(this.endpoints).some((endpoint) => url.startsWith(endpoint));
  }

  getStats(): RumTransportStats {
    return {
      queued: this.totalQueued(),
      sent: this.stats.sent,
      retried: this.stats.retried,
      restored: this.stats.restored,
      dropped: this.stats.dropped,
      droppedByReason: { ...this.stats.droppedByReason },
    };
  }

  /**
   * Explicit flushes bypass retry delays; timer-driven flushes honor them. A
   * `keepalive` flush is the page's last chance: it sends the most important
   * events first, in a request that is issued before this call returns.
   */
  async flush(keepalive = false, force = true): Promise<void> {
    await Promise.all([
      this.flushEvents(keepalive, force),
      this.flushReplay(keepalive, force),
    ]);
  }

  async stop(): Promise<void> {
    this.stopTimers();
    await this.flush(true, true);
    await this.storageChain;
    this.stopped = true;
    await this.storage.releaseLease(this.owner).catch(() => undefined);
  }

  /** Stops immediately and removes queued telemetry after consent is revoked. */
  async discard(): Promise<void> {
    this.stopTimers();
    this.stopped = true;
    const activeFlushes = [this.eventFlush, this.replayFlush].filter(
      (flush): flush is Promise<void> => !!flush,
    );
    await this.restorePromise;
    await Promise.allSettled(activeFlushes);
    this.queue.length = 0;
    this.replayQueue.length = 0;
    this.replayRetrySegments.length = 0;
    await this.storageChain;
    await this.storage.clear();
  }

  private stopTimers(): void {
    if (this.leaseTimer !== undefined) {
      globalThis.clearInterval(this.leaseTimer);
      this.leaseTimer = undefined;
    }
    if (this.eventTimer !== undefined) {
      globalThis.clearInterval(this.eventTimer);
      this.eventTimer = undefined;
    }
    if (this.replayTimer !== undefined) {
      globalThis.clearInterval(this.replayTimer);
      this.replayTimer = undefined;
    }
  }

  private flushEvents(keepalive: boolean, force: boolean): Promise<void> {
    if (this.stopped && !this.eventFlush) return Promise.resolve();
    // The page may be going away: do not wait behind a flush that is in progress.
    if (keepalive) return this.sendQueuedEvents(true, force);
    if (this.eventFlush) {
      if (!force) return this.eventFlush;
      // An explicit flush also sends what was queued after the running one began.
      this.eventFollowUp ??= this.eventFlush.then(() => {
        this.eventFollowUp = undefined;
        return this.flushEvents(false, true);
      });
      return this.eventFollowUp;
    }
    this.eventFlush = (async () => {
      await this.restorePromise;
      await this.storageChain;
      await this.sendQueuedEvents(false, force);
    })().finally(() => {
      this.eventFlush = undefined;
    });
    return this.eventFlush;
  }

  private flushReplay(keepalive: boolean, force: boolean): Promise<void> {
    if (this.stopped && !this.replayFlush) return Promise.resolve();
    if (this.replayFlush) {
      if (!force) return this.replayFlush;
      this.replayFollowUp ??= this.replayFlush.then(() => {
        this.replayFollowUp = undefined;
        return this.flushReplay(keepalive, true);
      });
      return this.replayFollowUp;
    }
    this.replayFlush = (async () => {
      await this.restorePromise;
      await this.storageChain;
      await this.flushReplayQueue(keepalive, force);
    })().finally(() => {
      this.replayFlush = undefined;
    });
    return this.replayFlush;
  }

  private async sendQueuedEvents(keepalive: boolean, force: boolean): Promise<void> {
    const now = Date.now();
    const pending = this.queue.splice(0);
    let ready = pending.filter((entry) => force || entry.nextAttemptAt <= now);
    const deferred = pending.filter((entry) => !force && entry.nextAttemptAt > now);
    if (ready.length === 0) {
      this.queue.unshift(...deferred);
      return;
    }
    if (keepalive) {
      ready = [...ready].sort(
        (left, right) => IMPORTANCE[left.event.type] - IMPORTANCE[right.event.type],
      );
    }

    const serialized = this.serializeEntries(ready);
    const maxBytes = keepalive ? MAX_KEEPALIVE_BODY_BYTES : TARGET_EVENTS_REQUEST_BYTES;
    const chunks = chunkSerialized(serialized, this.config.batchSize, maxBytes);

    for (let index = 0; index < chunks.length; index += 1) {
      if (this.stopped) return;
      const chunk = chunks[index] ?? [];
      const entries = chunk.map((item) => item.entry);
      const result = await this.send(
        'events',
        `[${chunk.map((item) => item.json).join(',')}]`,
        keepalive,
      );
      if (result.decision === 'ok') {
        this.acknowledge(entries, result.rejected ?? []);
        continue;
      }
      if (result.decision === 'drop') {
        this.dropEntries(entries, result.dropReason ?? 'rejected');
        continue;
      }

      this.markForRetry(entries, result.retryAfterMs);
      const remaining = chunks.slice(index + 1).flat().map((item) => item.entry);
      this.queue.unshift(...entries, ...remaining, ...deferred);
      return;
    }
    this.queue.unshift(...deferred);
  }

  /** Serializes each event once; an event that cannot be serialized is dropped. */
  private serializeEntries(
    entries: EventEntry[],
  ): Array<{ entry: EventEntry; json: string; bytes: number }> {
    const result: Array<{ entry: EventEntry; json: string; bytes: number }> = [];
    for (const entry of entries) {
      try {
        const json = JSON.stringify(entry.event);
        const bytes = byteLength(json);
        if (bytes > MAX_EVENT_BYTES) {
          this.dropEntries(
            [entry],
            'payload_too_large',
            new Error(`a ${entry.event.type} event is ${bytes} bytes`),
          );
          continue;
        }
        result.push({ entry, json, bytes });
      } catch (error) {
        this.dropEntries([entry], 'serialization', error);
      }
    }
    return result;
  }

  /** Marks a request's events as delivered, except those the server refused. */
  private acknowledge(entries: EventEntry[], rejected: RejectedEvent[]): void {
    const refused = new Set<number>();
    for (const item of rejected) {
      if (Number.isInteger(item.index) && item.index >= 0 && item.index < entries.length) {
        refused.add(item.index);
      }
    }
    this.stats.sent += entries.length - refused.size;
    this.removePersisted(entries);
    if (refused.size === 0) return;

    this.stats.dropped += refused.size;
    this.stats.droppedByReason.rejected += refused.size;
    const samples = rejected
      .filter((item) => refused.has(item.index))
      .slice(0, 3)
      .map((item) => `#${item.index} ${item.reason}`)
      .join('; ');
    reportInternalError(
      this.config.onError,
      new Error(`${refused.size} of ${entries.length} events were refused: ${samples}`),
      'RUM events rejected',
    );
  }

  private async flushReplayQueue(keepalive: boolean, force: boolean): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const pending = this.replayQueue.splice(0);
    const readyEvents = pending.filter((entry) => force || entry.nextAttemptAt <= now);
    const deferredEvents = pending.filter((entry) => !force && entry.nextAttemptAt > now);
    const allSegments = this.replayRetrySegments.splice(0);
    const readySegments = allSegments.filter(
      (segment) => force || segment.nextAttemptAt <= now,
    );
    const deferredSegments = allSegments.filter(
      (segment) => !force && segment.nextAttemptAt > now,
    );

    const grouped = new Map<string, ReplayEnvelope[]>();
    for (const envelope of readyEvents) {
      const list = grouped.get(envelope.sessionId) ?? [];
      list.push(envelope);
      grouped.set(envelope.sessionId, list);
    }

    const convertedIds = new Set<string>();
    try {
      for (const [sessionId, envelopes] of grouped) {
        const serialized = envelopes.map((entry) => {
          const json = JSON.stringify(entry.event);
          return { entry, json, bytes: byteLength(json) };
        });
        const chunks = chunkSerialized(
          serialized,
          this.config.replayBatchSize,
          keepalive ? MAX_KEEPALIVE_BODY_BYTES : TARGET_REPLAY_SEGMENT_BYTES,
        );
        for (const chunk of chunks) {
          const segment: ReplaySegment = {
            ...this.entryBase('replay_segment'),
            kind: 'replay_segment',
            sessionId,
            seq: this.nextReplaySequence(sessionId),
            events: chunk.map((item) => item.entry.event),
          };
          await this.storage.replace(
            chunk.map((item) => item.entry.id),
            segment,
          );
          for (const item of chunk) convertedIds.add(item.entry.id);
          readySegments.push(segment);
        }
      }
    } catch (error) {
      reportInternalError(
        this.config.onError,
        error,
        'RUM replay persistence conversion failed',
      );
    }
    this.replayQueue.push(
      ...readyEvents.filter((entry) => !convertedIds.has(entry.id)),
    );

    for (let index = 0; index < readySegments.length; index += 1) {
      if (this.stopped) return;
      const segment = readySegments[index];
      if (!segment) continue;
      const result = await this.send(
        'replay',
        JSON.stringify({
          session_id: segment.sessionId,
          seq: segment.seq,
          events: segment.events,
          // A segment has no event to say where its session runs, and what the application keeps
          // of its sessions can depend on it. Unset labels are left out.
          service: this.config.service,
          env: this.config.env,
          version: this.config.version,
        }),
        keepalive,
      );
      if (result.decision === 'ok') {
        this.stats.sent += segment.events.length;
        this.removePersisted([segment]);
        continue;
      }
      if (result.decision === 'drop') {
        this.dropEntries(
          [segment],
          result.dropReason ?? 'rejected',
          undefined,
          segment.events.length,
        );
        continue;
      }

      this.markForRetry([segment], result.retryAfterMs, segment.events.length);
      this.replayRetrySegments.unshift(...readySegments.slice(index));
      this.replayRetrySegments.push(...deferredSegments);
      this.replayQueue.push(...deferredEvents);
      return;
    }

    this.replayRetrySegments.push(...deferredSegments);
    this.replayQueue.push(...deferredEvents);
  }

  private async send(
    kind: RumRequestKind,
    serialized: string,
    keepalive: boolean,
  ): Promise<SendResult> {
    const size = byteLength(serialized);
    if (kind === 'replay' && size > MAX_REPLAY_REQUEST_BYTES) {
      reportInternalError(
        this.config.onError,
        new Error('replay segment exceeds 8 MiB'),
        'RUM replay upload dropped',
      );
      return { decision: 'drop', dropReason: 'payload_too_large' };
    }

    const request: RumTransportRequest = {
      url: this.endpoints[kind],
      body: serialized,
      headers: {
        authorization: `Bearer ${this.config.clientToken}`,
        'content-type': 'application/json',
        'x-molesignal-rum': `browser-rum/${SDK_VERSION}`,
      },
      keepalive: keepalive && size <= MAX_KEEPALIVE_BODY_BYTES,
      kind,
    };

    try {
      const response = await this.transport.send(request);
      if (response.ok) {
        return {
          decision: 'ok',
          rejected: kind === 'events' ? parseRejected(response.body) : undefined,
        };
      }
      const message = `${response.status} ${response.statusText ?? ''}${
        response.body ? `: ${response.body.slice(0, 512)}` : ''
      }`.trim();
      reportInternalError(
        this.config.onError,
        new Error(message),
        `RUM ${kind} upload rejected`,
      );
      return isRetryableStatus(response.status)
        ? { decision: 'retry', retryAfterMs: response.retryAfterMs }
        : { decision: 'drop', dropReason: 'rejected' };
    } catch (error) {
      reportInternalError(this.config.onError, error, `RUM ${kind} upload failed`);
      return { decision: 'retry' };
    }
  }

  private totalQueued(): number {
    return (
      this.queue.length +
      this.replayQueue.length +
      this.replayRetrySegments.reduce(
        (total, segment) => total + segment.events.length,
        0,
      )
    );
  }

  /**
   * Makes room for one more entry by giving up the least important one that is
   * not more important than the newcomer; the newcomer is dropped when there is none.
   */
  private makeRoom(incoming: RumEventType | 'replay'): boolean {
    if (this.totalQueued() < this.config.maxQueueSize) return true;
    for (const type of EVICTION_ORDER.slice(0, EVICTION_ORDER.indexOf(incoming) + 1)) {
      if (type === 'replay') {
        const replay = this.replayQueue.shift();
        if (replay) {
          this.dropEntries([replay], 'queue_full');
          return true;
        }
        continue;
      }
      const index = this.queue.findIndex((entry) => entry.event.type === type);
      if (index >= 0) {
        const [candidate] = this.queue.splice(index, 1);
        if (candidate) this.dropEntries([candidate], 'queue_full');
        return true;
      }
    }
    this.countDrop('queue_full');
    return false;
  }

  private markForRetry<T extends StoredEntry>(
    entries: T[],
    retryAfterMs?: number,
    itemCount = entries.length,
  ): void {
    const now = Date.now();
    for (const entry of entries) {
      entry.attempts += 1;
      const exponent = Math.min(entry.attempts - 1, 16);
      const ceiling = Math.min(
        this.config.retryMaxDelay,
        this.config.retryBaseDelay * 2 ** exponent,
      );
      const jittered = Math.round(ceiling * (0.5 + Math.random() * 0.5));
      entry.nextAttemptAt = now + Math.max(jittered, retryAfterMs ?? 0);
      this.persist(entry);
    }
    this.stats.retried += itemCount;
  }

  private dropEntries(
    entries: QueueEntryBase[],
    reason: RumQueueDropReason,
    error?: unknown,
    itemCount = entries.length,
  ): void {
    this.countDrop(reason, itemCount);
    this.removePersisted(entries);
    if (error !== undefined) {
      reportInternalError(this.config.onError, error, `RUM queue ${reason}`);
    }
  }

  private countDrop(reason: RumQueueDropReason, count = 1): void {
    this.stats.dropped += count;
    this.stats.droppedByReason[reason] += count;
    if (reason === 'queue_full' && this.stats.droppedByReason.queue_full === 1) {
      reportInternalError(
        this.config.onError,
        new Error('maximum queue size reached'),
        'RUM telemetry dropped',
      );
    }
  }

  private entryBase(kind: StoredEntry['kind']): QueueEntryBase {
    return {
      id: generateId('queue'),
      queueKey: this.storage.queueKey,
      owner: this.owner,
      kind,
      createdAt: Date.now(),
      attempts: 0,
      nextAttemptAt: 0,
    };
  }

  private persist(entry: StoredEntry): void {
    this.storageChain = this.storageChain
      .then(() => this.storage.put(entry))
      .catch(() => undefined);
  }

  private removePersisted(entries: QueueEntryBase[]): void {
    const ids = entries.map((entry) => entry.id);
    this.storageChain = this.storageChain
      .then(() => this.storage.remove(ids))
      .catch(() => undefined);
  }

  private async restore(): Promise<void> {
    const stored = await this.storage.claim(this.owner);
    const existing = new Set<string>(
      [...this.queue, ...this.replayQueue, ...this.replayRetrySegments].map(
        (entry) => entry.id,
      ),
    );
    const invalid: string[] = [];
    let restored = 0;
    for (const candidate of stored.sort((left, right) => left.createdAt - right.createdAt)) {
      if (existing.has(candidate.id)) continue;
      if (!isStoredEntry(candidate)) {
        invalid.push(candidate.id);
        continue;
      }
      if (candidate.kind === 'event' && candidate.event.type === 'view') {
        const viewId = candidate.event.view.id;
        const current = this.queue.find(
          (entry) => entry.event.type === 'view' && entry.event.view.id === viewId,
        );
        if (current) {
          // Keep one row per view: the newer revision wins.
          if (candidate.event.view.revision > viewRevision(current.event)) {
            current.event = candidate.event;
            this.persist(current);
          }
          invalid.push(candidate.id);
          continue;
        }
      }
      existing.add(candidate.id);
      if (candidate.kind === 'replay_event') {
        this.replayQueue.push(candidate);
        restored += 1;
      } else if (candidate.kind === 'replay_segment') {
        this.replayRetrySegments.push(candidate);
        restored += candidate.events.length;
      } else {
        this.queue.push(candidate);
        restored += 1;
      }
    }
    this.stats.restored += restored;
    if (invalid.length > 0) {
      try {
        await this.storage.remove(invalid);
      } catch {
        // The invalid rows remain isolated and are ignored for this page load.
      }
    }
    while (this.totalQueued() > this.config.maxQueueSize) {
      if (!this.makeRoom('view')) break;
    }
  }
}

class FetchRumTransport implements RumTransport {
  private readonly fetchImplementation?: typeof fetch;

  constructor() {
    if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
      this.fetchImplementation = window.fetch.bind(window);
    } else if (typeof globalThis.fetch === 'function') {
      this.fetchImplementation = globalThis.fetch.bind(globalThis);
    }
  }

  async send(request: RumTransportRequest): Promise<RumTransportResponse> {
    if (!this.fetchImplementation) {
      throw new Error('fetch is unavailable; configure a custom RUM transport');
    }
    const response = await this.fetchImplementation(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      keepalive:
        request.keepalive && byteLength(request.body) <= MAX_KEEPALIVE_BODY_BYTES,
      credentials: 'omit',
      cache: 'no-store',
    });
    let body: string | undefined;
    try {
      // `{ accepted, rejected }` on success; the reason for a failure otherwise.
      body = await response.text();
    } catch {
      // Some opaque responses do not expose a body.
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    };
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

/** `{ accepted, rejected: [{ index, reason }] }`, tolerating any other body. */
function parseRejected(body: string | undefined): RejectedEvent[] {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as { rejected?: unknown };
    if (!Array.isArray(parsed.rejected)) return [];
    const rejected: RejectedEvent[] = [];
    for (const item of parsed.rejected as Array<Partial<RejectedEvent>>) {
      if (typeof item?.index === 'number') {
        rejected.push({ index: item.index, reason: String(item.reason ?? 'rejected') });
      }
    }
    return rejected;
  } catch {
    return [];
  }
}

function chunkSerialized<T>(
  items: Array<{ entry: T; json: string; bytes: number }>,
  maxItems: number,
  maxBytes: number,
): Array<Array<{ entry: T; json: string; bytes: number }>> {
  const chunks: Array<Array<{ entry: T; json: string; bytes: number }>> = [];
  let current: Array<{ entry: T; json: string; bytes: number }> = [];
  let size = 2;
  for (const item of items) {
    const itemSize = item.bytes + 1;
    if (current.length > 0 && (current.length >= maxItems || size + itemSize > maxBytes)) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function isStoredEntry(value: PersistedQueueEntry): value is StoredEntry {
  const candidate = value as Partial<StoredEntry>;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof candidate.id !== 'string' ||
    typeof candidate.createdAt !== 'number' ||
    typeof candidate.attempts !== 'number' ||
    typeof candidate.nextAttemptAt !== 'number'
  ) {
    return false;
  }
  if (candidate.kind === 'replay_event') {
    return typeof candidate.sessionId === 'string' && !!candidate.event;
  }
  if (candidate.kind === 'replay_segment') {
    return (
      typeof candidate.sessionId === 'string' &&
      typeof candidate.seq === 'number' &&
      Array.isArray(candidate.events)
    );
  }
  if (candidate.kind === 'event') {
    const event = candidate.event as Partial<RumEvent> | undefined;
    return (
      !!event &&
      typeof event === 'object' &&
      typeof event.type === 'string' &&
      typeof (event as { view?: { id?: unknown } }).view?.id === 'string'
    );
  }
  return false;
}
