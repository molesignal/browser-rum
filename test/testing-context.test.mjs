import assert from 'node:assert/strict';
import test from 'node:test';

import { initRum, molesignalRum } from '../dist/index.js';
import { installBrowser, quietConfiguration, recordRequests } from './support/browser.mjs';
import { contractSkipReason, contractViolations } from './support/contract.mjs';

const skip = contractSkipReason();

function drivenBy(context) {
  globalThis.__MOLESIGNAL_TEST_CONTEXT__ = context;
}

function forget() {
  delete globalThis.__MOLESIGNAL_TEST_CONTEXT__;
  delete globalThis.__MOLESIGNAL_RUM_SESSION__;
}

test('a session a check drives says so, whatever is sampled, and tells the page its id', { skip }, async (t) => {
  const browser = installBrowser();
  drivenBy({ type: 'synthetics', test_id: 'chk-1', result_id: 'task-1', location_id: 'eu-west', nonsense: 'x' });
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport, sessionSampleRate: 0 }));

    client.addAction('step');
    await client.flush();

    const events = recorder.events();
    assert.ok(events.length >= 2);

    for (const event of events) {
      assert.equal(event.session.type, 'synthetics');
      assert.deepEqual(event.synthetics, { test_id: 'chk-1', result_id: 'task-1', location_id: 'eu-west' });
    }

    assert.equal(globalThis.__MOLESIGNAL_RUM_SESSION__, events[0].session.id);
    assert.deepEqual(contractViolations(events), []);
    await client.stop();
  } finally {
    forget();
    browser.restore();
  }
});

test('a test run says its execution', async (t) => {
  const browser = installBrowser();
  drivenBy({ type: 'ci_test', test_execution_id: 'run-9' });
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));

    await client.flush();

    const [view] = recorder.events('view');
    assert.equal(view.session.type, 'ci_test');
    assert.deepEqual(view.ci_test, { test_execution_id: 'run-9' });
    await client.stop();
  } finally {
    forget();
    browser.restore();
  }
});

test('a page nothing drives is a person', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));

    await client.flush();

    const [view] = recorder.events('view');
    assert.equal(view.session.type, 'user');
    assert.equal(view.synthetics, undefined);
    assert.equal(globalThis.__MOLESIGNAL_RUM_SESSION__, undefined);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('the link of a session is under the origin of the site, or the app address', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport, site: 'https://rum.example.test/api/v1/rum' }));

    const [id] = [client.getInternalContext().session_id];

    assert.equal(client.getSessionReplayLink(), `https://rum.example.test/rum/sessions/view/${id}`);
    await client.stop();

    const elsewhere = initRum(quietConfiguration({ transport: recorder.transport, appUrl: 'https://molesignal.example.test/' }));

    assert.equal(
      elsewhere.getSessionReplayLink(),
      `https://molesignal.example.test/rum/sessions/view/${elsewhere.getInternalContext().session_id}`,
    );
    await elsewhere.stop();
  } finally {
    browser.restore();
  }
});

test('a view can say when it has loaded', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const client = initRum(quietConfiguration({ transport: recorder.transport }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    client.setViewLoadingTime();
    await client.flush();

    const last = recorder.events('view').at(-1);
    assert.ok(last.view.loading_time >= 10_000_000, String(last.view.loading_time));
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('what is decided on the server replaces what the page gave, and calls wait for it', async (t) => {
  const browser = installBrowser({
    fetch: async (input) => {
      if (String(input).endsWith('/api/v1/rum/config')) {
        return new Response(JSON.stringify({ sessionSampleRate: 100, defaultPrivacyLevel: 'allow', forwardConsoleLogs: ['warn'] }), { status: 200 });
      }

      return new Response('{}', { status: 200 });
    },
  });
  const original = console.warn;
  console.warn = () => undefined;
  try {
    const recorder = recordRequests(t);
    const client = molesignalRum.init(quietConfiguration({ transport: recorder.transport, remoteConfiguration: true, sessionSampleRate: 0 }));

    assert.equal(client, molesignalRum, 'the API stands in until the SDK starts');
    client.addAction('early');

    for (let attempt = 0; attempt < 500 && !molesignalRum.getRum(); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    console.warn('forwarded');
    await molesignalRum.flush();

    assert.equal(recorder.events('action').length, 1);
    assert.equal(recorder.events('log')[0].message, 'forwarded');
    await molesignalRum.stop();
  } finally {
    console.warn = original;
    browser.restore();
  }
});

test('a plugin can set what it needs before the SDK reads it, and is told when it runs', async (t) => {
  const browser = installBrowser();
  try {
    const recorder = recordRequests(t);
    const told = [];
    const client = molesignalRum.init(
      quietConfiguration({
        transport: recorder.transport,
        plugins: [
          {
            name: 'router',
            onInit(configuration) {
              configuration.trackViewsManually = true;
            },
            onStart({ client }) {
              told.push(typeof client.startView);
            },
          },
        ],
      }),
    );

    assert.deepEqual(told, ['function']);
    await client.flush();
    assert.equal(recorder.events('view').length, 0);
    await client.stop();
  } finally {
    browser.restore();
  }
});
