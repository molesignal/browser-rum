import assert from 'node:assert/strict';

import { contractViolations, sessionStartViolations } from './contract.mjs';

export const CLIENT_TOKEN = 'mspat-0123456789abcdefghjkmnpqrstvwxyz0123';

/** A cookie jar that understands `expires`, which is all the SDK's session cookie needs. */
function createCookieJar() {
  const cookies = new Map();
  const writes = [];
  return {
    writes,
    read() {
      const now = Date.now();
      for (const [name, cookie] of cookies) {
        if (cookie.expires !== undefined && cookie.expires <= now) cookies.delete(name);
      }
      return [...cookies].map(([name, cookie]) => `${name}=${cookie.value}`).join('; ');
    },
    write(raw) {
      writes.push(raw);
      const [pair, ...attributes] = raw.split(';').map((part) => part.trim());
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      let expires;
      for (const attribute of attributes) {
        const [key, ...rest] = attribute.split('=');
        if (key.toLowerCase() === 'expires') expires = Date.parse(rest.join('='));
      }
      if (expires !== undefined && expires <= Date.now()) cookies.delete(name);
      else cookies.set(name, { value, expires });
    },
    get(name) {
      this.read();
      return cookies.get(name)?.value;
    },
    names() {
      this.read();
      return [...cookies.keys()];
    },
    clear() {
      cookies.clear();
    },
  };
}

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function createTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    /** Calls the listeners of `type` the way a browser would. */
    dispatch(type, event = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, ...event });
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

/**
 * Installs the few browser globals the SDK needs into a Node process: enough to
 * exercise sessions, views, events and the queue without a DOM. DOM-bound
 * behavior (clicks, resource timing, rrweb) is covered by the Playwright suite.
 */
export function installBrowser(options = {}) {
  const {
    fetch: fetchImplementation = async () => new Response(null, { status: 200 }),
    url = 'https://app.example.test/products/sku-42?secret=hidden#details',
  } = options;
  const originals = new Map();
  const setGlobal = (name, value) => {
    if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  const cookies = createCookieJar();
  const windowTarget = createTarget();
  const documentTarget = createTarget();
  const location = new URL(url);
  const history = {
    pushState(_data, _unused, target) {
      if (target) location.href = new URL(target, location.href).href;
    },
    replaceState(_data, _unused, target) {
      if (target) location.href = new URL(target, location.href).href;
    },
  };
  const fakeWindow = {
    ...windowTarget,
    location,
    history,
    fetch: fetchImplementation,
    innerWidth: 1440,
    innerHeight: 900,
  };
  const fakeDocument = {
    ...documentTarget,
    readyState: 'complete',
    visibilityState: 'visible',
    referrer: 'https://search.example.test/?q=shoes',
    documentElement: null,
  };
  Object.defineProperty(fakeDocument, 'cookie', {
    get: () => cookies.read(),
    set: (value) => cookies.write(value),
  });
  const localStorage = createStorage();
  const sessionStorage = createStorage();

  setGlobal('window', fakeWindow);
  setGlobal('document', fakeDocument);
  setGlobal('navigator', {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
    language: 'en-US',
    onLine: true,
  });
  setGlobal('localStorage', localStorage);
  setGlobal('sessionStorage', sessionStorage);

  return {
    window: fakeWindow,
    document: fakeDocument,
    location,
    cookies,
    localStorage,
    sessionStorage,
    dispatchWindow: (type, event) => windowTarget.dispatch(type, event),
    dispatchDocument: (type, event) => documentTarget.dispatch(type, event),
    windowListeners: (type) => windowTarget.listenerCount(type),
    documentListeners: (type) => documentTarget.listenerCount(type),
    /** A client-side navigation, as `history.pushState` does it. */
    navigate: (path) => fakeWindow.history.pushState({}, '', path),
    setVisibility(state) {
      fakeDocument.visibilityState = state;
      documentTarget.dispatch('visibilitychange');
    },
    restore() {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

/**
 * A transport that records what the SDK sends. With a node:test context, every
 * event it sees is also checked against the event contract (when the contract is
 * available) and the test fails if one violates it.
 */
export function recordRequests(t, { respond } = {}) {
  const requests = [];
  const violations = [];
  const transport = {
    async send(request) {
      const copy = structuredClone(request);
      requests.push(copy);
      const events = request.kind === 'events' ? JSON.parse(request.body) : [];
      violations.push(...contractViolations(events), ...sessionStartViolations(events));
      if (respond) return respond(copy, events);
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({ accepted: events.length, rejected: [] }),
      };
    },
  };
  t?.after(() => {
    assert.deepEqual(violations, [], 'the SDK sent events that violate the event contract');
  });

  const events = (type) =>
    requests
      .filter((request) => request.kind === 'events')
      .flatMap((request) => JSON.parse(request.body))
      .filter((event) => type === undefined || event.type === type);
  return {
    requests,
    transport,
    events,
    /** The latest revision of each view that was sent. */
    views: () => {
      const latest = new Map();
      for (const view of events('view')) {
        const current = latest.get(view.view.id);
        if (!current || view.view.revision >= current.view.revision) latest.set(view.view.id, view);
      }
      return [...latest.values()];
    },
    replay: () =>
      requests.filter((request) => request.kind === 'replay').map((request) => JSON.parse(request.body)),
  };
}

/** The configuration most tests use: no automatic tracking that needs a DOM. */
export function quietConfiguration(overrides = {}) {
  return {
    applicationId: 'unit-app',
    clientToken: CLIENT_TOKEN,
    site: 'https://rum.example.test',
    trackResources: false,
    trackLongTasks: false,
    trackWebVitals: false,
    trackUserInteractions: false,
    trackAnonymousUser: false,
    flushInterval: 60_000,
    ...overrides,
  };
}
