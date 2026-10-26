import assert from 'node:assert/strict';
import test from 'node:test';

import { initRum } from '../dist/index.js';
import { installBrowser, quietConfiguration, recordRequests } from './support/browser.mjs';

const MINUTE = 60_000;
const START = 1_760_000_000_000;

function sessionCookie(browser, applicationId = 'unit-app') {
  const raw = browser.cookies.get(`_msrum_s_${applicationId}`);
  if (raw === undefined) return undefined;
  return Object.fromEntries(raw.split('&').map((pair) => pair.split('=')));
}

test('the session lives in a cookie that every tab of the application shares', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({ sessionCookieDomain: '.example.test', transport: recorder.transport }),
    );
    client.addAction('first page load');
    await client.flush();

    const cookie = sessionCookie(browser);
    assert.match(cookie.id, /^[0-9a-f-]{36}$/);
    assert.equal(cookie.tracked, '1');
    assert.equal(cookie.replay, '0');
    assert.ok(Number(cookie.expire) - Number(cookie.created) <= 15 * MINUTE + 1_000);

    const write = browser.cookies.writes.find((entry) => entry.startsWith('_msrum_s_unit-app=id='));
    assert.match(write, /;path=\//);
    assert.match(write, /;domain=\.example\.test/);
    assert.match(write, /;SameSite=Lax/);
    assert.match(write, /;Secure/, 'https pages get a secure cookie');
    assert.match(write, /;expires=/);

    const sessionId = recorder.events('action')[0].session.id;
    assert.equal(sessionId, cookie.id);
    for (const event of recorder.events()) {
      assert.equal(event.session.start, Number(cookie.created), 'every event says when its session began');
    }
    const tabId = recorder.events('action')[0].tab.id;
    await client.stop();

    // Another page load, or another tab, joins the same session.
    const second = initRum(quietConfiguration({ transport: recorder.transport }));
    second.addAction('second page load');
    await second.flush();
    const joined = recorder.events('action').find((event) => event.action.target.name === 'second page load');
    assert.equal(joined.session.id, sessionId);
    assert.equal(joined.tab.id, tabId, 'a reload keeps the tab id (sessionStorage)');
    assert.notEqual(joined.view.id, recorder.events('action')[0].view.id, 'but it is a new view');
    await second.stop();
  } finally {
    browser.restore();
  }
});

test('cookie attributes follow the page and the configuration', async () => {
  const browser = installBrowser({ url: 'http://localhost:3000/' });
  try {
    const client = initRum(quietConfiguration({ applicationId: 'plain-http', transport: recordRequests().transport }));
    client.addAction('x');
    const write = browser.cookies.writes.find((entry) => entry.startsWith('_msrum_s_plain-http=id='));
    assert.doesNotMatch(write, /Secure/, 'no Secure flag on plain http');
    assert.doesNotMatch(write, /domain=/, 'host-only by default');
    await client.stop();
  } finally {
    browser.restore();
  }

  const embedded = installBrowser();
  try {
    const iframe = initRum(
      quietConfiguration({
        applicationId: 'iframe-app',
        useCrossSiteSessionCookie: true,
        transport: recordRequests().transport,
      }),
    );
    iframe.addAction('x');
    const crossSite = embedded.cookies.writes.find((entry) => entry.startsWith('_msrum_s_iframe-app=id='));
    assert.match(crossSite, /SameSite=None/);
    assert.match(crossSite, /Secure/);
    await iframe.stop();
  } finally {
    embedded.restore();
  }
});

test('a session expires after 15 minutes without activity and renews on the next activity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));
    client.addAction('active');
    const first = client.getInternalContext().session_id;
    assert.ok(first);

    // Activity extends the session.
    t.mock.timers.tick(10 * MINUTE);
    browser.dispatchWindow('click');
    t.mock.timers.tick(10 * MINUTE);
    assert.equal(client.getInternalContext().session_id, first, '10 + 10 minutes with a click in between');

    // Background work does not.
    t.mock.timers.tick(5 * MINUTE + 1_000);
    assert.equal(client.getInternalContext().session_id, undefined, 'expired');
    client.addAction('too late');
    assert.equal(
      recorder.events('action').filter((event) => event.action.target.name === 'too late').length,
      0,
      'nothing is recorded without a live session',
    );
    await client.flush();
    const ended = recorder.views().find((event) => event.session.id === first);
    assert.equal(ended.view.is_active, false, 'the view of the expired session was ended');

    // The next user activity starts a new session with a new view.
    browser.dispatchWindow('keydown');
    const second = client.getInternalContext().session_id;
    assert.ok(second && second !== first);
    client.addAction('renewed');
    await client.flush();
    const renewed = recorder.events('action').find((event) => event.action.target.name === 'renewed');
    assert.equal(renewed.session.id, second);
    const view = recorder.views().find((event) => event.session.id === second);
    assert.equal(view.view.loading_type, 'session_renewal');
    assert.notEqual(view.view.id, ended.view.id);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('the inactivity timeout and the maximum duration are configurable; the default maximum is four hours', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));
    client.addAction('start');
    const first = client.getInternalContext().session_id;

    // A visitor who never stops clicking still gets a new session after four hours.
    for (let elapsed = 0; elapsed < 4 * 60 * MINUTE - 10 * MINUTE; elapsed += 10 * MINUTE) {
      t.mock.timers.tick(10 * MINUTE);
      browser.dispatchWindow('click');
    }
    assert.equal(client.getInternalContext().session_id, first, 'still the first session just before four hours');
    t.mock.timers.tick(10 * MINUTE + 1_000);
    assert.equal(client.getInternalContext().session_id, undefined, 'the four hour limit ended it');
    browser.dispatchWindow('click');
    assert.notEqual(client.getInternalContext().session_id, first);
    await client.stop();

    const short = initRum(
      quietConfiguration({
        applicationId: 'short',
        sessionInactivityTimeout: 2 * MINUTE,
        maxSessionDuration: 5 * MINUTE,
        transport: recorder.transport,
      }),
    );
    short.addAction('x');
    const shortId = short.getInternalContext().session_id;
    t.mock.timers.tick(MINUTE);
    browser.dispatchWindow('click');
    t.mock.timers.tick(MINUTE + 30_000);
    assert.equal(short.getInternalContext().session_id, shortId);
    t.mock.timers.tick(MINUTE);
    assert.equal(short.getInternalContext().session_id, undefined);
    await short.stop();
  } finally {
    browser.restore();
  }
});

test('stopSession ends the session for every tab until the next activity', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));
    client.addAction('before');
    const first = client.getInternalContext().session_id;

    client.stopSession();
    assert.equal(browser.cookies.get('_msrum_s_unit-app'), undefined);
    assert.equal(client.getInternalContext().session_id, undefined);
    client.addAction('after the end');
    client.addError(new Error('after the end'));
    await client.flush();
    assert.deepEqual(
      recorder.events('action').map((event) => event.action.target.name),
      ['before'],
    );
    assert.equal(recorder.views().find((event) => event.session.id === first).view.is_active, false);

    browser.dispatchWindow('click');
    const second = client.getInternalContext().session_id;
    assert.ok(second && second !== first);
    client.addAction('next session');
    await client.flush();
    assert.equal(
      recorder.events('action').find((event) => event.action.target.name === 'next session').session.id,
      second,
    );
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('a session started by another tab replaces this tab\'s session', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));
    client.addAction('in tab A');
    const own = client.getInternalContext().session_id;

    // Tab B renews the session: it writes a new session id to the shared cookie.
    const created = Date.now();
    browser.document.cookie =
      `_msrum_s_unit-app=id=tab-b-session&created=${created}&expire=${created + 15 * MINUTE}&tracked=1&replay=0;path=/;expires=${new Date(created + MINUTE * 15).toUTCString()}`;

    client.addAction('after tab B renewed');
    await client.flush();

    const after = recorder.events('action').find((event) => event.action.target.name === 'after tab B renewed');
    assert.equal(after.session.id, 'tab-b-session');
    const views = recorder.views();
    const old = views.find((event) => event.session.id === own);
    assert.equal(old.view.is_active, false, 'the old view ended inside the old session');
    const joined = views.find((event) => event.session.id === 'tab-b-session');
    assert.equal(joined.view.loading_type, 'session_renewal');
    assert.equal(after.view.id, joined.view.id);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('sdk fields carry the sample rates and replay is stored with the session', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(
      quietConfiguration({ sessionSampleRate: 100, sessionReplaySampleRate: 0, transport: recorder.transport }),
    );
    client.addAction('x');
    assert.equal(sessionCookie(browser).replay, '0');
    client.startSessionReplayRecording();
    assert.equal(sessionCookie(browser).replay, '2', 'forced on');
    client.stopSessionReplayRecording();
    assert.equal(sessionCookie(browser).replay, '0');
    await client.flush();
    const [action] = recorder.events('action');
    assert.equal(action.sdk.session_sample_rate, 100);
    assert.equal(action.sdk.replay_sample_rate, 0);
    assert.equal(recorder.views().at(-1).session.has_replay, undefined, 'no replay was recorded');
    await client.stop();

    browser.cookies.clear();
    const sampled = initRum(
      quietConfiguration({
        applicationId: 'replay-sampled',
        sessionReplaySampleRate: 100,
        transport: recorder.transport,
      }),
    );
    sampled.addAction('y');
    assert.equal(sessionCookie(browser, 'replay-sampled').replay, '1');
    await sampled.stop();
  } finally {
    browser.restore();
  }
});

test('the tab id belongs to the tab and is removed with consent', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const first = initRum(quietConfiguration({ transport: recorder.transport }));
    first.addAction('one');
    await first.stop();
    const second = initRum(quietConfiguration({ transport: recorder.transport }));
    second.addAction('two');
    await second.flush();
    const [one, two] = recorder.events('action');
    assert.equal(one.tab.id, two.tab.id);
    assert.equal(browser.sessionStorage.length, 1);
    second.setTrackingConsent('not-granted');
    assert.equal(browser.sessionStorage.length, 0);
    await second.stop();
  } finally {
    browser.restore();
  }
});
