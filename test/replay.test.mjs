import assert from 'node:assert/strict';
import test from 'node:test';

import { initRum } from '../dist/index.js';
import { installBrowser, quietConfiguration, recordRequests } from './support/browser.mjs';

// rrweb needs a real DOM, so these tests replace it with a stand-in that lets
// the test emit events; the real recorder runs in the Playwright suite.
// Run with: node --experimental-test-module-mocks --test test/replay.test.mjs
const moduleMocking = typeof test.mock?.module === 'function';
const skip = moduleMocking
  ? false
  : 'module mocking is unavailable (run node with --experimental-test-module-mocks)';

function mockRrweb(t) {
  const state = { emit: undefined, started: 0, stopped: 0 };
  t.mock.module('@rrweb/record', {
    exports: {
      record(options) {
        state.emit = options.emit;
        state.started += 1;
        return () => {
          state.stopped += 1;
        };
      },
    },
  });
  return state;
}

async function until(condition, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test('sampled replay uploads ordered segments and the view says the session has a replay', { skip }, async (t) => {
  const rrweb = mockRrweb(t);
  const browser = installBrowser();
  browser.document.documentElement = {};
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({
        sessionReplaySampleRate: 100,
        replayFlushInterval: 60_000,
        beforeSend(_event, { kind }) {
          assert.notEqual(kind, 'replay', 'beforeSend only sees contract events');
        },
        transport: recorder.transport,
      }),
    );
    await until(() => rrweb.emit, 'rrweb should start recording a sampled session');

    rrweb.emit({ type: 4, data: { href: 'https://app.example.test/page?token=secret#frag' }, timestamp: 1 });
    rrweb.emit({
      type: 2,
      data: { node: { attributes: { href: 'https://cdn.example.test/a.css?sig=abc#x', class: 'kept' } } },
      timestamp: 2,
    });
    rrweb.emit({ type: 3, data: { source: 1 }, timestamp: 3 });
    await client.flush();

    const [first] = recorder.replay();
    assert.equal(recorder.requests.find((request) => request.kind === 'replay').url, 'https://rum.example.test/api/v1/rum/replay');
    assert.match(first.session_id, /^[0-9a-f-]{36}$/);
    assert.equal(first.session_id, recorder.events('view')[0].session.id);
    assert.equal(first.seq, 1);
    assert.equal(first.service, 'unit-app', 'the service is the application when none is given');
    assert.equal('env' in first, false, 'a label that is not set is left out');
    assert.equal('version' in first, false, 'a label that is not set is left out');
    assert.deepEqual(
      first.events.map((event) => event.timestamp),
      [1, 2, 3],
    );
    assert.equal(first.events[0].data.href, 'https://app.example.test/page', 'URLs keep the privacy rules');
    assert.equal(first.events[1].data.node.attributes.href, 'https://cdn.example.test/a.css');
    assert.equal(first.events[1].data.node.attributes.class, 'kept');

    assert.equal(recorder.views().at(-1).session.has_replay, true);

    rrweb.emit({ type: 3, data: { source: 2 }, timestamp: 4 });
    await client.flush();
    assert.deepEqual(
      recorder.replay().map((segment) => segment.seq),
      [1, 2],
      'segments are numbered in order',
    );

    client.stopSessionReplayRecording();
    assert.equal(rrweb.stopped, 1);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('a replay segment says the service, environment and release of its session, as the events do', { skip }, async (t) => {
  const rrweb = mockRrweb(t);
  const browser = installBrowser();
  browser.document.documentElement = {};
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({
        service: 'checkout-web',
        env: 'prod',
        version: '2.4.1',
        sessionReplaySampleRate: 100,
        replayFlushInterval: 60_000,
        transport: recorder.transport,
      }),
    );
    await until(() => rrweb.emit, 'rrweb should start recording a sampled session');

    rrweb.emit({ type: 2, data: { node: {} }, timestamp: 1 });
    await client.flush();

    const [segment] = recorder.replay();
    const [view] = recorder.events('view');

    assert.deepEqual(
      { service: segment.service, env: segment.env, version: segment.version },
      { service: 'checkout-web', env: 'prod', version: '2.4.1' },
    );
    assert.deepEqual(
      { service: view.service, env: view.env, version: view.version },
      { service: segment.service, env: segment.env, version: segment.version },
      'the server judges a segment by what the events of the session say',
    );

    await client.stop();
  } finally {
    browser.restore();
  }
});

test('a replay segment that fails is retried with the same sequence number and events', { skip }, async (t) => {
  const rrweb = mockRrweb(t);
  const browser = installBrowser();
  browser.document.documentElement = {};
  try {
    let replayAttempts = 0;
    const recorder = recordRequests(t, {
      respond: (request) =>
        request.kind === 'replay' && replayAttempts++ === 0
          ? { ok: false, status: 503 }
          : { ok: true, status: 200 },
    });
    const client = initRum(
      quietConfiguration({
        sessionReplaySampleRate: 100,
        replayFlushInterval: 60_000,
        transport: recorder.transport,
      }),
    );
    await until(() => rrweb.emit, 'rrweb should start');
    rrweb.emit({ type: 2, data: {}, timestamp: 10 });
    await client.flush();
    await client.flush();

    const attempts = recorder.requests.filter((request) => request.kind === 'replay');
    assert.equal(attempts.length, 2);
    assert.deepEqual(JSON.parse(attempts[0].body), JSON.parse(attempts[1].body));
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('replay can be started and stopped on demand and stops with the session', { skip }, async (t) => {
  const rrweb = mockRrweb(t);
  const browser = installBrowser();
  browser.document.documentElement = {};
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ sessionReplaySampleRate: 0, transport: recorder.transport }));
    await client.flush();
    assert.equal(rrweb.started, 0, 'an unsampled session is not recorded');

    client.startSessionReplayRecording();
    await until(() => rrweb.started === 1, 'a started recording runs');
    client.addAction('x');
    await client.flush();
    assert.equal(recorder.views().at(-1).session.has_replay, true);

    client.stopSession();
    assert.equal(rrweb.stopped, 1, 'the recording ends with the session');
    await client.stop();
  } finally {
    browser.restore();
  }
});
