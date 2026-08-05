import type { NormalizedRumConfiguration } from './config.js';
import { rumEndpoint } from './config.js';
import type {
  RumContext,
  RumEventKind,
  RumTransport,
  RumTransportRequest,
  RumTransportResponse,
} from './types.js';
import { reportInternalError } from './utils.js';

type IngestKind = Exclude<RumEventKind, 'replay'>;

interface ReplayEnvelope {
  sessionId: string;
  event: RumContext;
}

interface ReplaySegment {
  sessionId: string;
  seq: number;
  events: RumContext[];
}

const MAX_KEEPALIVE_BODY_BYTES = 48 * 1024;
const TARGET_REPLAY_SEGMENT_BYTES = 1024 * 1024;
const MAX_REPLAY_REQUEST_BYTES = 8 * 1024 * 1024;

export class EventTransport {
  private readonly queues: Record<IngestKind, RumContext[]> = {
    session: [],
    action: [],
    error: [],
  };
  private replayQueue: ReplayEnvelope[] = [];
  private replayRetrySegments: ReplaySegment[] = [];
  private readonly endpoints: Record<RumEventKind, string>;
  private readonly transport: RumTransport;
  private eventTimer?: ReturnType<typeof globalThis.setInterval>;
  private replayTimer?: ReturnType<typeof globalThis.setInterval>;
  private eventFlush?: Promise<void>;
  private replayFlush?: Promise<void>;

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
  }

  start(): void {
    if (this.eventTimer === undefined) {
      this.eventTimer = globalThis.setInterval(() => {
        void this.flushEvents(false);
      }, this.config.flushInterval);
    }
    if (this.replayTimer === undefined) {
      this.replayTimer = globalThis.setInterval(() => {
        void this.flushReplay(false);
      }, this.config.replayFlushInterval);
    }
  }

  enqueue(kind: IngestKind, event: RumContext): void {
    this.ensureCapacity(kind);
    this.queues[kind].push(event);
    if (this.queues[kind].length >= this.config.batchSize) {
      void this.flushEvents(false);
    }
  }

  enqueueReplay(sessionId: string, event: RumContext): void {
    if (!this.ensureReplayCapacity()) return;
    this.replayQueue.push({ sessionId, event });
    if (event.type === 2 || this.replayQueue.length >= this.config.replayBatchSize) {
      void this.flushReplay(false);
    }
  }

  isSdkUrl(url: string): boolean {
    return Object.values(this.endpoints).some((endpoint) => url.startsWith(endpoint));
  }

  async flush(keepalive = false): Promise<void> {
    await Promise.all([this.flushEvents(keepalive), this.flushReplay(keepalive)]);
  }

  async stop(): Promise<void> {
    if (this.eventTimer !== undefined) {
      globalThis.clearInterval(this.eventTimer);
      this.eventTimer = undefined;
    }
    if (this.replayTimer !== undefined) {
      globalThis.clearInterval(this.replayTimer);
      this.replayTimer = undefined;
    }
    await this.flush(true);
  }

  private flushEvents(keepalive: boolean): Promise<void> {
    if (this.eventFlush) return this.eventFlush;
    this.eventFlush = Promise.all(
      (['session', 'action', 'error'] as const).map((kind) =>
        this.flushIngestKind(kind, keepalive),
      ),
    )
      .then(() => undefined)
      .finally(() => {
        this.eventFlush = undefined;
      });
    return this.eventFlush;
  }

  private flushReplay(keepalive: boolean): Promise<void> {
    if (this.replayFlush) return this.replayFlush;
    this.replayFlush = this.flushReplayQueue(keepalive).finally(() => {
      this.replayFlush = undefined;
    });
    return this.replayFlush;
  }

  private async flushIngestKind(kind: IngestKind, keepalive: boolean): Promise<void> {
    const pending = this.queues[kind].splice(0);
    if (pending.length === 0) return;
    const chunks = chunkBySerializedSize(pending, this.config.batchSize);

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? [];
      const result = await this.send(kind, chunk, keepalive);
      if (result === 'retry') {
        const remaining = chunks.slice(index).flat();
        this.prependWithLimit(this.queues[kind], remaining);
        return;
      }
    }
  }

  private async flushReplayQueue(keepalive: boolean): Promise<void> {
    const pending = this.replayQueue.splice(0);
    const segments = this.replayRetrySegments.splice(0);

    const grouped = new Map<string, ReplayEnvelope[]>();
    for (const envelope of pending) {
      const list = grouped.get(envelope.sessionId) ?? [];
      list.push(envelope);
      grouped.set(envelope.sessionId, list);
    }

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
        segments.push({
          sessionId,
          seq: this.nextReplaySequence(sessionId),
          events: chunk.map((item) => item.event),
        });
      }
    }

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
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
      if (result === 'retry') {
        this.replayRetrySegments.unshift(...segments.slice(index));
        return;
      }
    }
  }

  private async send(
    kind: RumEventKind,
    body: unknown,
    keepalive: boolean,
  ): Promise<'ok' | 'drop' | 'retry'> {
    let serialized: string;
    try {
      serialized = JSON.stringify(body);
    } catch (error) {
      reportInternalError(this.config.onError, error, `RUM ${kind} serialization failed`);
      return 'drop';
    }
    if (kind === 'replay' && byteLength(serialized) > MAX_REPLAY_REQUEST_BYTES) {
      reportInternalError(
        this.config.onError,
        new Error('replay segment exceeds 8 MiB'),
        'RUM replay upload dropped',
      );
      return 'drop';
    }

    const request: RumTransportRequest = {
      url: this.endpoints[kind],
      body: serialized,
      headers: {
        authorization: `Bearer ${this.config.clientToken}`,
        'content-type': 'application/json',
        'x-molesignal-rum': 'browser-rum/0.1.0',
      },
      keepalive: keepalive && byteLength(serialized) <= MAX_KEEPALIVE_BODY_BYTES,
      kind,
    };

    try {
      const response = await this.transport.send(request);
      if (response.ok) return 'ok';
      const message = `${response.status} ${response.statusText ?? ''}${
        response.body ? `: ${response.body.slice(0, 512)}` : ''
      }`.trim();
      reportInternalError(
        this.config.onError,
        new Error(message),
        `RUM ${kind} upload rejected`,
      );
      return isRetryableStatus(response.status) ? 'retry' : 'drop';
    } catch (error) {
      reportInternalError(this.config.onError, error, `RUM ${kind} upload failed`);
      return 'retry';
    }
  }

  private totalQueued(): number {
    return (
      this.queues.session.length +
      this.queues.action.length +
      this.queues.error.length +
      this.replayQueue.length +
      this.replayRetrySegments.reduce((total, segment) => total + segment.events.length, 0)
    );
  }

  private ensureCapacity(preferred: IngestKind): void {
    if (this.totalQueued() < this.config.maxQueueSize) return;
    if (this.queues[preferred].length > 0) {
      this.queues[preferred].shift();
      return;
    }
    const candidate = (['action', 'error', 'session'] as const).find(
      (kind) => this.queues[kind].length > 0,
    );
    if (candidate) this.queues[candidate].shift();
    else this.replayQueue.shift();
  }

  private ensureReplayCapacity(): boolean {
    if (this.totalQueued() < this.config.maxQueueSize) return true;
    if (this.replayQueue.length > 0) {
      this.replayQueue.shift();
      return true;
    }
    // Retry segments are immutable once assigned a sequence. Mutating one
    // could make a lost-response retry overwrite an already stored segment.
    return false;
  }

  private prependWithLimit<T>(target: T[], values: T[]): void {
    target.unshift(...values);
    if (target.length > this.config.maxQueueSize) {
      target.splice(this.config.maxQueueSize);
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
    };
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
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
