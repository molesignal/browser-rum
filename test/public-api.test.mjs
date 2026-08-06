import assert from 'node:assert/strict';
import test from 'node:test';

import { getRum, initRum } from '../dist/index.js';

const CLIENT_TOKEN =
  'msrum_0123456789ABCDEF_0123456789ABCDEF0123456789ABCDEF';

test('configuration validation and SSR imports are safe', async () => {
  assert.throws(
    () => initRum({ applicationId: '', clientToken: CLIENT_TOKEN, site: 'https://rum.test' }),
    /applicationId/,
  );
  assert.throws(
    () => initRum({ applicationId: 'app', clientToken: CLIENT_TOKEN, site: 'ftp://rum.test' }),
    /http or https/,
  );
  assert.throws(
    () => initRum({ applicationId: 'app', clientToken: 'ms_personal', site: 'https://rum.test' }),
    /application-bound msrum_/,
  );
  assert.throws(
    () =>
      initRum({
        applicationId: 'app',
        clientToken: CLIENT_TOKEN,
        site: 'https://rum.test',
        debugId: 'build-without-version',
      }),
    /version.*required/,
  );

  const sent = [];
  const client = initRum({
    applicationId: 'ssr-app',
    clientToken: CLIENT_TOKEN,
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
      clientToken: CLIENT_TOKEN,
      site: 'https://rum.example.test',
      service: 'web-frontend',
      env: 'production',
      version: 'v1.2.3',
      debugId: 'checkout-build-123',
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
    assert.equal(sessionRequest.url, 'https://rum.example.test/api/v1/rum/sessions');
    assert.equal(sessionRequest.headers.authorization, `Bearer ${CLIENT_TOKEN}`);
    assert.equal(sessionRequest.headers['x-molesignal-rum'], 'browser-rum/0.1.0-alpha.1');
    const [session] = JSON.parse(sessionRequest.body);
    assert.match(session.session_id, /^ses_/);
    assert.equal(session.application, 'checkout-web');
    assert.equal(session.service, 'web-frontend');
    assert.equal(session.environment, 'production');
    assert.equal(session.version, 'v1.2.3');
    assert.equal(session.user_id, 'user-42');
    assert.equal(typeof session.started_at_micros, 'number');
    assert.equal(session.view_count, 0);
    assert.equal(session.action_count, 2);
    assert.equal(session.error_count, 1);
    assert.equal(session.last_page, '/products/sku-42');

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
    assert.ok(errorEvent.error.stack.length > 0);
    assert.equal(errorEvent.platform, 'web');
    assert.equal(errorEvent.debug_id, 'checkout-build-123');
    assert.ok(
      errorEvent.error.stack.every(
        (frame) => frame.debug_id === 'checkout-build-123',
      ),
    );
    assert.equal(errorEvent.error.context.component, 'CartSummary');

    await client.stop();
  } finally {
    restoreBrowser();
  }
});

test('tracking consent gates identifiers, sessions, listeners, and uploads', async () => {
  const restoreBrowser = installBrowser();
  const sent = [];
  try {
    const client = initRum({
      applicationId: 'consent-app',
      clientToken: CLIENT_TOKEN,
      site: 'https://rum.example.test',
      trackingConsent: 'not-granted',
      trackViewsManually: true,
      trackResources: false,
      trackLongTasks: false,
      trackWebVitals: false,
      transport: transportInto(sent),
    });

    client.addAction('must not be sent');
    await client.flush();
    assert.equal(sent.length, 0);
    assert.equal(client.getInternalContext().session_id, undefined);
    assert.equal(
      localStorage.getItem('molesignal_rum_anonymous_consent-app'),
      null,
    );
    assert.equal(
      sessionStorage.getItem('molesignal_rum_session_consent-app'),
      null,
    );

    client.setTrackingConsent('granted');
    await Promise.resolve();
    client.addAction('allowed action');
    await client.flush();
    assert.ok(sent.some((request) => request.kind === 'session'));
    assert.ok(sent.some((request) => request.kind === 'action'));
    assert.match(client.getInternalContext().session_id, /^ses_/);

    client.setTrackingConsent('not-granted');
    assert.equal(client.getInternalContext().session_id, undefined);
    assert.equal(
      localStorage.getItem('molesignal_rum_anonymous_consent-app'),
      null,
    );
    assert.equal(
      sessionStorage.getItem('molesignal_rum_session_consent-app'),
      null,
    );
    await client.stop();
  } finally {
    restoreBrowser();
  }
});

test('session summaries are updated with lifecycle counters and the last page', async () => {
  const restoreBrowser = installBrowser();
  const sent = [];
  try {
    const client = initRum({
      applicationId: 'session-lifecycle',
      clientToken: CLIENT_TOKEN,
      site: 'https://rum.example.test',
      trackViewsManually: true,
      trackResources: false,
      trackLongTasks: false,
      trackWebVitals: false,
      trackUserInteractions: false,
      flushInterval: 60_000,
      transport: transportInto(sent),
    });

    await client.flush();
    window.history.pushState({}, '', '/checkout');
    client.startView('Checkout');
    client.addError(new Error('Payment failed'));
    await client.flush();

    const summaries = sent
      .filter((request) => request.kind === 'session')
      .flatMap((request) => JSON.parse(request.body));
    assert.equal(summaries.length, 2);
    const latest = summaries.at(-1);
    assert.equal(latest.view_count, 1);
    assert.equal(latest.action_count, 1);
    assert.equal(latest.error_count, 1);
    assert.equal(latest.landing_page, '/products/sku-42');
    assert.equal(latest.last_page, '/checkout');
    assert.ok(latest.duration_ms >= 0);

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
      clientToken: CLIENT_TOKEN,
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
    assert.ok(
      sent.some(
        (request) =>
          request.kind === 'action' &&
          request.url === 'https://rum.example.test/api/v1/rum/actions',
      ),
    );
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

test('allowed tracing URLs receive an automatically generated traceparent', async () => {
  const outbound = [];
  const restoreBrowser = installBrowser(async (input, init) => {
    outbound.push({ input, init });
    return new Response(null, { status: 204 });
  });
  const sent = [];
  try {
    const client = initRum({
      applicationId: 'trace-injection',
      clientToken: CLIENT_TOKEN,
      site: 'https://rum.example.test',
      allowedTracingUrls: ['https://api.example.test/'],
      trackViewsManually: true,
      trackResources: true,
      trackLongTasks: false,
      trackWebVitals: false,
      flushInterval: 60_000,
      transport: transportInto(sent),
    });

    await window.fetch('https://api.example.test/orders');
    await client.flush();

    const traceparent = new Headers(outbound[0].init.headers).get('traceparent');
    assert.match(traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const resource = sent
      .filter((request) => request.kind === 'action')
      .flatMap((request) => JSON.parse(request.body))
      .find((event) => event.type === 'resource');
    assert.equal(resource.trace_id, traceparent.split('-')[1]);
    assert.equal(resource.parent_span_id, traceparent.split('-')[2]);

    await client.stop();
  } finally {
    restoreBrowser();
  }
});

test('transport exposes queue drop and retry statistics', async () => {
  const restoreBrowser = installBrowser();
  try {
    const client = initRum({
      applicationId: 'transport-stats',
      clientToken: CLIENT_TOKEN,
      site: 'https://rum.example.test',
      trackViewsManually: true,
      trackResources: false,
      trackLongTasks: false,
      trackWebVitals: false,
      batchSize: 100,
      maxQueueSize: 20,
      flushInterval: 60_000,
      transport: {
        async send() {
          return { ok: false, status: 429, retryAfterMs: 10_000 };
        },
      },
    });

    for (let index = 0; index < 30; index += 1) {
      client.addAction(`queued-${index}`);
    }
    assert.ok(client.getTransportStats().droppedByReason.queue_full > 0);
    await client.flush();
    assert.ok(client.getTransportStats().retried > 0);
    client.setTrackingConsent('not-granted');
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
      clientToken: CLIENT_TOKEN,
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
      'https://rum.example.test/api/v1/rum/replay',
    );
    const replay = JSON.parse(replayRequest.body);
    assert.match(replay.session_id, /^ses_/);
    assert.equal(replay.seq, 1);
    assert.ok(replay.events.length >= 2);
    // The lightweight Node browser fixture cannot run rrweb itself, but the
    // correlated action timeline still shares the replay segment protocol.
    assert.ok(replay.events.some((event) => event.type === 'view'));
    assert.ok(replay.events.some((event) => event.name === 'Add to cart'));

    await client.stop();
  } finally {
    restoreBrowser();
  }
});

test('session replay retries keep the same sequence and payload', async () => {
  const restoreBrowser = installBrowser();
  const sent = [];
  let replayAttempts = 0;
  try {
    const client = initRum({
      applicationId: 'retry-replay-app',
      clientToken: CLIENT_TOKEN,
      site: 'https://rum.example.test',
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
      transport: {
        async send(request) {
          sent.push(structuredClone(request));
          if (request.kind === 'replay' && replayAttempts++ === 0) {
            return { ok: false, status: 503 };
          }
          return { ok: true, status: 200 };
        },
      },
    });

    client.addAction('Retry me');
    await client.flush();
    await client.flush();

    const attempts = sent.filter((request) => request.kind === 'replay');
    assert.equal(attempts.length, 2);
    assert.deepEqual(JSON.parse(attempts[0].body), JSON.parse(attempts[1].body));

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
