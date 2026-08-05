import type { NormalizedRumConfiguration } from './config.js';
import { rumEndpoint } from './config.js';
import {
  IndexedDbQueueStorage,
  type PersistedQueueEntry,
} from './persistence.js';
import type {
  RumContext,
  RumEventKind,
  RumQueueDropReason,
  RumTransport,
  RumTransportRequest,
  RumTransportResponse,
  RumTransportStats,
} from './types.js';
import {
  generateId,
  reportInternalError,
  SDK_VERSION,
} from './utils.js';

type IngestKind = Exclude<RumEventKind, 'replay'>;

interface QueueEntryBase extends PersistedQueueEntry {
  attempts: number;
  nextAttemptAt: number;
}

interface IngestEntry extends QueueEntryBase {
  kind: IngestKind;
  event: RumContext;
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

type StoredEntry = IngestEntry | ReplayEnvelope | ReplaySegment;

interface SendResult {
  decision: 'ok' | 'drop' | 'retry';
  dropReason?: RumQueueDropReason;
  retryAfterMs?: number;
}

const MAX_KEEPALIVE_BODY_BYTES = 48 * 1024;
const TARGET_REPLAY_SEGMENT_BYTES = 1024 * 1024;
const MAX_REPLAY_REQUEST_BYTES = 8 * 1024 * 1024;

export class EventTransport {
  private readonly queues: Record<IngestKind, IngestEntry[]> = {
    session: [],
    action: [],
    error: [],
  };
  private replayQueue: ReplayEnvelope[] = [];
  private replayRetrySegments: ReplaySegment[] = [];
  private readonly endpoints: Record<RumEventKind, string>;
  private readonly transport: RumTransport;
  private readonly storage: IndexedDbQueueStorage<PersistedQueueEntry>;
  private readonly restorePromise: Promise<void>;
  private storageChain: Promise<void> = Promise.resolve();
  private eventTimer?: ReturnType<typeof globalThis.setInterval>;
  private replayTimer?: ReturnType<typeof globalThis.setInterval>;
  private eventFlush?: Promise<void>;
  private replayFlush?: Promise<void>;
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
    private readonly nextReplaySequence: (sessionId: string) => number,
  ) {
    this.endpoints = {
      session: rumEndpoint(config.site, 'sessions'),
      action: rumEndpoint(config.site, 'actions'),
      error: rumEndpoint(config.site, 'errors'),
      replay: rumEndpoint(config.site, 'replay'),
    };
    this.transport = config.transport ?? new FetchRumTransport();
    this.storage = new IndexedDbQueueStorage(config);
    this.restorePromise = this.restore();
  }

  start(): void {
    if (this.stopped) return;
    if (this.eventTimer === undefined) {
      this.eventTimer = globalThis.setInterval(() => {
        void this.flushEvents(false, false);
      }, this.config.flushInterval);
    }
    if (this.replayTimer === undefined) {
      this.replayTimer = globalThis.setInterval(() => {
        void this.flushReplay(false, false);
      }, this.config.replayFlushInterval);
    }
    void this.restorePromise.then(() => this.flush(false, false));
  }

  enqueue(kind: IngestKind, event: RumContext): boolean {
    if (this.stopped) return false;
    if (kind === 'session') {
      const sessionId = stringField(event, 'session_id');
      const existing = sessionId
        ? this.queues.session.find((entry) => stringField(entry.event, 'session_id') === sessionId)
        : undefined;
      if (existing) {
        existing.event = event;
        existing.attempts = 0;
        existing.nextAttemptAt = 0;
        this.persist(existing);
        return true;
      }
    }
    if (!this.ensureCapacity()) return false;
    const entry: IngestEntry = {
      ...this.entryBase(kind),
      kind,
      event,
    };
    this.queues[kind].push(entry);
    this.persist(entry);
    if (this.queues[kind].length >= this.config.batchSize) {
      void this.flushEvents(false, false);
    }
    return true;
  }

  enqueueReplay(sessionId: string, event: RumContext): boolean {
    if (this.stopped || !this.ensureReplayCapacity()) return false;
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

  /** Explicit flushes bypass retry delays; timer-driven flushes honor them. */
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
    this.queues.session.length = 0;
    this.queues.action.length = 0;
    this.queues.error.length = 0;
    this.replayQueue.length = 0;
    this.replayRetrySegments.length = 0;
    await this.storageChain;
    await this.storage.clear();
  }

  private stopTimers(): void {
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
    if (this.eventFlush) return this.eventFlush;
    this.eventFlush = (async () => {
      await this.restorePromise;
      await this.storageChain;
      await Promise.all(
        (['session', 'action', 'error'] as const).map((kind) =>
          this.flushIngestKind(kind, keepalive, force),
        ),
      );
    })().finally(() => {
      this.eventFlush = undefined;
    });
    return this.eventFlush;
  }

  private flushReplay(keepalive: boolean, force: boolean): Promise<void> {
    if (this.stopped && !this.replayFlush) return Promise.resolve();
    if (this.replayFlush) return this.replayFlush;
    this.replayFlush = (async () => {
      await this.restorePromise;
      await this.storageChain;
      await this.flushReplayQueue(keepalive, force);
    })().finally(() => {
      this.replayFlush = undefined;
    });
    return this.replayFlush;
  }

  private async flushIngestKind(
    kind: IngestKind,
    keepalive: boolean,
    force: boolean,
  ): Promise<void> {
    const now = Date.now();
    const pending = this.queues[kind].splice(0);
    const ready = pending.filter((entry) => force || entry.nextAttemptAt <= now);
    const deferred = pending.filter((entry) => !force && entry.nextAttemptAt > now);
    if (ready.length === 0) {
      this.queues[kind].push(...deferred);
      return;
    }

    let chunks: IngestEntry[][];
    try {
      chunks = chunkBySerializedSize(
        ready,
        this.config.batchSize,
        (items) => items.map((item) => item.event),
      );
    } catch (error) {
      this.dropEntries(ready, 'serialization', error);
      this.queues[kind].push(...deferred);
      return;
    }

    for (let index = 0; index < chunks.length; index += 1) {
      if (this.stopped) return;
      const chunk = chunks[index] ?? [];
      const result = await this.send(
        kind,
        chunk.map((entry) => entry.event),
        keepalive,
      );
      if (result.decision === 'ok') {
        this.stats.sent += chunk.length;
        this.removePersisted(chunk);
        continue;
      }
      if (result.decision === 'drop') {
        this.dropEntries(chunk, result.dropReason ?? 'rejected');
        continue;
      }

      this.markForRetry(chunk, result.retryAfterMs);
      const remaining = chunks.slice(index + 1).flat();
      this.queues[kind].unshift(...chunk, ...remaining);
      this.queues[kind].push(...deferred);
      return;
    }
    this.queues[kind].push(...deferred);
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
        const chunks = chunkBySerializedSize(
          envelopes,
          this.config.replayBatchSize,
          (items) => ({
            session_id: sessionId,
            seq: 0,
            events: items.map((item) => item.event),
          }),
          keepalive ? MAX_KEEPALIVE_BODY_BYTES : TARGET_REPLAY_SEGMENT_BYTES,
        );
        for (const chunk of chunks) {
          const segment: ReplaySegment = {
            ...this.entryBase('replay_segment'),
            kind: 'replay_segment',
            sessionId,
            seq: this.nextReplaySequence(sessionId),
            events: chunk.map((item) => item.event),
          };
          await this.storage.replace(
            chunk.map((item) => item.id),
            segment,
          );
          for (const item of chunk) convertedIds.add(item.id);
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
        {
          session_id: segment.sessionId,
          seq: segment.seq,
          events: segment.events,
        },
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
    kind: RumEventKind,
    body: unknown,
    keepalive: boolean,
  ): Promise<SendResult> {
    let serialized: string;
    try {
      serialized = JSON.stringify(body);
    } catch (error) {
      reportInternalError(this.config.onError, error, `RUM ${kind} serialization failed`);
      return { decision: 'drop', dropReason: 'serialization' };
    }
    if (kind === 'replay' && byteLength(serialized) > MAX_REPLAY_REQUEST_BYTES) {
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
      keepalive: keepalive && byteLength(serialized) <= MAX_KEEPALIVE_BODY_BYTES,
      kind,
    };

    try {
      const response = await this.transport.send(request);
      if (response.ok) return { decision: 'ok' };
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
      this.queues.session.length +
      this.queues.action.length +
      this.queues.error.length +
      this.replayQueue.length +
      this.replayRetrySegments.reduce(
        (total, segment) => total + segment.events.length,
        0,
      )
    );
  }

  private ensureCapacity(): boolean {
    if (this.totalQueued() < this.config.maxQueueSize) return true;
    const candidate =
      this.queues.action.shift() ??
      this.replayQueue.shift() ??
      this.queues.error.shift() ??
      this.queues.session.shift();
    if (!candidate) {
      this.countDrop('queue_full');
      return false;
    }
    this.dropEntries([candidate], 'queue_full');
    return true;
  }

  private ensureReplayCapacity(): boolean {
    if (this.totalQueued() < this.config.maxQueueSize) return true;
    const candidate = this.replayQueue.shift() ?? this.queues.action.shift();
    if (!candidate) {
      this.countDrop('queue_full');
      return false;
    }
    this.dropEntries([candidate], 'queue_full');
    return true;
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
    const stored = await this.storage.load();
    const existing = new Set<string>([
      ...this.queues.session,
      ...this.queues.action,
      ...this.queues.error,
      ...this.replayQueue,
      ...this.replayRetrySegments,
    ].map((entry) => entry.id));
    const invalid: string[] = [];
    let restored = 0;
    for (const candidate of stored.sort((left, right) => left.createdAt - right.createdAt)) {
      if (existing.has(candidate.id)) continue;
      if (!isStoredEntry(candidate)) {
        invalid.push(candidate.id);
        continue;
      }
      if (candidate.kind === 'session') {
        const sessionId = stringField(candidate.event, 'session_id');
        const current = sessionId
          ? this.queues.session.find(
              (entry) => stringField(entry.event, 'session_id') === sessionId,
            )
          : undefined;
        if (current) {
          if (candidate.createdAt > current.createdAt) {
            current.event = candidate.event;
            current.createdAt = candidate.createdAt;
            current.attempts = candidate.attempts;
            current.nextAttemptAt = candidate.nextAttemptAt;
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
        this.queues[candidate.kind].push(candidate);
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
      if (!this.ensureCapacity()) break;
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
    if (!response.ok) {
      try {
        body = await response.text();
      } catch {
        // Some opaque responses do not expose a body.
      }
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

function chunkBySerializedSize<T>(
  items: T[],
  maxItems: number,
  wrapper: (items: T[]) => unknown = (chunk) => chunk,
  maxBytes = MAX_KEEPALIVE_BODY_BYTES,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];

  for (const item of items) {
    const candidate = [...current, item];
    const size = byteLength(JSON.stringify(wrapper(candidate)));
    if (current.length > 0 && (candidate.length > maxItems || size > maxBytes)) {
      chunks.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return value.length * 2;
}

function stringField(value: RumContext, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === 'string' && candidate ? candidate : undefined;
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
  return (
    (candidate.kind === 'session' ||
      candidate.kind === 'action' ||
      candidate.kind === 'error') &&
    !!candidate.event
  );
}
