import type { RumContext } from '../types.js';
import type { TraceContext } from '../utils.js';

export interface ActionInput {
  type: string;
  name?: string;
  url?: string;
  durationMs?: number;
  status?: number;
  lcpMs?: number;
  fidMs?: number;
  cls?: number;
  ttfbMs?: number;
  timestampMicros?: number;
  traceContext?: TraceContext;
  service?: string;
  context?: RumContext;
}

export interface InstrumentationHooks {
  recordAction(input: ActionInput): void;
  recordError(error: unknown, context?: RumContext, source?: string): void;
  startView(name?: string, context?: RumContext): void;
  markActivity(): void;
  markChange(): void;
  getChangeId(): number;
  currentPage(): string;
  sanitizeUrl(url: string): string;
  isSdkUrl(url: string): boolean;
  shouldTrackUrl(url: string): boolean;
  shouldReadTrace(url: string): boolean;
}

export type Cleanup = () => void;
