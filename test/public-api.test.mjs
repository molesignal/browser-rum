import assert from 'node:assert/strict';
import test from 'node:test';

import { getRum, init, initRum, molesignalRum } from '../dist/index.js';
import {
  CLIENT_TOKEN,
  installBrowser,
  quietConfiguration,
  recordRequests,
} from './support/browser.mjs';

const PUBLIC_METHODS = [
  'setUser',
  'getUser',
  'setUserProperty',
  'removeUserProperty',
  'clearUser',
  'setAccount',
  'getAccount',
  'setAccountProperty',
  'removeAccountProperty',
  'clearAccount',
  'setGlobalContext',
  'setGlobalContextProperty',
  'removeGlobalContextProperty',
  'clearGlobalContext',
  'getGlobalContext',
  'addAction',
  'addError',
  'addTiming',
  'addFeatureFlagEvaluation',
  'startView',
  'setViewName',
  'setViewContext',
  'setViewContextProperty',
  'getViewContext',
  'startDurationVital',
  'stopDurationVital',
  'addDurationVital',
  'startSessionReplayRecording',
  'stopSessionReplayRecording',
  'stopSession',
  'setTrackingConsent',
  'getTrackingConsent',
  'getInternalContext',
  'getTransportStats',
  'onReady',
  'flush',
  'stop',
];

test('configuration validation and SSR imports are safe', async () => {
  const site = 'https://rum.test';
  assert.throws(
    () => initRum({ applicationId: '', clientToken: CLIENT_TOKEN, site }),
    /applicationId/,
  );
  assert.throws(
    () => initRum({ applicationId: 'has space', clientToken: CLIENT_TOKEN, site }),
    /applicationId.*A-Z a-z 0-9/,
  );
  assert.throws(
    () => initRum({ applicationId: 'app', clientToken: CLIENT_TOKEN, site: 'ftp://rum.test' }),
    /http or https/,
  );
  assert.throws(
    () => initRum({ applicationId: 'app', clientToken: 'ms_personal', site }),
    /application-bound msrum_/,
  );
  assert.throws(
    () =>
      initRum({ applicationId: 'app', clientToken: CLIENT_TOKEN, site, debugId: 'build-without-version' }),
    /version.*required/,
  );
  assert.throws(
    () => initRum({ applicationId: 'app', clientToken: CLIENT_TOKEN, site, user: {} }),
    /"id", "name", or "email"/,
  );
  assert.throws(
    () =>
      initRum({ applicationId: 'app', clientToken: CLIENT_TOKEN, site, sessionCookieDomain: 'a b' }),
    /sessionCookieDomain/,
  );

  const sent = [];
  const client = initRum({
    applicationId: 'ssr-app',
    clientToken: CLIENT_TOKEN,
    site,
    transport: { async send(request) { sent.push(request); return { ok: true, status: 200 }; } },
  });
  client.addAction('server render');
  client.startView('home');
  client.addTiming('hydrated');
  await client.flush();
  assert.equal(sent.length, 0);
  assert.equal(getRum(), client);
  assert.equal(client.getInternalContext().session_id, undefined);
  await client.stop();
});

test('the public API follows the Datadog browser SDK naming', async () => {
  for (const method of PUBLIC_METHODS) {
    assert.equal(typeof molesignalRum[method], 'function', `molesignalRum.${method}`);
  }
  assert.equal(typeof init, 'function');
  assert.equal(typeof initRum, 'function');
  assert.equal(typeof molesignalRum.init, 'function');
  assert.equal(typeof molesignalRum.initRum, 'function');
  assert.match(molesignalRum.version, /^\d+\.\d+\.\d+/);

  const browser = installBrowser();
  try {
    const client = init(quietConfiguration({ transport: recordRequests().transport }));
    for (const method of PUBLIC_METHODS) {
      assert.equal(typeof client[method], 'function', `client.${method}`);
    }
    let ready = 0;
    client.onReady(() => {
      ready += 1;
    });
    assert.equal(ready, 1);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('events carry the common attributes of the MoleSignal event contract', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({
        applicationId: 'checkout-web',
        service: 'web-frontend',
        env: 'production',
        version: 'v1.2.3',
        debugId: 'checkout-build-123',
        user: { id: 'user-42', plan: 'pro' },
        account: { id: 'acme' },
        globalContext: { region: 'eu-west-1' },
        sessionSampleRate: 100,
        sessionReplaySampleRate: 20,
        transport: recorder.transport,
      }),
    );

    client.addAction('Checkout started', { cart_size: 3, password: 'must-not-leak' });
    client.addError(new TypeError('Cannot read total'), { component: 'CartSummary' });
    await client.flush();

    assert.ok(recorder.requests.every((request) => request.url === 'https://rum.example.test/api/v1/rum/events'));
    const [request] = recorder.requests;
    assert.equal(request.headers.authorization, `Bearer ${CLIENT_TOKEN}`);
    assert.equal(request.headers['content-type'], 'application/json');
    assert.match(request.headers['x-molesignal-rum'], /^browser-rum\/\d/);

    const action = recorder.events('action')[0];
    assert.equal(action.source, 'browser');
    assert.deepEqual(action.application, { id: 'checkout-web' });
    assert.equal(action.service, 'web-frontend');
    assert.equal(action.env, 'production');
    assert.equal(action.version, 'v1.2.3');
    assert.match(action.session.id, /^[0-9a-f-]{36}$/);
    assert.equal(action.session.type, 'user');
    assert.match(action.tab.id, /^[0-9a-f-]{36}$/);
    assert.equal(action.view.url, 'https://app.example.test/products/sku-42');
    assert.equal(action.view.name, '/products/sku-42');
    assert.equal(action.view.in_foreground, true);
    assert.deepEqual(action.usr, { id: 'user-42', plan: 'pro' });
    assert.deepEqual(action.account, { id: 'acme' });
    assert.equal(action.sdk.name, 'molesignal-browser-rum');
    assert.equal(action.sdk.version, '0.2.0');
    assert.equal(action.sdk.session_sample_rate, 100);
    assert.equal(action.sdk.replay_sample_rate, 20);
    assert.equal(action.display.viewport.width, 1440);
    assert.equal(action.connectivity.status, 'connected');
    assert.equal(action.device.locale, 'en-US');
    assert.equal(action.context.region, 'eu-west-1');
    assert.equal(action.context.cart_size, 3);
    assert.equal(action.context.password, '[Redacted]');
    assert.equal(action.action.type, 'custom');
    assert.equal(action.action.target.name, 'Checkout started');
    assert.ok(Number.isInteger(action.date));

    const error = recorder.events('error')[0];
    assert.equal(error.error.type, 'TypeError');
    assert.equal(error.error.message, 'Cannot read total');
    assert.equal(error.error.source, 'custom');
    assert.equal(error.error.handling, 'handled');
    assert.equal('fingerprint' in error.error, false, 'the SDK sets no fingerprint of its own');
    assert.match(error.error.stack, /^TypeError: Cannot read total\n {4}at /);
    assert.ok(error.error.frames.length > 0);
    assert.ok(error.error.frames.every((frame) => frame.debug_id === 'checkout-build-123'));
    assert.ok(error.error.frames.every((frame) => typeof frame.line === 'number'));
    assert.equal(error.context.component, 'CartSummary');
    assert.equal(error.error.source_type, 'browser');

    const internal = client.getInternalContext();
    assert.equal(internal.application_id, 'checkout-web');
    assert.equal(internal.session_id, action.session.id);
    assert.equal(internal.user_id, 'user-42');
    assert.equal(internal.tab_id, action.tab.id);
    assert.equal(internal.view.id, action.view.id);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('identity and context setters change what later events carry', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));

    client.setUser({ id: 'u-1', name: 'Ada', email: 'ada@example.com' });
    client.setUserProperty('plan', 'pro');
    client.setAccount({ id: 'acme', name: 'Acme' });
    client.setAccountProperty('tier', 'gold');
    client.setGlobalContext({ a: 1 });
    client.setGlobalContextProperty('b', 2);
    client.addAction('first');
    client.removeUserProperty('plan');
    client.removeGlobalContextProperty('a');
    client.addAction('second');
    client.clearUser();
    client.clearAccount();
    client.clearGlobalContext();
    client.addAction('third');
    await client.flush();

    const [first, second, third] = recorder.events('action');
    assert.deepEqual(first.usr, { id: 'u-1', name: 'Ada', email: 'ada@example.com', plan: 'pro' });
    assert.deepEqual(first.account, { id: 'acme', name: 'Acme', tier: 'gold' });
    assert.deepEqual(first.context, { a: 1, b: 2 });
    assert.equal(second.usr.plan, undefined);
    assert.deepEqual(second.context, { b: 2 });
    assert.equal(third.usr, undefined);
    assert.equal(third.account, undefined);
    assert.equal(third.context, undefined);
    assert.equal(client.getUser(), undefined);
    assert.throws(() => client.setUser({}), /at least one/);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('tracking consent gates identifiers, sessions, listeners, and uploads', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({
        applicationId: 'consent-app',
        trackingConsent: 'not-granted',
        trackAnonymousUser: true,
        transport: recorder.transport,
      }),
    );

    client.addAction('must not be sent');
    await client.flush();
    assert.equal(recorder.requests.length, 0);
    assert.equal(client.getInternalContext().session_id, undefined);
    assert.equal(browser.localStorage.getItem('molesignal_rum_anonymous_consent-app'), null);
    assert.equal(browser.sessionStorage.length, 0);
    assert.deepEqual(browser.cookies.names(), []);
    assert.equal(browser.windowListeners('pagehide'), 0);

    client.setTrackingConsent('granted');
    await Promise.resolve();
    client.addAction('allowed action');
    await client.flush();
    assert.ok(recorder.events('view').length > 0);
    assert.ok(recorder.events('action').some((event) => event.action.target.name === 'allowed action'));
    assert.match(client.getInternalContext().session_id, /^[0-9a-f-]{36}$/);
    assert.ok(browser.cookies.names().some((name) => name.startsWith('_msrum_s_consent-app')));
    assert.ok(browser.localStorage.getItem('molesignal_rum_anonymous_consent-app'));
    assert.ok(recorder.events('action')[0].usr.anonymous_id);

    client.setTrackingConsent('not-granted');
    assert.equal(client.getInternalContext().session_id, undefined);
    assert.equal(browser.localStorage.getItem('molesignal_rum_anonymous_consent-app'), null);
    assert.equal(browser.sessionStorage.length, 0);
    assert.deepEqual(browser.cookies.names(), []);
    assert.equal(browser.windowListeners('pagehide'), 0);

    const before = recorder.requests.length;
    client.addAction('revoked');
    await client.flush();
    assert.equal(recorder.requests.length, before);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('fetch becomes a resource event with W3C trace context', async (t) => {
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const parentSpanId = '00f067aa0ba902b7';
  const browser = installBrowser({
    fetch: async () =>
      new Response('{}', {
        status: 200,
        headers: { traceparent: `00-${traceId}-${parentSpanId}-01` },
      }),
  });
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({
        applicationId: 'shop',
        site: 'https://rum.example.test/api/v1',
        trackResources: true,
        transport: recorder.transport,
      }),
    );

    await window.fetch('https://app.example.test/api/orders?token=secret', {
      method: 'post',
      headers: { traceparent: `00-${traceId}-1111111111111111-01` },
    });
    await client.flush();

    assert.ok(recorder.requests.every((request) => request.url === 'https://rum.example.test/api/v1/rum/events'));
    const resource = recorder.events('resource')[0];
    assert.equal(resource.resource.type, 'fetch');
    assert.equal(resource.resource.method, 'POST');
    assert.equal(resource.resource.url, 'https://app.example.test/api/orders');
    assert.equal(resource.resource.status_code, 200);
    assert.equal(resource.resource.trace_id, traceId);
    assert.equal(resource.resource.span_id, parentSpanId);
    assert.ok(Number.isInteger(resource.resource.duration));
    assert.match(resource.resource.id, /^[0-9a-f-]{36}$/);
    assert.equal(recorder.events('error').length, 0);

    const view = recorder.views()[0];
    assert.equal(view.view.resource.count, 1);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('allowed tracing URLs receive an automatically generated traceparent', async (t) => {
  const outbound = [];
  const browser = installBrowser({
    fetch: async (input, init) => {
      outbound.push({ input, init });
      return new Response(null, { status: 204 });
    },
  });
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({
        allowedTracingUrls: ['https://api.example.test/'],
        trackResources: true,
        transport: recorder.transport,
      }),
    );

    await window.fetch('https://api.example.test/orders');
    await window.fetch('https://elsewhere.example.test/orders');
    await client.flush();

    const traceparent = new Headers(outbound[0].init.headers).get('traceparent');
    assert.match(traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    assert.equal(outbound[1].init, undefined, 'URLs outside allowedTracingUrls are left alone');
    const resources = recorder.events('resource');
    const traced = resources.find((event) => event.resource.url === 'https://api.example.test/orders');
    assert.equal(traced.resource.trace_id, traceparent.split('-')[1]);
    assert.equal(traced.resource.span_id, traceparent.split('-')[2]);
    assert.equal(
      resources.find((event) => event.resource.url === 'https://elsewhere.example.test/orders').resource.trace_id,
      undefined,
    );
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('failed requests also produce a network error with the request that failed', async (t) => {
  const browser = installBrowser({
    fetch: async (input) => {
      const url = String(input);
      if (url.includes('/offline')) throw new TypeError('Failed to fetch');
      if (url.includes('/cancelled')) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return new Response('boom', { status: url.includes('/missing') ? 404 : 500 });
    },
  });
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({ trackResources: true, transport: recorder.transport }),
    );

    await assert.rejects(window.fetch('https://api.example.test/offline'), TypeError);
    await assert.rejects(window.fetch('https://api.example.test/cancelled'), /aborted/);
    await window.fetch('https://api.example.test/orders/17');
    await window.fetch('https://api.example.test/orders/18');
    await client.flush();

    const errors = recorder.events('error');
    assert.equal(errors.length, 3, 'an aborted request is not an error');
    const offline = errors.find((event) => event.error.resource.url.endsWith('/offline'));
    assert.equal(offline.error.source, 'network');
    assert.equal(offline.error.type, 'TypeError');
    assert.equal(offline.error.message, 'Failed to fetch https://api.example.test/offline');
    assert.deepEqual(offline.error.resource, {
      method: 'GET',
      status_code: 0,
      url: 'https://api.example.test/offline',
    });
    assert.equal(offline.error.handling, 'handled');

    const http = errors.filter((event) => event.error.resource.status_code === 500);
    assert.equal(http.length, 2);
    assert.equal(http[0].error.type, 'HTTPError');
    assert.match(http[0].error.message, /^GET https:\/\/api\.example\.test\/orders\/17 failed with status 500/);
    assert.deepEqual(
      errors.filter((event) => 'fingerprint' in event.error),
      [],
      'the server groups failed requests: the SDK sets no fingerprint',
    );

    const resources = recorder.events('resource');
    assert.equal(resources.length, 4, 'every request is a resource, including the aborted one');
    assert.equal(
      resources.find((event) => event.resource.url.endsWith('/cancelled')).resource.status_code,
      0,
    );
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('error.fingerprint is only what the developer chose, and is sent as given', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({
        beforeSend(event) {
          if (event.type === 'error' && event.error.message === 'grouped in beforeSend') {
            event.error.fingerprint = 'set-in-beforeSend';
          }
        },
        transport: recorder.transport,
      }),
    );

    client.addError(new Error('no fingerprint given'));
    client.addError(new Error('declined by the bank'), { step: 'pay' }, { fingerprint: 'payment-declined' });
    client.addError(new Error('timed out at the bank'), undefined, { fingerprint: 'payment-declined' });
    client.addError(new Error('fingerprint too long'), undefined, { fingerprint: 'f'.repeat(200) });
    client.addError(new Error('fingerprint blank'), undefined, { fingerprint: '   ' });
    client.addError(new Error('fingerprint empty'), undefined, { fingerprint: '' });
    client.addError(new Error('fingerprint not a string'), undefined, { fingerprint: 42 });
    client.addError(new Error('grouped in beforeSend'));
    browser.dispatchWindow('unhandledrejection', { reason: new RangeError('nobody caught this') });
    await client.flush();

    const sent = new Map(
      recorder.events('error').map((event) => [event.error.message, event.error.fingerprint]),
    );
    assert.deepEqual(Object.fromEntries(sent), {
      'no fingerprint given': undefined,
      'declined by the bank': 'payment-declined',
      'timed out at the bank': 'payment-declined',
      'fingerprint too long': 'f'.repeat(128),
      'fingerprint blank': undefined,
      'fingerprint empty': undefined,
      'fingerprint not a string': undefined,
      'grouped in beforeSend': 'set-in-beforeSend',
      'nobody caught this': undefined,
    });
    assert.deepEqual(
      recorder
        .events('error')
        .filter((event) => 'fingerprint' in event.error)
        .map((event) => event.error.message)
        .sort(),
      [
        'declined by the bank',
        'fingerprint too long',
        'grouped in beforeSend',
        'timed out at the bank',
      ],
      'an error without a fingerprint carries no fingerprint field at all',
    );
    assert.equal(
      recorder.events('error').find((event) => event.error.message === 'declined by the bank').context.step,
      'pay',
      'the fingerprint option does not displace the context',
    );
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('excludedUrls are not tracked and SDK endpoints never are', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({
        trackResources: true,
        excludedUrls: [/\/health$/, 'https://static.example.test/'],
        transport: recorder.transport,
      }),
    );

    await window.fetch('https://api.example.test/health');
    await window.fetch('https://static.example.test/logo.png');
    await window.fetch('https://rum.example.test/api/v1/rum/events');
    await window.fetch('https://api.example.test/orders');
    await client.flush();

    assert.deepEqual(
      recorder.events('resource').map((event) => event.resource.url),
      ['https://api.example.test/orders'],
    );
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('beforeSend modifies or drops events but cannot drop views', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const seen = [];
    const mismatches = [];
    const client = initRum(
      quietConfiguration({
        beforeSend(event, { kind }) {
          seen.push(kind);
          if (kind !== event.type) mismatches.push([kind, event.type]);
          if (event.type === 'view') return false;
          if (event.type === 'action' && event.action.target.name === 'secret') return false;
          if (event.type === 'action') event.context = { ...event.context, reviewed: true };
          return true;
        },
        transport: recorder.transport,
      }),
    );

    client.addAction('kept');
    client.addAction('secret');
    await client.flush();

    assert.ok(seen.includes('view') && seen.includes('action'));
    assert.deepEqual(mismatches, []);
    assert.deepEqual(
      recorder.events('action').map((event) => event.action.target.name),
      ['kept'],
    );
    assert.equal(recorder.events('action')[0].context.reviewed, true);
    assert.ok(recorder.events('view').length > 0, 'a view is sent even when beforeSend returns false');
    assert.equal(recorder.views()[0].view.action.count, 1, 'dropped events are not counted');
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('beforeSend failures are reported and do not lose the event', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const problems = [];
    const client = initRum(
      quietConfiguration({
        beforeSend() {
          throw new Error('broken hook');
        },
        onError: (error) => problems.push(error.message),
        transport: recorder.transport,
      }),
    );
    client.addAction('still sent');
    await client.flush();
    assert.ok(problems.some((message) => /beforeSend failed: broken hook/.test(message)));
    assert.equal(recorder.events('action').length, 1);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('site normalization lands on /api/v1/rum/events and /api/v1/rum/replay', async () => {
  const browser = installBrowser();
  try {
    const sites = {
      'https://rum.example.test': 'https://rum.example.test/api/v1/rum/events',
      'https://rum.example.test/': 'https://rum.example.test/api/v1/rum/events',
      'https://rum.example.test/api': 'https://rum.example.test/api/v1/rum/events',
      'https://rum.example.test/api/v1': 'https://rum.example.test/api/v1/rum/events',
      'https://rum.example.test/api/v1/rum': 'https://rum.example.test/api/v1/rum/events',
      'https://example.test/molesignal': 'https://example.test/molesignal/api/v1/rum/events',
    };
    for (const [site, expected] of Object.entries(sites)) {
      const recorder = recordRequests();
      const client = initRum(quietConfiguration({ site, transport: recorder.transport }));
      await client.flush();
      assert.equal(recorder.requests[0]?.url, expected, site);
      await client.stop();
    }
  } finally {
    browser.restore();
  }
});

test('sessionSampleRate decides per session and unsampled sessions send nothing', async (t) => {
  const browser = installBrowser();
  const originalRandom = Math.random;
  try {
    const recorder = recordRequests(t);
    Math.random = () => 0.99;
    const client = initRum(
      quietConfiguration({ applicationId: 'sampled', sessionSampleRate: 50, transport: recorder.transport }),
    );
    client.addAction('not sampled');
    client.addError(new Error('not sampled'));
    await client.flush();
    assert.equal(recorder.requests.length, 0);
    assert.equal(client.getInternalContext().session_id, undefined);
    assert.match(browser.cookies.get('_msrum_s_sampled'), /tracked=0/);
    await client.stop();

    // The decision is stored with the session: the next page load keeps it.
    Math.random = () => 0;
    const again = initRum(
      quietConfiguration({ applicationId: 'sampled', sessionSampleRate: 50, transport: recorder.transport }),
    );
    again.addAction('same session');
    await again.flush();
    assert.equal(recorder.requests.length, 0);
    await again.stop();

    // sessionSampleRate 0 never creates a session at all.
    browser.cookies.clear();
    const none = initRum(
      quietConfiguration({ applicationId: 'none', sessionSampleRate: 0, transport: recorder.transport }),
    );
    none.addAction('nothing');
    await none.flush();
    assert.equal(recorder.requests.length, 0);
    assert.deepEqual(browser.cookies.names(), []);
    await none.stop();
  } finally {
    Math.random = originalRandom;
    browser.restore();
  }
});

test('the queue retries network errors, 5xx and 429, but not rejected requests', async (t) => {
  const browser = installBrowser();
  try {
    const attempts = [];
    const statuses = [503, 429, 200];
    const recorder = recordRequests(t, {
      respond: (request) => {
        attempts.push(request.kind);
        const status = statuses.shift() ?? 200;
        return status === 200
          ? { ok: true, status }
          : { ok: false, status, retryAfterMs: status === 429 ? 10 : undefined };
      },
    });
    const problems = [];
    const client = initRum(
      quietConfiguration({
        retryBaseDelay: 250,
        onError: (error) => problems.push(error.message),
        transport: recorder.transport,
      }),
    );
    client.addAction('retry me');
    await client.flush();
    assert.equal(client.getTransportStats().retried > 0, true);
    assert.equal(client.getTransportStats().queued > 0, true);
    await client.flush();
    await client.flush();
    assert.equal(client.getTransportStats().queued, 0);
    assert.ok(client.getTransportStats().sent >= 2);
    assert.equal(attempts.length, 3);
    assert.ok(problems.some((message) => /upload rejected: 503/.test(message)));

    // A 4xx is final.
    const rejecting = recordRequests(t, { respond: () => ({ ok: false, status: 400, body: 'bad' }) });
    const second = initRum(quietConfiguration({ transport: rejecting.transport }));
    second.addAction('dropped');
    await second.flush();
    await second.flush();
    assert.equal(rejecting.requests.length, 1);
    assert.equal(second.getTransportStats().droppedByReason.rejected > 0, true);
    assert.equal(second.getTransportStats().queued, 0);
    await second.stop();
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('events the server rejects are reported through onError and never retried', async (t) => {
  const browser = installBrowser();
  try {
    const problems = [];
    const recorder = recordRequests(t, {
      respond: (_request, events) => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          accepted: events.length - 1,
          rejected: [{ index: events.findIndex((event) => event.type === 'action'), reason: 'bad action' }],
        }),
      }),
    });
    const client = initRum(
      quietConfiguration({ onError: (error) => problems.push(error.message), transport: recorder.transport }),
    );
    client.addAction('refused');
    await client.flush();
    await client.flush();

    const stats = client.getTransportStats();
    assert.equal(stats.droppedByReason.rejected, 1);
    assert.equal(stats.retried, 0);
    assert.equal(stats.queued, 0);
    assert.ok(problems.some((message) => /events rejected.*1 of \d+ events were refused: #\d+ bad action/.test(message)));
    assert.equal(recorder.events('action').length, 1, 'the refused action is not sent again');
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('transport exposes queue drop and retry statistics', async () => {
  const browser = installBrowser();
  try {
    const client = initRum(
      quietConfiguration({
        applicationId: 'transport-stats',
        batchSize: 100,
        maxQueueSize: 20,
        transport: {
          async send() {
            return { ok: false, status: 429, retryAfterMs: 10_000 };
          },
        },
      }),
    );

    for (let index = 0; index < 30; index += 1) {
      client.addAction(`queued-${index}`);
    }
    assert.ok(client.getTransportStats().droppedByReason.queue_full > 0);
    assert.ok(client.getTransportStats().queued <= 20);
    await client.flush();
    assert.ok(client.getTransportStats().retried > 0);
    client.setTrackingConsent('not-granted');
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('when the queue is full the least important events go first', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({ maxQueueSize: 20, batchSize: 100, trackResources: true, transport: recorder.transport }),
    );
    client.addError(new Error('keep me'));
    for (let index = 0; index < 40; index += 1) {
      await window.fetch(`https://api.example.test/resource-${index}`);
    }
    await client.flush();
    assert.equal(recorder.events('error').length, 1, 'the error survives');
    assert.equal(recorder.views().length, 1, 'the view survives');
    assert.ok(recorder.events('resource').length < 40);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('an explicit flush also sends what was queued while another flush was running', async (t) => {
  const browser = installBrowser();
  try {
    const delivered = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let first = true;
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({
        transport: {
          async send(request) {
            if (first) {
              first = false;
              await gate;
            }
            for (const event of JSON.parse(request.body)) delivered.push(event);
            return recorder.transport.send(request);
          },
        },
      }),
    );

    client.addAction('a');
    const running = client.flush();
    client.addAction('b');
    const requested = client.flush();
    release();
    await requested;
    await running;

    const names = delivered.filter((event) => event.type === 'action').map((event) => event.action.target.name);
    assert.deepEqual(names.sort(), ['a', 'b']);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('batches stay within the request limits and keep every event', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({ maxQueueSize: 10_000, batchSize: 100, transport: recorder.transport }),
    );
    const padding = 'x'.repeat(3_000);
    for (let index = 0; index < 400; index += 1) {
      client.addAction(`bulk-${index}`, { padding });
    }
    await client.flush();

    const eventRequests = recorder.requests.filter((request) => request.kind === 'events');
    assert.ok(eventRequests.length > 2, 'the events do not fit in one request');
    for (const request of eventRequests) {
      assert.ok(JSON.parse(request.body).length <= 100, 'at most batchSize events');
      assert.ok(new TextEncoder().encode(request.body).length <= 512 * 1024, 'at most 512 KiB');
    }
    const names = recorder.events('action').map((event) => event.action.target.name);
    assert.equal(names.length, 400);
    assert.deepEqual(names, Array.from({ length: 400 }, (_, index) => `bulk-${index}`), 'in order');
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('an event too large to send is dropped and reported', async (t) => {
  const browser = installBrowser();
  try {
    const problems = [];
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({ onError: (error) => problems.push(error.message), transport: recorder.transport }),
    );
    // sanitizeContext keeps 100 keys of up to 4096 characters: 1.2 MiB with these.
    const context = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`key${index}`, 'y'.repeat(4_096) + index]),
    );
    const huge = Object.fromEntries(
      Array.from({ length: 4 }, (_, outer) => [`group${outer}`, context]),
    );
    client.addAction('too big', huge);
    client.addAction('small');
    await client.flush();
    assert.deepEqual(
      recorder.events('action').map((event) => event.action.target.name),
      ['small'],
    );
    assert.equal(client.getTransportStats().droppedByReason.payload_too_large, 1);
    assert.ok(problems.some((message) => /queue payload_too_large/.test(message)));
    await client.stop();
  } finally {
    browser.restore();
  }
});
