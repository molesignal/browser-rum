import assert from 'node:assert/strict';
import test from 'node:test';

import { molesignalRum } from '../dist/index.js';
import { installBrowser, quietConfiguration, recordRequests } from './support/browser.mjs';

// This file runs in its own process, so `molesignalRum` has not seen `init` yet.

test('a consent decision made before init is applied by init', async (t) => {
  const browser = installBrowser();
  try {
    molesignalRum.setTrackingConsent('not-granted');
    assert.equal(molesignalRum.getTrackingConsent(), 'not-granted');
    assert.throws(() => molesignalRum.setTrackingConsent('maybe'), /granted/);

    const recorder = recordRequests(t);
    const client = molesignalRum.init(quietConfiguration({ transport: recorder.transport }));
    assert.equal(client.getTrackingConsent(), 'not-granted');
    client.addAction('not collected');
    await client.flush();
    assert.equal(recorder.requests.length, 0);
    assert.deepEqual(browser.cookies.names(), []);
    await client.stop();
  } finally {
    browser.restore();
  }
});
