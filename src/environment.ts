import type { NormalizedRumConfiguration } from './config.js';
import { generateId } from './utils.js';

export interface BrowserEnvironment {
  browser?: string;
  os?: string;
  device?: string;
  language?: string;
  timezone?: string;
  viewport?: string;
}

export function readBrowserEnvironment(): BrowserEnvironment {
  if (typeof navigator === 'undefined') return {};
  const userAgent = navigator.userAgent ?? '';
  const result: BrowserEnvironment = {
    browser: browserName(userAgent),
    os: operatingSystem(userAgent),
    device: deviceType(userAgent),
    language: navigator.language,
  };

  try {
    result.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Intl data is optional in embedded browsers.
  }
  if (typeof window !== 'undefined') {
    result.viewport = `${window.innerWidth}x${window.innerHeight}`;
  }
  return removeEmpty(result);
}

export function getAnonymousUserId(config: NormalizedRumConfiguration): string | undefined {
  if (!config.trackAnonymousUser || typeof localStorage === 'undefined') return undefined;
  const key = `molesignal_rum_anonymous_${storageKey(config.applicationId)}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = generateId('anon');
    localStorage.setItem(key, created);
    return created;
  } catch {
    return generateId('anon');
  }
}

export function clearAnonymousUserId(config: NormalizedRumConfiguration): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(
      `molesignal_rum_anonymous_${storageKey(config.applicationId)}`,
    );
  } catch {
    // Storage can be denied in private contexts.
  }
}

function browserName(userAgent: string): string | undefined {
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/OPR\//.test(userAgent)) return 'Opera';
  if (/Firefox\/|FxiOS\//.test(userAgent)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(userAgent)) return 'Chrome';
  if (/Safari\//.test(userAgent) && /Version\//.test(userAgent)) return 'Safari';
  return undefined;
}

function operatingSystem(userAgent: string): string | undefined {
  if (/Android/.test(userAgent)) return 'Android';
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
  if (/Windows NT/.test(userAgent)) return 'Windows';
  if (/Mac OS X/.test(userAgent)) return 'macOS';
  if (/Linux/.test(userAgent)) return 'Linux';
  return undefined;
}

function deviceType(userAgent: string): string {
  if (/iPad|Tablet|PlayBook|Silk/i.test(userAgent)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

function storageKey(value: string): string {
  return value.replace(/[^\w.-]/g, '_').slice(0, 80);
}

function removeEmpty<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined || value[key] === '') delete value[key];
  }
  return value;
}
