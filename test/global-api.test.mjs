import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { molesignalRum } from '../dist/index.js';
import { installBrowser, quietConfiguration, recordRequests } from './support/browser.mjs';

// This file runs in its own process, so `molesignalRum` has not seen `init` yet.

test('calls made before init are kept and replayed by init', async (t) => {
  molesignalRum.setUser({ id: 'early-user' });
  molesignalRum.setGlobalContextProperty('release_train', 'canary');
  molesignalRum.startView('Early view');
  molesignalRum.addAction('before init');
  molesignalRum.addTiming('early_timing');
  molesignalRum.addError(new Error('early failure'), { phase: 'boot' }, { fingerprint: 'boot-failure' });
  assert.equal(molesignalRum.getUser(), undefined, 'nothing is applied before init');
  assert.deepEqual(molesignalRum.getGlobalContext(), {});
  assert.equal(molesignalRum.getRum(), undefined);
  assert.equal(molesignalRum.startDurationVital('x'), undefined, 'durations are not replayed later');
  await molesignalRum.flush();

  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = molesignalRum.init(
      quietConfiguration({ trackViewsManually: true, transport: recorder.transport }),
    );
    assert.equal(molesignalRum.getRum(), client);
    await client.flush();

    const action = recorder.events('action').find((event) => event.action.target.name === 'before init');
    assert.ok(action, 'the action made before init is sent');
    assert.equal(action.usr.id, 'early-user');
    assert.equal(action.context.release_train, 'canary');
    assert.equal(action.view.name, 'Early view');
    assert.ok('early_timing' in recorder.views().at(-1).view.custom_timings);

    const failure = recorder.events('error').find((event) => event.error.message === 'early failure');
    assert.ok(failure, 'the error made before init is sent');
    assert.equal(failure.error.fingerprint, 'boot-failure', 'with the options it was given');
    assert.equal(failure.context.phase, 'boot');
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('the browser bundle defines MoleSignalRum and runs the callbacks queued by the async snippet', () => {
  const code = readFileSync(new URL('../dist/molesignal-rum.js', import.meta.url), 'utf8');
  const order = [];
  const sandbox = {
    console,
    crypto,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextEncoder,
    Response,
    Headers,
  };
  // What the page defines before the script has loaded.
  sandbox.MoleSignalRum = {
    q: [
      () => order.push(['first', typeof sandbox.MoleSignalRum.init]),
      () => order.push(['second', typeof sandbox.MoleSignalRum.setUser]),
    ],
    onReady(callback) {
      this.q.push(callback);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  assert.deepEqual(order, [
    ['first', 'function'],
    ['second', 'function'],
  ]);
  for (const method of ['init', 'initRum', 'setUser', 'addAction', 'startView', 'flush', 'stop', 'onReady']) {
    assert.equal(typeof sandbox.MoleSignalRum[method], 'function', method);
  }
  assert.match(sandbox.MoleSignalRum.version, /^\d+\.\d+\.\d+/);

  // It is safe to use outside a browser, like the package itself.
  const client = sandbox.MoleSignalRum.init({
    applicationId: 'cdn-app',
    clientToken: 'msrum_0123456789ABCDEF_0123456789ABCDEF0123456789ABCDEF',
    site: 'https://rum.example.test',
  });
  client.addAction('server');
  assert.equal(sandbox.MoleSignalRum.getRum(), client);
  return client.stop();
});
