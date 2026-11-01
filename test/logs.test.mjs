import assert from 'node:assert/strict';
import test from 'node:test';

import { initRum } from '../dist/index.js';
import { installBrowser, quietConfiguration, recordRequests } from './support/browser.mjs';
import { contractSkipReason, contractViolations } from './support/contract.mjs';

const skip = contractSkipReason();

test('a logger writes logs into the session and view they happen in', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));

    client.logger.info('page ready', { step: 1 });
    client.createLogger({ name: 'checkout', context: { cart: 'c-1' } }).error('payment declined', { code: 402 }, new TypeError('boom'));
    await client.flush();

    const logs = recorder.events('log');
    assert.equal(logs.length, 2);

    const [info, error] = logs;
    assert.equal(info.level, 'info');
    assert.equal(info.message, 'page ready');
    assert.equal(info.log.origin, 'logger');
    assert.deepEqual(info.context, { step: 1 });
    assert.equal(info.view.id, recorder.events('view')[0].view.id);
    assert.equal(info.session.id, recorder.events('view')[0].session.id);

    assert.equal(error.level, 'error');
    assert.equal(error.log.logger, 'checkout');
    assert.equal(error.log.error_type, 'TypeError');
    assert.match(error.log.stack, /TypeError/);
    assert.deepEqual(error.context, { cart: 'c-1', code: 402 });
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('a logger leaves out what is below its level', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));
    const logger = client.createLogger({ level: 'warn' });

    logger.info('not this');
    logger.warn('this');
    logger.setLevel('error');
    logger.warn('not this either');
    logger.error('and this');
    await client.flush();

    assert.deepEqual(recorder.events('log').map((log) => log.message), ['this', 'and this']);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('the console is forwarded only when asked, and still prints', async (t) => {
  const browser = installBrowser();
  const printed = [];
  const original = console.warn;
  console.warn = (...args) => printed.push(args);
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport, forwardConsoleLogs: ['warn'] }));

    console.warn('slow', { ms: 12 });
    console.info('not forwarded');
    await client.flush();

    const logs = recorder.events('log');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'warn');
    assert.equal(logs[0].message, 'slow {"ms":12}');
    assert.equal(logs[0].log.origin, 'console');
    assert.deepEqual(printed, [['slow', { ms: 12 }]]);
    await client.stop();
    assert.equal(typeof console.warn, 'function');
  } finally {
    console.warn = original;
    browser.restore();
  }
});

test('what goes wrong in the SDK is said once as a log of the application', async (t) => {
  const browser = installBrowser();
  try {
    const seen = [];
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({
        transport: recorder.transport,
        onError: (error) => seen.push(error.message),
        beforeSend() {
          throw new Error('a bad hook');
        },
      }),
    );

    client.addAction('one');
    client.addAction('two');
    await client.flush();

    const said = recorder.events('log').filter((log) => log.log.origin === 'sdk');
    assert.equal(said.length, 1);
    assert.match(said[0].message, /beforeSend failed: a bad hook/);
    assert.ok(seen.length >= 2, 'the application is still told each time');
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('what goes wrong on the way to the server is not said as a log, which would not arrive either', async (t) => {
  const browser = installBrowser();
  try {
    const seen = [];
    const recorder = recordRequests(t, { respond: () => ({ ok: false, status: 400, body: 'bad' }) });
    const client = initRum(quietConfiguration({ transport: recorder.transport, onError: (error) => seen.push(error.message) }));

    client.addAction('one');
    await client.flush();
    await client.flush();

    assert.ok(seen.some((message) => /upload rejected: 400/.test(message)), 'the application is told');
    assert.equal(recorder.requests.length, 1, 'nothing more is sent about it');
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('logs fit the event contract', { skip }, async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));

    client.logger.warn('fine', { a: 1 }, new Error('x'));
    await client.flush();

    assert.deepEqual(contractViolations(recorder.events('log')), []);
    await client.stop();
  } finally {
    browser.restore();
  }
});
