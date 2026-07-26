import assert from 'node:assert/strict';
import test from 'node:test';

import { getRum, initRum } from '../dist/index.js';

test('configuration validation and SSR imports are safe', async () => {
  assert.throws(
    () => initRum({ applicationId: '', clientToken: 'token', site: 'https://rum.test' }),
    /applicationId/,
  );
  assert.throws(
    () => initRum({ applicationId: 'app', clientToken: 'token', site: 'ftp://rum.test' }),
    /http or https/,
  );

  const sent = [];
  const client = initRum({
    applicationId: 'ssr-app',
    clientToken: 'token',
    site: 'https://rum.test',
    transport: transportInto(sent),
  });
  client.addAction('server render');
  await client.flush();
  assert.equal(sent.length, 0);
  assert.equal(getRum(), client);
  await client.stop();
});

test('sessions, actions, and errors follow the MoleSignal ingest contract', async () => {
  const restoreBrowser = installBrowser();
  const sent = [];
  try {
    const client = initRum({
      applicationId: 'checkout-web',
      clientToken: 'ms_public_test',
      site: 'https://rum.example.test',
      service: 'web-frontend',
      env: 'production',
      version: 'v1.2.3',
      user: { id: 'user-42', plan: 'pro' },
      globalContext: { region: 'eu-west-1' },
      sessionSampleRate: 100,
      sessionReplaySampleRate: 0,
      trackViewsManually: true,
      trackResources: false,
      trackLongTasks: false,
      trackWebVitals: false,
      trackUserInteractions: false,
      trackAnonymousUser: false,
      flushInterval: 60_000,
      transport: transportInto(sent),
    });

    client.addAction('Checkout started', {
      cart_size: 3,
      password: 'must-not-leak',
    });
    client.addError(new TypeError('Cannot read total'), { component: 'CartSummary' });
    await client.flush();

    const sessionRequest = onlyRequest(sent, 'session');
    assert.equal(sessionRequest.url, 'https://rum.example.test/api/v1/rum/v1/sessions');
    assert.equal(sessionRequest.headers.authorization, 'Bearer ms_public_test');
    const [session] = JSON.parse(sessionRequest.body);
    assert.match(session.session_id, /^ses_/);
    assert.equal(session.application, 'checkout-web');
    assert.equal(session.service, 'web-frontend');
    assert.equal(session.environment, 'production');
    assert.equal(session.version, 'v1.2.3');
    assert.equal(session.user_id, 'user-42');
    assert.equal(typeof session.started_at_micros, 'number');

    const actionRequests = sent.filter((request) => request.kind === 'action');
    const actions = actionRequests.flatMap((request) => JSON.parse(request.body));
    const customAction = actions.find((event) => event.name === 'Checkout started');
    assert.ok(customAction);
    assert.equal(customAction.type, 'custom');
    assert.equal(customAction.payload.region, 'eu-west-1');
    assert.equal(customAction.payload.cart_size, 3);
    assert.equal(customAction.payload.password, '[Redacted]');
    assert.equal(customAction.page, '/products/sku-42');

    const errorRequest = onlyRequest(sent, 'error');
    const [errorEvent] = JSON.parse(errorRequest.body);
    assert.equal(errorEvent.error_type, 'TypeError');
    assert.equal(errorEvent.message, 'Cannot read total');
    assert.match(errorEvent.fingerprint, /^fp_[0-9a-f]{8}$/);
    assert.ok(Array.isArray(errorEvent.error.stack));
    assert.equal(errorEvent.error.context.component, 'CartSummary');

    await client.stop();
  } finally {
    restoreBrowser();
  }
});

test('fetch instrumentation carries W3C trace context into rum_actions', async () => {
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const parentSpanId = '00f067aa0ba902b7';
  const restoreBrowser = installBrowser(async () =>
    new Response(null, {
      status: 204,
      headers: {
        traceparent: `00-${traceId}-${parentSpanId}-01`,
      },
    }),
  );
  const sent = [];
  try {
    const client = initRum({
      applicationId: 'shop',
      clientToken: 'token',
      site: 'https://rum.example.test/api/v1',
      service: 'shop-web',
      sessionSampleRate: 100,
      trackViewsManually: true,
      trackResources: true,
      trackLongTasks: false,
      trackWebVitals: false,
      trackUserInteractions: false,
      trackAnonymousUser: false,
      flushInterval: 60_000,
      transport: transportInto(sent),
    });

    await window.fetch('https://app.example.test/api/orders', {
      headers: {
        traceparent: `00-${traceId}-1111111111111111-01`,
      },
    });
    await client.flush();

    const actions = sent
      .filter((request) => request.kind === 'action')
      .flatMap((request) => JSON.parse(request.body));
    const resource = actions.find((event) => event.type === 'resource');
    assert.ok(resource);
    assert.equal(resource.url, 'https://app.example.test/api/orders');
    assert.equal(resource.status, 204);
    assert.equal(resource.trace_id, traceId);
    assert.equal(resource.parent_span_id, parentSpanId);
    assert.equal(resource.payload.method, 'GET');

    await client.stop();
  } finally {
    restoreBrowser();
  }
});

test('session replay uploads ordered timeline segments', async () => {
  const restoreBrowser = installBrowser();
  const sent = [];
  try {
    const client = initRum({
      applicationId: 'replay-app',
      clientToken: 'token',
      site: 'https://rum.example.test/api',
      sessionSampleRate: 100,
      sessionReplaySampleRate: 100,
      trackViewsManually: true,
      trackResources: false,
      trackLongTasks: false,
      trackWebVitals: false,
      trackUserInteractions: false,
      trackAnonymousUser: false,
      flushInterval: 60_000,
      replayFlushInterval: 60_000,
      transport: transportInto(sent),
    });

    client.startView('Product detail');
    client.addAction('Add to cart', { selector: '#add-to-cart' });
    await client.flush();

    const replayRequest = onlyRequest(sent, 'replay');
    assert.equal(
      replayRequest.url,
      'https://rum.example.test/api/v1/rum/v1/replay',
    );
    const replay = JSON.parse(replayRequest.body);
    assert.match(replay.session_id, /^ses_/);
    assert.equal(replay.seq, 1);
    assert.ok(replay.events.length >= 2);
    assert.ok(replay.events.some((event) => event.type === 'snapshot'));
    assert.ok(replay.events.some((event) => event.name === 'Add to cart'));

    await client.stop();
  } finally {
    restoreBrowser();
  }
});

function onlyRequest(requests, kind) {
  const matches = requests.filter((request) => request.kind === kind);
  assert.equal(matches.length, 1, `expected one ${kind} request`);
  return matches[0];
}

function transportInto(requests) {
  return {
    async send(request) {
      requests.push(structuredClone(request));
      return { ok: true, status: 200 };
    },
  };
}

function installBrowser(
  fetchImplementation = async () => new Response(null, { status: 200 }),
) {
  const originals = new Map();
  const setGlobal = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  const storage = () => {
    const values = new Map();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
      clear: () => values.clear(),
    };
  };
  const listeners = new Map();
  const eventTarget = {
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? new Set();
      values.add(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  const location = new URL('https://app.example.test/products/sku-42?secret=hidden#details');
  const history = {
    pushState(_data, _unused, url) {
      if (url) location.href = new URL(url, location.href).href;
    },
    replaceState(_data, _unused, url) {
      if (url) location.href = new URL(url, location.href).href;
    },
  };
  const fakeWindow = {
    ...eventTarget,
    location,
    history,
    fetch: fetchImplementation,
    innerWidth: 1440,
    innerHeight: 900,
  };
  const fakeDocument = {
    ...eventTarget,
    readyState: 'complete',
    visibilityState: 'visible',
    documentElement: null,
  };

  setGlobal('window', fakeWindow);
  setGlobal('document', fakeDocument);
  setGlobal('navigator', {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
    language: 'en-US',
  });
  setGlobal('localStorage', storage());
  setGlobal('sessionStorage', storage());

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}
