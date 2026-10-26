import assert from 'node:assert/strict';
import test from 'node:test';

import { initRum } from '../dist/index.js';
import { installBrowser, quietConfiguration, recordRequests } from './support/browser.mjs';

test('a view is re-reported with a higher revision and cumulative counts, and its date never changes', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));

    await client.flush();
    client.addAction('one');
    await client.flush();
    client.addAction('two');
    client.addError(new Error('boom'));
    await client.flush();
    await client.flush();

    const revisions = recorder.events('view');
    assert.deepEqual(
      revisions.map((event) => event.view.revision),
      [1, 2, 3],
      'a view that did not change is not reported again',
    );
    assert.deepEqual(
      revisions.map((event) => [event.view.action.count, event.view.error.count]),
      [
        [0, 0],
        [1, 0],
        [2, 1],
      ],
    );
    assert.equal(new Set(revisions.map((event) => event.date)).size, 1, 'date is the start of the view');
    assert.equal(new Set(revisions.map((event) => event.view.id)).size, 1);
    assert.ok(revisions.every((event) => event.view.is_active === true));
    assert.ok(revisions.every((event) => event.view.loading_type === 'initial_load'));
    assert.ok(revisions.every((event) => Number.isInteger(event.view.time_spent)));
    const spent = revisions.map((event) => event.view.time_spent);
    assert.deepEqual(spent, [...spent].sort((a, b) => a - b));
    for (const key of ['action', 'error', 'resource', 'long_task', 'frustration']) {
      assert.equal(typeof revisions.at(-1).view[key].count, 'number', key);
    }
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('view updates are throttled to one every three seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_760_000_000_000 });
  const browser = installBrowser();
  try {
    const revisions = [];
    const client = initRum(
      quietConfiguration({
        beforeSend(event) {
          if (event.type === 'view') revisions.push([event.view.revision, event.view.action.count]);
        },
        transport: recordRequests(t).transport,
      }),
    );
    assert.deepEqual(revisions, [[1, 0]], 'a view is reported as soon as it starts');

    client.addAction('a');
    client.addAction('b');
    client.addAction('c');
    t.mock.timers.tick(2_900);
    assert.equal(revisions.length, 1, 'changes inside the window wait for it to end');
    t.mock.timers.tick(200);
    assert.deepEqual(revisions.at(-1), [2, 3], 'the trailing update carries every change');

    t.mock.timers.tick(10_000);
    client.addAction('d');
    assert.deepEqual(revisions.at(-1), [3, 4], 'after a quiet period the next change goes out at once');
    client.addAction('e');
    t.mock.timers.tick(3_000);
    assert.deepEqual(revisions.at(-1), [4, 5]);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('an idle view is reported every five minutes while it is visible', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_760_000_000_000 });
  const browser = installBrowser();
  try {
    const revisions = [];
    const client = initRum(
      quietConfiguration({
        beforeSend(event) {
          if (event.type === 'view') revisions.push(event.view.revision);
        },
        transport: recordRequests(t).transport,
      }),
    );
    // Activity keeps the session alive; the view itself has nothing new to say.
    const tick = () => {
      t.mock.timers.tick(60_000);
      browser.dispatchWindow('click');
    };
    for (let minute = 0; minute < 4; minute += 1) tick();
    const beforeKeepAlive = revisions.at(-1);
    tick();
    assert.equal(revisions.at(-1), beforeKeepAlive + 1, 'a keep-alive revision after five minutes');
    for (let minute = 0; minute < 4; minute += 1) tick();
    assert.equal(revisions.at(-1), beforeKeepAlive + 1, 'and not before the next five minutes');
    tick();
    assert.equal(revisions.at(-1), beforeKeepAlive + 2);
    browser.setVisibility('hidden');
    const afterHide = revisions.length;
    for (let minute = 0; minute < 5; minute += 1) {
      t.mock.timers.tick(60_000);
    }
    assert.equal(revisions.length, afterHide, 'a hidden view is not reported again');
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('hiding the page reports the final revision at once, with keepalive', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));
    client.addAction('before leaving');
    await client.flush();
    recorder.requests.length = 0;

    client.addError(new Error('last words'));
    browser.setVisibility('hidden');
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(recorder.requests.length >= 1);
    assert.equal(recorder.requests[0].keepalive, true, 'the final request survives the page');
    const latest = recorder.views().at(-1);
    assert.equal(latest.view.is_active, false);
    assert.equal(latest.view.error.count, 1);
    assert.equal(latest.view.revision, 3);

    // The most important events go first when the page is going away.
    assert.equal(JSON.parse(recorder.requests[0].body)[0].type, 'view');

    browser.setVisibility('visible');
    await client.flush();
    assert.equal(recorder.views().at(-1).view.is_active, true, 'coming back makes the view active again');
    await client.stop();
    assert.equal(recorder.views().at(-1).view.is_active, false, 'stop reports the last revision');

    browser.dispatchWindow('pagehide', { persisted: false });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    browser.restore();
  }
});

test('navigating ends the view and starts a new one', async (t) => {
  const browser = installBrowser({ url: 'https://app.example.test/products/sku-42' });
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));
    client.addAction('on product');

    browser.navigate('/checkout?step=1');
    client.addAction('on checkout');
    browser.navigate('/checkout?step=2');
    browser.navigate('/checkout#/payment');
    browser.navigate('/checkout#/payment?card=1');
    await client.flush();

    const views = recorder.views().sort((a, b) => a.date - b.date);
    assert.deepEqual(
      views.map((event) => [event.view.name, event.view.loading_type, event.view.is_active]),
      [
        ['/products/sku-42', 'initial_load', false],
        ['/checkout', 'route_change', false],
        ['/checkout#/payment', 'route_change', true],
      ],
      'a query change is not a new view, a route-style hash is',
    );
    assert.equal(views[1].view.referrer, 'https://app.example.test/products/sku-42');
    assert.equal(views[2].view.referrer, 'https://app.example.test/checkout');
    assert.equal(views[1].view.url, 'https://app.example.test/checkout', 'query strings are removed');
    assert.equal(views[2].view.url, 'https://app.example.test/checkout#/payment');
    assert.equal(views[0].view.action.count, 1);
    assert.equal(views[1].view.action.count, 1);

    const second = recorder.events('action').find((event) => event.action.target.name === 'on checkout');
    assert.equal(second.view.id, views[1].view.id, 'events belong to the view they happened in');
    assert.equal(new Set(views.map((event) => event.session.id)).size, 1);
    assert.ok(views[1].date >= views[0].date);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('startView, view names and contexts, timings and feature flags', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({ trackViewsManually: true, transport: recorder.transport, globalContext: { g: 1 } }),
    );

    client.startView('Cart', { step: 'cart' });
    client.setViewContextProperty('flow', 'a');
    client.addFeatureFlagEvaluation('new_checkout', true);
    client.addFeatureFlagEvaluation('discount', { pct: 10, password: 'x' });
    client.addTiming('cart_ready');
    client.addTiming('hero visible!', performance.now() - 50);
    client.addTiming('from_epoch', Date.now() - 20);
    for (let index = 0; index < 60; index += 1) client.addTiming(`extra_${index}`);
    client.addAction('in cart', { local: true });
    assert.deepEqual(client.getViewContext(), { step: 'cart', flow: 'a' });
    await client.flush();

    const view = recorder.views().at(-1);
    assert.equal(view.view.name, 'Cart');
    assert.equal(view.view.loading_type, 'initial_load', 'the first view of a manual page is the page load');
    assert.deepEqual(view.feature_flags, { new_checkout: true, discount: { pct: 10, password: '[Redacted]' } });
    assert.equal(Object.keys(view.view.custom_timings).length, 50);
    assert.ok(view.view.custom_timings.cart_ready >= 0);
    assert.ok(view.view.custom_timings.hero_visible_ >= 0);
    const earlier = view.view.custom_timings.cart_ready - view.view.custom_timings.from_epoch;
    assert.ok(earlier > 5_000_000 && earlier < 40_000_000, 'an epoch time is taken relative to the view');
    assert.ok(Object.values(view.view.custom_timings).every(Number.isInteger));
    const action = recorder.events('action')[0];
    assert.deepEqual(action.context, { g: 1, step: 'cart', flow: 'a', local: true });
    assert.deepEqual(action.feature_flags, view.feature_flags);

    client.setViewName('Cart (renamed)');
    client.setViewContext({ only: 'this' });
    client.startView({ name: 'Pay', service: 'payments', version: '9.9.9', context: { gateway: 'x' } });
    client.addAction('paying');
    client.setViewName('Pay (renamed)');
    await client.flush();

    const renamed = recorder.views().find((event) => event.view.name === 'Cart (renamed)');
    assert.ok(renamed, 'the previous view keeps the name it was given');
    const pay = recorder.views().find((event) => event.view.name === 'Pay (renamed)');
    assert.equal(pay.view.loading_type, 'route_change');
    assert.equal(pay.service, 'payments');
    assert.equal(pay.version, '9.9.9');
    assert.equal(pay.feature_flags, undefined, 'feature flags belong to one view');
    const paying = recorder.events('action').find((event) => event.action.target.name === 'paying');
    assert.equal(paying.service, 'payments');
    assert.deepEqual(paying.context, { g: 1, gateway: 'x' });
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('with manual views, events before the first startView get an implicit page-load view', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ trackViewsManually: true, transport: recorder.transport }));
    await client.flush();
    assert.equal(recorder.events('view').length, 0, 'nothing is reported until something happens');

    client.addAction('early');
    browser.navigate('/elsewhere');
    await client.flush();
    assert.equal(recorder.views().length, 1, 'no automatic route tracking');
    assert.equal(recorder.views()[0].view.loading_type, 'initial_load');
    assert.equal(recorder.views()[0].view.name, '/products/sku-42');
    const origin = Math.round(performance.timeOrigin);
    assert.equal(recorder.views()[0].date, origin, 'the page-load view starts when the page does');

    client.startView('Elsewhere');
    await client.flush();
    assert.deepEqual(
      recorder.views().sort((a, b) => a.date - b.date).map((event) => event.view.loading_type),
      ['initial_load', 'route_change'],
    );
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('custom duration vitals', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));

    const first = client.startDurationVital('checkout_form', { context: { step: 1 }, description: 'form ready' });
    const second = client.startDurationVital('checkout_form');
    assert.notEqual(first.id, second.id);
    assert.equal(first.name, 'checkout_form');
    await new Promise((resolve) => setTimeout(resolve, 15));
    client.stopDurationVital(first, { context: { outcome: 'ok' } });
    client.stopDurationVital('checkout_form');
    client.stopDurationVital('checkout_form');
    client.stopDurationVital('never_started');

    const start = Date.now() - 500;
    client.addDurationVital('manual_epoch', { startTime: start, duration: 250 });
    client.addDurationVital('manual_relative', {
      startTime: performance.now() - 100,
      duration: 40,
      description: 'd',
      context: { k: 'v' },
    });
    client.addDurationVital('   ', { startTime: 1, duration: 1 });
    await client.flush();

    const vitals = recorder.events('vital');
    assert.equal(vitals.length, 4);
    const named = vitals.filter((event) => event.vital.name === 'checkout_form');
    assert.equal(named.length, 2);
    const stoppedFirst = named.find((event) => event.vital.id !== undefined && event.context?.outcome);
    assert.equal(stoppedFirst.vital.type, 'duration');
    assert.equal(stoppedFirst.vital.description, 'form ready');
    assert.deepEqual(stoppedFirst.context, { step: 1, outcome: 'ok' });
    assert.ok(Number.isInteger(stoppedFirst.vital.duration));
    assert.ok(stoppedFirst.vital.duration >= 10_000_000, 'durations are nanoseconds');
    assert.ok(stoppedFirst.date <= Date.now());

    const epoch = vitals.find((event) => event.vital.name === 'manual_epoch');
    assert.equal(epoch.vital.duration, 250_000_000);
    assert.ok(Math.abs(epoch.date - start) <= 5);
    const relative = vitals.find((event) => event.vital.name === 'manual_relative');
    assert.equal(relative.vital.duration, 40_000_000);
    assert.equal(relative.vital.description, 'd');
    assert.deepEqual(relative.context, { k: 'v' });
    assert.ok(Math.abs(relative.date - (Date.now() - 100)) < 100);
    assert.equal(recorder.views().at(-1).view.action.count, 0, 'vitals are not actions');
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('a page restored from the back/forward cache starts a bf_cache view when asked to', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ trackBfcacheViews: true, transport: recorder.transport }));
    client.addAction('before leaving');
    browser.setVisibility('hidden');
    browser.dispatchWindow('pagehide', { persisted: true });
    await client.flush();
    assert.equal(recorder.views().length, 1);
    assert.equal(recorder.views()[0].view.is_active, false);

    browser.setVisibility('visible');
    browser.dispatchWindow('pageshow', { persisted: true });
    client.addAction('after coming back');
    await client.flush();

    const views = recorder.views().sort((a, b) => a.date - b.date);
    assert.deepEqual(views.map((event) => event.view.loading_type), ['initial_load', 'bf_cache']);
    assert.equal(views[1].view.referrer, views[0].view.url);
    assert.equal(views[1].view.is_active, true);
    assert.equal(views[0].session.id, views[1].session.id);
    const action = recorder.events('action').find((event) => event.action.target.name === 'after coming back');
    assert.equal(action.view.id, views[1].view.id);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('without trackBfcacheViews the restored page continues its view', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));
    client.addAction('before leaving');
    browser.setVisibility('hidden');
    browser.setVisibility('visible');
    browser.dispatchWindow('pageshow', { persisted: true });
    client.addAction('after coming back');
    await client.flush();
    assert.equal(recorder.views().length, 1);
    assert.equal(recorder.views()[0].view.is_active, true);
    assert.equal(recorder.views()[0].view.action.count, 2);
    await client.stop();
  } finally {
    browser.restore();
  }
});
