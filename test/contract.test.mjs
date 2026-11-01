import assert from 'node:assert/strict';
import test from 'node:test';

import { initRum } from '../dist/index.js';
import { installBrowser, quietConfiguration, recordRequests } from './support/browser.mjs';
import {
  browserFixtures,
  contractSkipReason,
  contractViolations,
  loadContract,
  shapeProblems,
} from './support/contract.mjs';

// The event contract belongs to the MoleSignal server. These tests read it from
// MOLESIGNAL_CONTRACTS (default ../molesignal/contracts/rum/events) and are
// skipped, with the reason, when it cannot be found.
const skip = contractSkipReason();
if (skip) console.warn(`# ${skip}`);

/**
 * Fields of a fixture that this comparison leaves out: either a Node process
 * cannot produce them (they need real navigation timing, resource timing,
 * paint and layout, or the DOM, and the Playwright suite covers them against
 * the same fixtures), or their keys belong to the application, or the server
 * does not need them from a browser (a frame with a file and a line and no
 * `artifact_kind` is a source map frame, so the SDK leaves `artifact_kind` out),
 * or the developer decides them (`error.fingerprint` overrides the server's own
 * grouping, so the SDK sets it only when `addError` is given one).
 */
const NEEDS_A_BROWSER = [
  /^view\.custom_timings\./,
  /^error\.frames\[\]\.artifact_kind$/,
  /^error\.fingerprint$/,
  /^view\.(first_byte|dom_|load_event|loading_time|performance)/,
  /^view\.(long_task|resource)\./,
  /^(connectivity|display)\./,
  /^device\.type$/,
  /^action\.(target\.(selector|path|width|height|offset)|position|page_position|name_source|frustration|loading_time|error|resource|long_task)/,
  /^view\.scroll\./,
  /^synthetics\./,
  /^log\.(stack|error_type)$/,
  /^resource\.(dns|connect|ssl|first_byte|download|response|graphql|size|encoded_body_size|decoded_body_size|transfer_size|protocol|delivery_type)/,
  /^long_task\./,
  /^session\.has_replay$/,
  /^usr\.(name|email|plan)$/,
  /^account\./,
  /^context\./,
  /^feature_flags\./,
];

function isCovered(path) {
  return NEEDS_A_BROWSER.some((pattern) => pattern.test(path));
}

test('the fixtures behave as the manifest says', { skip }, () => {
  const contract = loadContract();
  const manifest = contract.manifest();
  assert.ok(manifest.cases.length > 0);
  for (const entry of manifest.cases) {
    const [kind, name] = entry.path.split('/');
    const fixture = contract.fixtures(kind).find((candidate) => candidate.name === name);
    const events = entry.batch ? fixture.document : [fixture.document];
    const violations = contractViolations(events);
    assert.equal(violations.length === 0, entry.valid, `${entry.path}: ${violations.join(' | ')}`);
  }
});

test('every event the SDK emits validates against v1.schema.json', { skip }, async (t) => {
  const browser = installBrowser({
    fetch: async (input) => {
      const url = String(input);
      if (url.includes('/offline')) throw new TypeError('Failed to fetch');
      return new Response('{}', {
        status: url.includes('/error') ? 500 : 200,
        headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      });
    },
  });
  try {
    const recorder = recordRequests();
    const client = initRum(
      quietConfiguration({
        service: 'contract',
        env: 'test',
        version: '1.0.0',
        debugId: 'contract-build',
        user: { id: 'u-1', name: 'Ada', email: 'ada@example.com', plan: 'pro' },
        account: { id: 'acme', name: 'Acme' },
        globalContext: { region: 'eu' },
        trackResources: true,
        sessionReplaySampleRate: 100,
        transport: recorder.transport,
      }),
    );
    client.addAction('Add to cart', { sku: 'x' });
    client.addError(new RangeError('out of range', { cause: new Error('inner cause') }), { where: 'cart' });
    client.addTiming('cart_ready');
    client.addFeatureFlagEvaluation('new_checkout', true);
    client.setViewContext({ flow: 'checkout' });
    const vital = client.startDurationVital('checkout_form', { description: 'form' });
    client.stopDurationVital(vital);
    client.addDurationVital('manual', { startTime: Date.now() - 20, duration: 10 });
    await window.fetch('https://api.example.test/orders?q=1', { method: 'POST' });
    await window.fetch('https://api.example.test/error');
    await assert.rejects(window.fetch('https://api.example.test/offline'));
    browser.navigate('/checkout');
    client.startView({ name: 'Pay', service: 'payments', version: '2.0.0' });
    browser.setVisibility('hidden');
    await client.flush();

    const types = new Set(recorder.events().map((event) => event.type));
    for (const type of ['view', 'action', 'error', 'resource', 'vital']) {
      assert.ok(types.has(type), `the scenario produced a ${type} event`);
    }
    const violations = contractViolations(recorder.events());
    assert.deepEqual(violations, []);
    assert.ok(recorder.events().length >= 10);
    await client.stop();
  } finally {
    browser.restore();
  }
});

test('invalid events are caught by the harness', { skip }, () => {
  const violations = contractViolations([
    { type: 'view', date: 'now', source: 'browser', session: { id: 'a b' }, view: { id: 'v' } },
    { type: 'resource', date: 1, source: 'browser', session: { id: 's' }, view: { id: 'v' }, resource: { type: 'xhr', url: 'u', duration: 1.5 } },
  ]);
  assert.equal(violations.length, 2);
});

/**
 * The fixtures with `source: browser` are the reference for the shape of each
 * event: where the SDK emits the same field it has the same type, and it emits
 * every field the fixture has except those that need a real browser.
 */
test('SDK events have the shape of the browser fixtures', { skip }, async () => {
  const browser = installBrowser({
    fetch: async (input) => {
      if (String(input).includes('/offline')) throw new TypeError('Failed to fetch');
      return new Response('{}', {
        status: 200,
        headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      });
    },
  });
  try {
    const recorder = recordRequests();
    const client = initRum(
      quietConfiguration({
        service: 'web',
        env: 'prod',
        version: '1.4.0',
        debugId: '7c1d5e2a-93b4-4f8e-a0d6-5b1c2e3f4a60',
        user: { id: 'u-42' },
        trackResources: true,
        allowedTracingUrls: ['https://api.example.test/'],
        transport: recorder.transport,
      }),
    );
    client.startView('/checkout');
    client.addAction('open_cart');
    client.addError(new TypeError('total is undefined', { cause: new Error('total is undefined') }));
    const vital = client.startDurationVital('checkout_form_ready');
    client.stopDurationVital(vital);
    await window.fetch('https://api.example.test/cart');
    await assert.rejects(window.fetch('https://api.example.test/offline'));
    await client.flush();

    const sdkEvents = recorder.events();
    const fixtures = browserFixtures();
    assert.ok(fixtures.length >= 8);

    // The event the SDK emitted for the same case as a fixture, if a Node process can emit it.
    const counterpart = (fixture) => {
      switch (fixture.type) {
        case 'view':
          return sdkEvents.find((event) => event.type === 'view');
        case 'action':
          return fixture.action.type === 'custom'
            ? sdkEvents.find((event) => event.type === 'action' && event.action.type === 'custom')
            : undefined;
        case 'error':
          return sdkEvents.find(
            (event) =>
              event.type === 'error' &&
              (event.error.source === 'network') === (fixture.error.source === 'network'),
          );
        case 'resource':
          return sdkEvents.find(
            (event) => event.type === 'resource' && event.resource.type === fixture.resource.type,
          );
        case 'vital':
          return sdkEvents.find(
            (event) => event.type === 'vital' && event.vital.type === fixture.vital.type,
          );
        default:
          return undefined; // long tasks need a browser
      }
    };

    const compared = new Set();
    for (const fixture of fixtures) {
      const actualEvent = counterpart(fixture);
      if (!actualEvent) continue;
      compared.add(
        `${fixture.type}:${fixture.error?.source === 'network' ? 'network' : (fixture.action?.type ?? fixture.resource?.type ?? '')}`,
      );
      const problems = shapeProblems(
        fixture,
        actualEvent,
        (path) => isCovered(path) || (fixture.type !== 'action' && path === 'action.id'),
      );
      assert.deepEqual(problems, []);
    }
    for (const expected of ['view:', 'action:custom', 'error:', 'error:network', 'resource:fetch', 'vital:']) {
      assert.ok(compared.has(expected), `${expected} was compared with a fixture`);
    }
    await client.stop();
  } finally {
    browser.restore();
  }
});
