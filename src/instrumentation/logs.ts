import { relativeToEpoch, perfNow } from '../clock.js';
import type { RumLogBody, RumLogLevel } from '../events.js';
import type { RumContext, RumLogger, RumLoggerOptions } from '../types.js';
import { clampText, compact, generateUuid, sanitizeContext, truncate } from '../utils.js';
import type { Cleanup, InstrumentationHooks } from './types.js';

const MAX_MESSAGE_CHARS = 16_000;
const MAX_STACK_CHARS = 32_000;
/** What the SDK says of itself in one page load, at most. */
const MAX_SDK_LOGS = 10;

/** The order of the levels: a logger leaves out what is below its own. */
const ORDER: Record<RumLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** The console methods that can be forwarded, and the level each writes at. */
const CONSOLE_LEVELS = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
} as const satisfies Record<string, RumLogLevel>;

export type ForwardedConsoleLevel = keyof typeof CONSOLE_LEVELS;
export const FORWARDED_CONSOLE_LEVELS = Object.keys(CONSOLE_LEVELS) as ForwardedConsoleLevel[];

export interface LogInput {
  level: RumLogLevel;
  message: string;
  context?: RumContext;
  error?: unknown;
  logger?: string;
  origin: NonNullable<RumLogBody['origin']>;
}

/** Writes one log into the session and view it happened in; false when it was not written. */
export function recordLog(hooks: InstrumentationHooks, input: LogInput): boolean {
  const message = clampText(input.message.trim(), MAX_MESSAGE_CHARS);
  if (!message) return false;
  const failure = describeFailure(input.error);
  const body: RumLogBody = compact({
    id: generateUuid(),
    logger: input.logger ? clampText(input.logger, 256) : undefined,
    origin: input.origin,
    error_type: failure?.type ? clampText(failure.type, 256) : undefined,
    stack: failure?.stack ? truncate(failure.stack, MAX_STACK_CHARS) : undefined,
  });
  return hooks.record({
    type: 'log',
    date: relativeToEpoch(perfNow()),
    body,
    context: input.context ? sanitizeContext(input.context) : undefined,
    attributes: { level: input.level, message },
  });
}

function describeFailure(error: unknown): { type?: string; stack?: string } | undefined {
  if (error instanceof Error) {
    return { type: error.name || 'Error', stack: error.stack };
  }
  return undefined;
}

/** What a logger writes to: a client once there is one, a buffer until then. */
export type LogSink = (input: LogInput) => void;

/** A logger of a name, with its own lowest level and attributes. */
export function createLogger(sink: LogSink, options: RumLoggerOptions = {}): RumLogger {
  let lowest = options.level ?? 'debug';
  const write = (
    level: RumLogLevel,
    message: string,
    context?: RumContext,
    error?: unknown,
  ): void => {
    if (ORDER[level] < ORDER[lowest] || typeof message !== 'string') return;
    sink({
      level,
      message,
      context: { ...options.context, ...context },
      error,
      logger: options.name,
      origin: 'logger',
    });
  };
  return {
    debug: (message, context, error) => write('debug', message, context, error),
    info: (message, context, error) => write('info', message, context, error),
    warn: (message, context, error) => write('warn', message, context, error),
    error: (message, context, error) => write('error', message, context, error),
    setLevel: (level) => {
      lowest = level;
    },
  };
}

/** A value of `console.log` as text. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** Forwards the console methods asked for into logs. What they print is left as it is. */
export function instrumentConsole(
  hooks: InstrumentationHooks,
  levels: readonly ForwardedConsoleLevel[],
): Cleanup {
  const restored: Array<() => void> = [];
  let forwarding = false;

  for (const name of levels) {
    const target = console as unknown as Record<string, (...args: unknown[]) => void>;
    const original = target[name];
    if (typeof original !== 'function') continue;

    const wrapped = (...args: unknown[]): void => {
      original.apply(console, args);
      // A failure of the SDK is written to the console by the page's `onError`: not again.
      if (forwarding) return;
      forwarding = true;
      try {
        recordLog(hooks, {
          level: CONSOLE_LEVELS[name],
          message: args.map(textOf).join(' '),
          error: args.find((argument) => argument instanceof Error),
          logger: 'console',
          origin: 'console',
        });
      } finally {
        forwarding = false;
      }
    };

    target[name] = wrapped;
    restored.push(() => {
      if (target[name] === wrapped) target[name] = original;
    });
  }

  return () => {
    for (const restore of restored) restore();
  };
}

/** What goes wrong on the way to the server cannot be told by sending more to it. */
const UNDELIVERED = /^RUM (\w+ upload|queue|telemetry dropped)/;

/** Says what goes wrong in the SDK itself, as logs of the application, a few per page load. */
export function createSdkReporter(
  hooks: () => InstrumentationHooks | undefined,
): (error: Error) => void {
  const seen = new Set<string>();
  return (error) => {
    if (UNDELIVERED.test(error.message)) return;
    if (seen.size >= MAX_SDK_LOGS || seen.has(error.message)) return;
    const target = hooks();
    if (!target) return;
    seen.add(error.message);
    recordLog(target, {
      level: 'warn',
      message: error.message,
      logger: 'molesignal-rum',
      origin: 'sdk',
    });
  };
}
