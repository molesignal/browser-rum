import type { RumContext } from '../types.js';
import { truncate } from '../utils.js';
import type { Cleanup, InstrumentationHooks } from './types.js';

export interface ErrorStackFrame {
  file?: string;
  function?: string;
  line?: number;
  column?: number;
}

export interface ErrorDetails {
  type: string;
  message: string;
  stack: ErrorStackFrame[];
  rawStack?: string;
}

export function instrumentErrors(
  hooks: InstrumentationHooks,
  trackConsoleErrors: boolean,
): Cleanup {
  const onError = (event: ErrorEvent | Event): void => {
    if (event instanceof ErrorEvent) {
      const context: RumContext = {
        source: event.filename || 'window',
        line: event.lineno || undefined,
        column: event.colno || undefined,
      };
      hooks.recordError(event.error ?? event.message, context, 'window');
      return;
    }

    const target = event.target;
    if (target instanceof HTMLScriptElement || target instanceof HTMLImageElement) {
      const url = target instanceof HTMLScriptElement ? target.src : target.currentSrc || target.src;
      hooks.recordError(
        new Error(`Failed to load ${target.tagName.toLowerCase()}: ${hooks.sanitizeUrl(url)}`),
        { source: 'resource', url: hooks.sanitizeUrl(url) },
        'resource',
      );
    } else if (target instanceof HTMLLinkElement) {
      hooks.recordError(
        new Error(`Failed to load link: ${hooks.sanitizeUrl(target.href)}`),
        { source: 'resource', url: hooks.sanitizeUrl(target.href) },
        'resource',
      );
    }
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    hooks.recordError(event.reason, { source: 'unhandledrejection' }, 'promise');
  };

  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onUnhandledRejection);

  const originalConsoleError = console.error;
  let wrappedConsoleError: typeof console.error | undefined;
  if (trackConsoleErrors) {
    wrappedConsoleError = (...args: unknown[]): void => {
      originalConsoleError.apply(console, args);
      const candidate = args.find((argument) => argument instanceof Error) ?? args[0];
      if (candidate !== undefined) {
        hooks.recordError(candidate, { source: 'console', arguments: args.slice(1) }, 'console');
      }
    };
    console.error = wrappedConsoleError;
  }

  return () => {
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    if (wrappedConsoleError && console.error === wrappedConsoleError) {
      console.error = originalConsoleError;
    }
  };
}

export function describeError(error: unknown): ErrorDetails {
  if (error instanceof Error) {
    const rawStack = typeof error.stack === 'string' ? truncate(error.stack, 32_768) : undefined;
    return {
      type: error.name || error.constructor?.name || 'Error',
      message: truncate(error.message || String(error), 4_096),
      stack: rawStack ? parseStack(rawStack) : [],
      rawStack,
    };
  }

  if (typeof error === 'string') {
    return {
      type: inferTypeFromMessage(error),
      message: truncate(error, 4_096),
      stack: [],
    };
  }

  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const message =
      typeof record.message === 'string'
        ? record.message
        : safelyStringify(error) ?? String(error);
    const rawStack = typeof record.stack === 'string' ? truncate(record.stack, 32_768) : undefined;
    return {
      type:
        typeof record.name === 'string' && record.name.trim()
          ? record.name
          : inferTypeFromMessage(message),
      message: truncate(message, 4_096),
      stack: rawStack ? parseStack(rawStack) : [],
      rawStack,
    };
  }

  return {
    type: 'Error',
    message: truncate(String(error), 4_096),
    stack: [],
  };
}

export function parseStack(stack: string): ErrorStackFrame[] {
  const frames: ErrorStackFrame[] = [];
  for (const rawLine of stack.split('\n').slice(1, 51)) {
    const line = rawLine.trim();
    if (!line) continue;
    const location = line.match(/(.*):(\d+):(\d+)\)?$/);
    if (!location?.[1] || !location[2] || !location[3]) continue;

    let prefixAndFile = location[1].trim();
    let functionName: string | undefined;
    let file = prefixAndFile;

    const chrome = prefixAndFile.match(/^at\s+(?:(.*?)\s+\()?(.+?)$/);
    if (chrome?.[2]) {
      functionName = normalizeFunction(chrome[1]);
      file = chrome[2];
    } else {
      const firefox = prefixAndFile.match(/^(.*?)@(.+)$/);
      if (firefox?.[2]) {
        functionName = normalizeFunction(firefox[1]);
        file = firefox[2];
      } else {
        prefixAndFile = prefixAndFile.replace(/^at\s+/, '');
        file = prefixAndFile;
      }
    }

    file = file.replace(/^\(/, '').replace(/\)$/, '');
    const frame: ErrorStackFrame = {
      file,
      line: Number(location[2]),
      column: Number(location[3]),
    };
    if (functionName) frame.function = functionName;
    frames.push(frame);
  }
  return frames;
}

function normalizeFunction(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized !== 'at' ? normalized : undefined;
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
