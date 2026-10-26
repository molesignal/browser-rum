import type { NormalizedRumConfiguration } from './config.js';
import type { RumConnectivity } from './events.js';
import { clampText, generateId, generateUuid } from './utils.js';

export interface DeviceInfo {
  locale?: string;
  time_zone?: string;
}

const INTERFACES = new Set([
  'bluetooth',
  'cellular',
  'ethernet',
  'wifi',
  'wimax',
  'mixed',
  'other',
  'unknown',
  'none',
]);
const EFFECTIVE_TYPES = new Set(['slow-2g', '2g', '3g', '4g']);

interface NetworkInformationLike {
  type?: string;
  effectiveType?: string;
}

/**
 * The browser and operating system are not collected here: the server derives
 * `browser`, `os` and `device` from the User-Agent header with a real parser.
 */
export function readDeviceInfo(): DeviceInfo {
  const device: DeviceInfo = {};
  if (typeof navigator !== 'undefined' && navigator.language) {
    device.locale = clampText(navigator.language, 256);
  }
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timeZone) device.time_zone = clampText(timeZone, 256);
  } catch {
    // Intl data is optional in embedded browsers.
  }
  return device;
}

export function readConnectivity(): RumConnectivity | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const connectivity: RumConnectivity = {
    status: navigator.onLine === false ? 'not_connected' : 'connected',
  };
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike })
    .connection;
  if (connection) {
    if (connection.type && INTERFACES.has(connection.type)) {
      connectivity.interfaces = [connection.type as NonNullable<RumConnectivity['interfaces']>[number]];
    }
    if (connection.effectiveType && EFFECTIVE_TYPES.has(connection.effectiveType)) {
      connectivity.effective_type = connection.effectiveType as RumConnectivity['effective_type'];
    }
  }
  return connectivity;
}

export function readViewport(): { width: number; height: number } | undefined {
  if (typeof window === 'undefined') return undefined;
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return { width: Math.max(0, width), height: Math.max(0, height) };
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
  removeItem(
    typeof localStorage === 'undefined' ? undefined : localStorage,
    `molesignal_rum_anonymous_${storageKey(config.applicationId)}`,
  );
}

/**
 * An identifier for this browser tab. `sessionStorage` is per tab and survives
 * reloads, so a reloaded page keeps its `tab.id`.
 */
export function getTabId(config: NormalizedRumConfiguration): string {
  const key = `molesignal_rum_tab_${storageKey(config.applicationId)}`;
  if (typeof sessionStorage !== 'undefined') {
    try {
      const existing = sessionStorage.getItem(key);
      if (existing && /^[A-Za-z0-9._:-]{1,128}$/.test(existing)) return existing;
      const created = generateUuid();
      sessionStorage.setItem(key, created);
      return created;
    } catch {
      // Storage can be denied in private contexts; fall through to a per-load id.
    }
  }
  return generateUuid();
}

export function clearTabId(config: NormalizedRumConfiguration): void {
  removeItem(
    typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
    `molesignal_rum_tab_${storageKey(config.applicationId)}`,
  );
}

export function storageKey(value: string): string {
  return value.replace(/[^\w.-]/g, '_').slice(0, 80);
}

function removeItem(storage: Storage | undefined, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be denied in private contexts.
  }
}
