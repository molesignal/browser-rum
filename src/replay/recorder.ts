import { record } from '@rrweb/record';

import type { NormalizedRumConfiguration } from '../config.js';
import type { RumContext } from '../types.js';
import { reportInternalError, sanitizeUrl } from '../utils.js';

type StopRecording = () => void;

/** Owns one rrweb recorder and guarantees that events never cross sessions. */
export class ReplayRecorder {
  private sessionId?: string;
  private pendingSessionId?: string;
  private stopRecording?: StopRecording;
  private readyListener?: () => void;

  constructor(
    private readonly config: NormalizedRumConfiguration,
    private readonly emit: (sessionId: string, event: RumContext) => void,
  ) {}

  start(sessionId: string): void {
    if (this.sessionId === sessionId && this.stopRecording) return;
    this.stop();
    if (!document.documentElement) {
      this.pendingSessionId = sessionId;
      const onReady = () => {
        this.readyListener = undefined;
        const pending = this.pendingSessionId;
        this.pendingSessionId = undefined;
        if (pending) this.start(pending);
      };
      this.readyListener = onReady;
      document.addEventListener('DOMContentLoaded', onReady, { once: true });
      return;
    }

    this.sessionId = sessionId;
    try {
      const stop = record({
        emit: (event) => {
          if (this.sessionId === sessionId) {
            sanitizeReplayUrls(event, this.config.trackUrlQueryString);
            this.emit(sessionId, event as unknown as RumContext);
          }
        },
        blockSelector: this.config.sessionReplay.blockSelector,
        ignoreSelector: this.config.sessionReplay.ignoreSelector,
        maskTextSelector:
          this.config.defaultPrivacyLevel === 'mask'
            ? '*'
            : `${this.config.sessionReplay.maskTextSelector}, [contenteditable]:not([contenteditable="false"])`,
        // Inputs, including passwords, are never sent as clear text even when
        // the broader privacy level allows visible page text.
        maskAllInputs: true,
        slimDOMOptions: 'all',
        inlineStylesheet: true,
        inlineImages: this.config.sessionReplay.inlineImages,
        collectFonts: this.config.sessionReplay.collectFonts,
        recordCrossOriginIframes: this.config.sessionReplay.recordCrossOriginIframes,
        checkoutEveryNms: this.config.sessionReplay.checkoutInterval,
        sampling: {
          mousemove: 50,
          scroll: 100,
          input: 'last',
        },
        errorHandler: (error) => {
          reportInternalError(this.config.onError, error, 'RUM replay recorder failed');
        },
      });
      if (typeof stop === 'function') this.stopRecording = stop;
    } catch (error) {
      this.sessionId = undefined;
      reportInternalError(this.config.onError, error, 'RUM replay recorder failed to start');
    }
  }

  stop(): void {
    if (this.readyListener) {
      document.removeEventListener('DOMContentLoaded', this.readyListener);
      this.readyListener = undefined;
    }
    this.pendingSessionId = undefined;
    const stop = this.stopRecording;
    this.stopRecording = undefined;
    this.sessionId = undefined;
    if (!stop) return;
    try {
      stop();
    } catch (error) {
      reportInternalError(this.config.onError, error, 'RUM replay recorder failed to stop');
    }
  }
}

const URL_FIELDS = new Set([
  'action',
  'baseuri',
  'formaction',
  'href',
  'poster',
  'src',
  'xlink:href',
]);
const CSS_FIELDS = new Set(['_csstext', 'style']);

/** Keep DOM snapshots inside the same URL privacy boundary as action events. */
function sanitizeReplayUrls(event: unknown, includeQueryString: boolean): void {
  if (!event || typeof event !== 'object') return;
  const stack: object[] = [event];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string' && URL_FIELDS.has(key.toLowerCase())) {
        (current as Record<string, unknown>)[key] = sanitizeReplayUrl(
          value,
          includeQueryString,
        );
      } else if (typeof value === 'string' && CSS_FIELDS.has(key.toLowerCase())) {
        (current as Record<string, unknown>)[key] = sanitizeCssUrls(
          value,
          includeQueryString,
        );
      } else if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }
}

function sanitizeCssUrls(css: string, includeQueryString: boolean): string {
  return css.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (match, quote: string, value: string) => {
      const raw = value.trim();
      if (raw.startsWith('#') || /^data:/i.test(raw)) return match;
      return `url(${quote}${sanitizeReplayUrl(raw, includeQueryString)}${quote})`;
    },
  );
}

function sanitizeReplayUrl(raw: string, includeQueryString: boolean): string {
  const value = raw.trim();
  if (value.startsWith('#')) return value;
  const sanitized = sanitizeUrl(value, includeQueryString, window.location.href);
  try {
    const protocol = new URL(sanitized, window.location.href).protocol.toLowerCase();
    if (protocol === 'javascript:' || protocol === 'vbscript:') return 'about:blank';
  } catch {
    // sanitizeUrl already removed query/hash text from non-standard values.
  }
  return sanitized;
}
