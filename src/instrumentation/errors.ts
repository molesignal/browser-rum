import { perfNow, relativeToEpoch } from '../clock.js';
import type { RumErrorBody, RumErrorFrame, RumErrorSource } from '../events.js';
import type { RumContext } from '../types.js';
import {
  clampText,
  compact,
  generateUuid,
  INTERNAL_ERROR_FLAG,
  sanitizeContext,
  sanitizeUrl,
  truncate,
} from '../utils.js';
import type { Cleanup, InstrumentationHooks } from './types.js';

const MAX_FRAMES = 100;
const MAX_CAUSES = 10;
const MAX_MESSAGE_CHARS = 4_096;
const MAX_STACK_CHARS = 32_768;
/** The same error is only reported once per second. */
const DEDUPE_WINDOW_MS = 1_000;

export interface ParsedFrame {
  file?: string;
  function?: string;
  line?: number;
  column?: number;
}

export interface ErrorCause {
  type: string;
  message: string;
  frames: ParsedFrame[];
}

export interface ErrorDetails {
  type: string;
  message: string;
  frames: ParsedFrame[];
  causes: ErrorCause[];
}

export interface ErrorInput {
  /** The thrown value; `message`/`type` below override what is derived from it. */
  error?: unknown;
  message?: string;
  type?: string;
  source: RumErrorSource;
  handling: 'handled' | 'unhandled';
  context?: RumContext;
  /** The stack of the code that reported the error, for handled errors. */
  handlingStack?: string;
  /** Where the browser says the error happened, used when the error has no stack. */
  location?: ParsedFrame;
  resource?: RumErrorBody['resource'];
  csp?: RumErrorBody['csp'];
  /**
   * The grouping chosen by the developer. The SDK sets none of its own: the
   * server groups errors, and a fingerprint only overrides that.
   */
  fingerprint?: string;
  /** When the error began, if it was not just now. */
  startRel?: number;
}

/** The longest `error.fingerprint` the contract accepts. */
const MAX_FINGERPRINT_CHARS = 128;

/** Builds `error` events and keeps a burst of identical errors from flooding the queue. */
export class ErrorRecorder {
  private readonly recent = new Map<string, number>();

  constructor(private readonly hooks: InstrumentationHooks) {}

  record(input: ErrorInput): boolean {
    const details =
      input.error !== undefined
        ? describeError(input.error)
        : { type: 'Error', message: '', frames: [], causes: [] };
    const message = truncate(input.message ?? details.message, MAX_MESSAGE_CHARS) || 'Unknown error';
    const type = input.type ?? details.type;
    const parsed =
      details.frames.length > 0 || !input.location ? details.frames : [input.location];
    const frames = this.prepareFrames(parsed);
    const fingerprint = developerFingerprint(input.fingerprint);

    const signature = [
      input.source,
      type,
      message,
      fingerprint ?? '',
      ...frames.slice(0, 3).map((frame) =>
        [frame.file, frame.function, frame.line, frame.column].join(':'),
      ),
    ].join('|');
    if (input.source !== 'network' && this.isDuplicate(signature)) return false;

    const rel = input.startRel;
    const stack = formatStack(type, message, frames);
    const body: RumErrorBody = compact({
      id: generateUuid(),
      message,
      source: input.source,
      type,
      stack: frames.length > 0 ? stack : undefined,
      frames: frames.length > 0 ? frames : undefined,
      fingerprint,
      handling: input.handling,
      handling_stack: input.handlingStack
        ? this.handlingStackText(input.handlingStack)
        : undefined,
      causes: details.causes.length > 0 ? this.prepareCauses(details.causes) : undefined,
      source_type: 'browser' as const,
      resource: input.resource,
      csp: input.csp,
      was_truncated: details.frames.length > MAX_FRAMES ? true : undefined,
    });
    return this.hooks.record({
      type: 'error',
      date: relativeToEpoch(rel ?? perfNow()),
      rel,
      body,
      context: input.context ? sanitizeContext(input.context) : undefined,
    });
  }

  clear(): void {
    this.recent.clear();
  }

  private prepareFrames(frames: ParsedFrame[]): RumErrorFrame[] {
    const { debugId } = this.hooks.config;
    return frames.slice(0, MAX_FRAMES).map((frame) =>
      compact({
        file: frame.file ? sanitizeStackFile(frame.file, this.hooks.config.trackUrlQueryString) : undefined,
        function: frame.function ? clampText(frame.function, 256) : undefined,
        line: frame.line,
        column: frame.column,
        debug_id: debugId,
      }),
    );
  }

  private prepareCauses(causes: ErrorCause[]): NonNullable<RumErrorBody['causes']> {
    return causes.slice(0, MAX_CAUSES).map((cause) => {
      const frames = this.prepareFrames(cause.frames);
      return compact({
        message: truncate(cause.message, MAX_MESSAGE_CHARS),
        type: cause.type,
        stack: frames.length > 0 ? formatStack(cause.type, cause.message, frames) : undefined,
        source: 'source' as const,
      });
    });
  }

  private handlingStackText(stack: string): string {
    const frames = this.prepareFrames(parseStack(stack));
    return frames.map(formatFrame).join('\n');
  }

  private isDuplicate(signature: string): boolean {
    const now = Date.now();
    const previous = this.recent.get(signature);
    if (previous !== undefined && now - previous < DEDUPE_WINDOW_MS) return true;
    this.recent.set(signature, now);
    if (this.recent.size > 100) {
      for (const [key, timestamp] of this.recent) {
        if (now - timestamp > 60_000) this.recent.delete(key);
      }
    }
    return false;
  }
}

export function instrumentErrors(
  hooks: InstrumentationHooks,
  recorder: ErrorRecorder,
): Cleanup {
  const onError = (event: Event): void => {
    if (typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent) {
      if (isInternal(event.error)) return;
      recorder.record({
        error: event.error ?? event.message,
        source: 'source',
        handling: 'unhandled',
        location: event.filename
          ? {
              file: event.filename,
              line: event.lineno || undefined,
              column: event.colno || undefined,
            }
          : undefined,
      });
      return;
    }

    const failed = failedResource(event.target);
    if (!failed) return;
    const url = hooks.sanitizeUrl(failed.url);
    recorder.record({
      message: `Failed to load ${failed.kind}: ${url}`,
      type: 'ResourceLoadError',
      source: 'network',
      handling: 'unhandled',
      resource: { method: 'GET', status_code: 0, url },
    });
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    if (isInternal(event.reason)) return;
    recorder.record({
      error: event.reason,
      source: 'source',
      handling: 'unhandled',
    });
  };

  const onSecurityPolicyViolation = (event: SecurityPolicyViolationEvent): void => {
    recorder.record({
      message: `'${event.effectiveDirective}' directive violation: '${hooks.sanitizeUrl(
        event.blockedURI,
      )}' was blocked`,
      type: 'SecurityPolicyViolation',
      source: 'report',
      handling: 'unhandled',
      csp: { disposition: event.disposition === 'report' ? 'report' : 'enforce' },
    });
  };

  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  document.addEventListener('securitypolicyviolation', onSecurityPolicyViolation);

  const originalConsoleError = console.error;
  let wrappedConsoleError: typeof console.error | undefined;
  if (hooks.config.trackConsoleErrors) {
    wrappedConsoleError = (...args: unknown[]): void => {
      originalConsoleError.apply(console, args);
      const candidate = args.find((argument) => argument instanceof Error) ?? args[0];
      if (candidate !== undefined && !isInternal(candidate)) {
        recorder.record({
          error: candidate,
          source: 'console',
          handling: 'handled',
          handlingStack: captureHandlingStack(),
          context: args.length > 1 ? { arguments: args.slice(1) } : undefined,
        });
      }
    };
    console.error = wrappedConsoleError;
  }

  return () => {
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    document.removeEventListener('securitypolicyviolation', onSecurityPolicyViolation);
    if (wrappedConsoleError && console.error === wrappedConsoleError) {
      console.error = originalConsoleError;
    }
  };
}

/** The stack of the caller, so that a handled error can be traced back to where it was reported. */
export function captureHandlingStack(): string | undefined {
  try {
    const stack = new Error('handling stack').stack;
    if (!stack) return undefined;
    const lines = stack.split('\n');
    // V8 starts with the message; SpiderMonkey and JavaScriptCore start with a frame.
    if (lines[0] && !/^\s*at\s/.test(lines[0]) && !lines[0].includes('@')) lines.shift();
    // Drop this function and the one that called it: both are the SDK.
    return lines.slice(2).join('\n');
  } catch {
    return undefined;
  }
}

export function describeError(error: unknown): ErrorDetails {
  const causes = collectCauses(error);
  if (error instanceof Error) {
    return {
      type: error.name || error.constructor?.name || 'Error',
      message: error.message || String(error),
      frames: typeof error.stack === 'string' ? parseStack(error.stack) : [],
      causes,
    };
  }

  if (typeof error === 'string') {
    return { type: inferTypeFromMessage(error), message: error, frames: [], causes };
  }

  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const message =
      typeof record.message === 'string'
        ? record.message
        : safelyStringify(error) ?? String(error);
    return {
      type:
        typeof record.name === 'string' && record.name.trim()
          ? record.name
          : inferTypeFromMessage(message),
      message,
      frames: typeof record.stack === 'string' ? parseStack(record.stack) : [],
      causes,
    };
  }

  return { type: 'Error', message: String(error), frames: [], causes };
}

/** The `cause` chain of an error, nearest first. */
function collectCauses(error: unknown): ErrorCause[] {
  const causes: ErrorCause[] = [];
  const seen = new Set<unknown>([error]);
  let current: unknown = (error as { cause?: unknown } | null | undefined)?.cause;
  while (current !== undefined && current !== null && causes.length < MAX_CAUSES && !seen.has(current)) {
    seen.add(current);
    const own = describeErrorShallow(current);
    causes.push(own);
    current = (current as { cause?: unknown }).cause;
  }
  return causes;
}

function describeErrorShallow(error: unknown): ErrorCause {
  if (error instanceof Error) {
    return {
      type: error.name || 'Error',
      message: error.message || String(error),
      frames: typeof error.stack === 'string' ? parseStack(error.stack) : [],
    };
  }
  const message = typeof error === 'string' ? error : (safelyStringify(error) ?? String(error));
  return { type: inferTypeFromMessage(message), message, frames: [] };
}

/**
 * Parses V8 (`at fn (file:1:2)`), SpiderMonkey and JavaScriptCore
 * (`fn@file:1:2`) stack lines. Lines without a location are skipped.
 */
export function parseStack(stack: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const rawLine of truncate(stack, MAX_STACK_CHARS).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let functionName: string | undefined;
    let location: string;
    if (line.startsWith('at ')) {
      const body = line.slice(3).trim();
      if (body.endsWith(')') && body.includes(' (')) {
        const open = body.lastIndexOf(' (');
        functionName = body.slice(0, open).trim();
        location = body.slice(open + 2, -1);
      } else {
        location = body.replace(/^async\s+/, '');
      }
    } else {
      const at = line.indexOf('@');
      if (at < 0) continue;
      functionName = line.slice(0, at).trim();
      location = line.slice(at + 1);
    }

    const match = location.match(/^(.*):(\d+):(\d+)$/);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const frame: ParsedFrame = {
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
    };
    const name = normalizeFunction(functionName);
    if (name) frame.function = name;
    frames.push(frame);
    if (frames.length > MAX_FRAMES) break;
  }
  return frames;
}

/**
 * A file in a stack is an absolute URL, or a name such as `<anonymous>` or
 * `node:internal/x`. Only the former is sanitized, and never against the page
 * URL: a relative reading of a bare name would invent a location.
 */
function sanitizeStackFile(file: string, includeQueryString: boolean): string {
  return clampText(sanitizeUrl(file, includeQueryString), 1_024);
}

function formatStack(type: string, message: string, frames: RumErrorFrame[]): string {
  const header = `${type}: ${truncate(message, 1_000)}`;
  return [header, ...frames.map(formatFrame)].join('\n');
}

function formatFrame(frame: RumErrorFrame): string {
  const location = `${frame.file ?? '<anonymous>'}:${frame.line ?? 0}:${frame.column ?? 0}`;
  return frame.function ? `    at ${frame.function} (${location})` : `    at ${location}`;
}

function normalizeFunction(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized !== 'at' && normalized !== 'anonymous' ? normalized : undefined;
}

/** A fingerprint the developer passed: sent as given, up to the contract's limit, or not at all. */
function developerFingerprint(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return clampText(value, MAX_FINGERPRINT_CHARS);
}

function inferTypeFromMessage(message: string): string {
  const match = message.match(/^([A-Za-z][\w.]*Error)\b/);
  return match?.[1] ?? 'Error';
}

function safelyStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isInternal(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[INTERNAL_ERROR_FLAG] === true
  );
}

function failedResource(
  target: EventTarget | null,
): { kind: string; url: string } | undefined {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return undefined;
  if (typeof HTMLScriptElement !== 'undefined' && target instanceof HTMLScriptElement) {
    return target.src ? { kind: 'script', url: target.src } : undefined;
  }
  if (typeof HTMLImageElement !== 'undefined' && target instanceof HTMLImageElement) {
    const url = target.currentSrc || target.src;
    return url ? { kind: 'img', url } : undefined;
  }
  if (typeof HTMLLinkElement !== 'undefined' && target instanceof HTMLLinkElement) {
    return target.href ? { kind: 'link', url: target.href } : undefined;
  }
  return undefined;
}
