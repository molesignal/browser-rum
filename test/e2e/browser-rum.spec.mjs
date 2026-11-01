import { expect, test } from '@playwright/test';

import {
  browserFixtures,
  contractSkipReason,
  shapeProblems,
} from '../support/contract.mjs';
import { boot, collectRum, flush, hidePage, showPage } from './support.mjs';

const PAGE = 'http://127.0.0.1:4173/fixture.html';
const BUTTON = (id) => `#${id}`;
const FIRST_BUTTON = '[id="customer-alice@example.com"]';

test.beforeEach(async ({ page }) => {
  await page.goto('/fixture.html');
  await page.waitForFunction(() => window.fixtureReady === true);
});

test.afterEach(async ({ page }) => {
  // Anything the SDK sent in a test must satisfy the event contract.
  const violations = page.__rumViolations?.() ?? [];
  expect(violations, 'events that violate the event contract').toEqual([]);
});

async function start(page, overrides) {
  const rum = await collectRum(page);
  page.__rumViolations = rum.violations;
  if (overrides !== null) await boot(page, overrides);
  return rum;
}

const latestView = (rum) => rum.views().at(-1);

test('consent, privacy, errors, and trace injection work in a real browser', async ({ page }) => {
  const rum = await start(page, null);
  let traceparent;
  await page.route('**/trace-target', async (route) => {
    traceparent = route.request().headers().traceparent;
    await route.fulfill({ status: 204 });
  });

  await boot(page, { trackingConsent: 'not-granted' });
  await page.waitForTimeout(350);
  expect(rum.requests).toHaveLength(0);
  expect(
    await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage))),
  ).toEqual([]);
  expect(await page.evaluate(() => document.cookie)).toBe('');

  await page.evaluate(() => window.rum.setTrackingConsent('granted'));
  await page.locator(FIRST_BUTTON).click();
  await page.evaluate(async () => {
    window.rum.startView('Checkout');
    window.rum.addError(new Error('Browser E2E failure'));
    await fetch('/trace-target');
    await window.rum.flush();
  });

  await expect.poll(() => rum.events().length).toBeGreaterThan(0);
  expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

  // A click becomes an action once the page has settled after it.
  await expect
    .poll(() => rum.events('action').some((event) => event.action.type === 'click'))
    .toBe(true);
  const click = rum.events('action').find((event) => event.action.type === 'click');
  expect(click.action.target.name).toBe('Click button:nth-of-type(1)');
  expect(click.action.target.selector).toBe('button:nth-of-type(1)');
  expect(click.action.name_source).toBe('mask_placeholder');
  expect(JSON.stringify(click)).not.toContain('alice@example.com');
  expect(JSON.stringify(click)).not.toContain('Alice private account');

  const error = rum.events('error').find((event) => event.error.message === 'Browser E2E failure');
  expect(error.error.source).toBe('custom');
  expect(error.error.handling).toBe('handled');
  expect(error.source).toBe('browser');
  expect(error.application).toEqual({ id: 'browser-e2e' });

  const resource = rum.events('resource').find((event) => event.resource.url.endsWith('/trace-target'));
  expect(resource.resource.trace_id).toBe(traceparent.split('-')[1]);
  expect(resource.resource.span_id).toBe(traceparent.split('-')[2]);

  const view = latestView(rum);
  expect(view.view.name).toBe('Checkout');
  expect(view.view.error.count).toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => document.cookie)).toContain('_msrum_s_browser-e2e=');

  await page.evaluate(() => window.rum.setTrackingConsent('not-granted'));
  expect(
    await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage))),
  ).toEqual([]);
  expect(await page.evaluate(() => document.cookie)).toBe('');
});

test('a view is reported again with a higher revision, per route, and finally as inactive', async ({
  page,
  browserName,
}) => {
  const rum = await start(page, { trackViewsManually: false, trackWebVitals: true });

  await expect.poll(() => rum.events('view').length).toBeGreaterThan(0);
  await flush(page);
  await page.locator(BUTTON('fetch-button')).click();
  await expect(page.locator('#mutation-target')).toHaveText('loaded 200');
  await flush(page);

  // The page load fills the navigation timings and the loading time.
  await expect
    .poll(async () => {
      await flush(page);
      const view = rum.views()[0]?.view;
      return (
        view?.load_event !== undefined && view?.loading_time !== undefined && view?.action.count >= 1
      );
    })
    .toBe(true);
  const first = rum.views()[0];
  expect(first.view.loading_type).toBe('initial_load');
  expect(first.view.url).toBe(PAGE);
  expect(first.view.name).toBe('/fixture.html');
  for (const key of ['dom_interactive', 'dom_content_loaded', 'dom_complete', 'load_event', 'loading_time']) {
    expect(Number.isInteger(first.view[key]), key).toBe(true);
    expect(first.view[key], key).toBeGreaterThan(0);
  }
  // Firefox rounds timestamps to the millisecond, so a fast local response can start at 0.
  expect(Number.isInteger(first.view.first_byte)).toBe(true);
  expect(first.view.first_byte).toBeGreaterThanOrEqual(0);
  expect(first.view.dom_interactive).toBeLessThanOrEqual(first.view.dom_complete);
  expect(first.view.resource.count).toBeGreaterThanOrEqual(1);
  expect(first.view.action.count).toBeGreaterThanOrEqual(1);

  // Core Web Vitals, with the element, from web-vitals/attribution.
  if (browserName === 'chromium') {
    await expect
      .poll(async () => {
        await flush(page);
        return rum.views()[0].view.performance?.lcp !== undefined;
      })
      .toBe(true);
    const performance = rum.views()[0].view.performance;
    expect(Number.isInteger(performance.fcp.timestamp)).toBe(true);
    expect(performance.fcp.timestamp).toBeGreaterThan(0);
    expect(performance.lcp.timestamp).toBeGreaterThan(0);
    expect(performance.lcp.timestamp).toBeGreaterThanOrEqual(performance.fcp.timestamp);
    expect(performance.lcp.target_selector).toBeTruthy();
    expect(performance.lcp.sub_parts).toBeDefined();
  }

  // A route change ends the view and starts the next one.
  await page.evaluate(() => history.pushState({}, '', '/second-page?secret=1'));
  await flush(page);
  await expect.poll(() => rum.views().length).toBe(2);
  const [initial, second] = rum.views();
  expect(initial.view.is_active).toBe(false);
  expect(second.view.loading_type).toBe('route_change');
  expect(second.view.name).toBe('/second-page');
  expect(second.view.url).toBe('http://127.0.0.1:4173/second-page');
  expect(second.view.referrer).toBe(PAGE);
  expect(second.session.id).toBe(initial.session.id);
  expect(second.date).toBeGreaterThanOrEqual(initial.date);

  // Every revision of a view keeps its date and only grows.
  for (const id of new Set(rum.events('view').map((event) => event.view.id))) {
    const revisions = rum.events('view').filter((event) => event.view.id === id);
    expect(new Set(revisions.map((event) => event.date)).size, `date of ${id}`).toBe(1);
    const numbers = revisions.map((event) => event.view.revision);
    expect([...numbers].sort((a, b) => a - b)).toEqual([...new Set(numbers)].sort((a, b) => a - b));
    expect(numbers.every((n) => Number.isInteger(n) && n >= 1)).toBe(true);
  }
  const revisionsOfFirst = rum.events('view').filter((event) => event.view.id === initial.view.id);
  expect(Math.max(...revisionsOfFirst.map((event) => event.view.revision))).toBeGreaterThanOrEqual(2);

  // Hiding the page sends the last version at once.
  await page.evaluate(() => window.rum.addAction('last action'));
  await hidePage(page);
  await expect.poll(() => latestView(rum).view.action.count).toBeGreaterThanOrEqual(1);
  await expect.poll(() => latestView(rum).view.is_active).toBe(false);
  await showPage(page);
  await flush(page);
  await expect.poll(() => latestView(rum).view.is_active).toBe(true);
  expect(latestView(rum).view.revision).toBeGreaterThan(second.view.revision);
});

test('resources carry their timing phases, sizes, protocol and trace ids', async ({
  page,
  browserName,
}) => {
  const rum = await start(page, { trackUserInteractions: false });

  const echoed = await page.evaluate(async () => {
    await (await fetch('/__rum/json?delay=60&size=4096')).text();
    // A response nobody reads has no timing entry: it is reported as measured.
    await fetch('/__rum/json?delay=5&size=16&unread=1');
    await new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = '/__rum/script.js?delay=20&v=1';
      script.onload = resolve;
      document.head.append(script);
    });
    await new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/__rum/style.css';
      link.onload = resolve;
      document.head.append(link);
    });
    await new Promise((resolve) => {
      const image = new Image();
      image.onload = resolve;
      image.src = '/__rum/pixel.png?x=2';
    });
    const request = new XMLHttpRequest();
    request.open('POST', '/__rum/echo');
    const done = new Promise((resolve) => {
      request.onloadend = resolve;
    });
    request.send('payload');
    await done;
    return JSON.parse(request.responseText);
  });
  await page.waitForTimeout(300);
  await flush(page);

  const resources = rum.events('resource');
  const byType = (type) => resources.filter((event) => event.resource.type === type);

  const fetched = byType('fetch').find(
    (event) => event.resource.url.endsWith('/__rum/json') && event.resource.first_byte,
  );
  expect(fetched, 'a fetch resource').toBeDefined();
  const r = fetched.resource;
  expect(r.method).toBe('GET');
  expect(r.status_code).toBe(200);
  expect(r.url).toBe('http://127.0.0.1:4173/__rum/json');
  expect(Number.isInteger(r.duration)).toBe(true);
  expect(r.duration).toBeGreaterThanOrEqual(50_000_000);
  expect(r.size).toBeGreaterThanOrEqual(4096);
  expect(r.decoded_body_size).toBeGreaterThanOrEqual(4096);
  expect(r.encoded_body_size).toBeGreaterThan(0);
  expect(r.transfer_size).toBeGreaterThan(0);
  expect(typeof r.protocol).toBe('string');
  expect(['cache', 'navigational-prefetch', 'other']).toContain(r.delivery_type);
  expect(r.first_byte.duration).toBeGreaterThanOrEqual(40_000_000);
  expect(r.download.start).toBeGreaterThanOrEqual(r.first_byte.start);
  for (const phase of ['first_byte', 'download', 'dns', 'connect', 'ssl', 'redirect']) {
    if (r[phase] === undefined) continue;
    expect(Number.isInteger(r[phase].start), `${phase}.start`).toBe(true);
    expect(Number.isInteger(r[phase].duration), `${phase}.duration`).toBe(true);
    expect(r[phase].start).toBeGreaterThanOrEqual(0);
    expect(r[phase].duration).toBeGreaterThanOrEqual(0);
  }
  expect(r.trace_id).toMatch(/^[0-9a-f]{32}$/);
  expect(r.span_id).toMatch(/^[0-9a-f]{16}$/);

  const xhr = byType('xhr').find((event) => event.resource.url.endsWith('/__rum/echo'));
  expect(xhr.resource.method).toBe('POST');
  expect(xhr.resource.status_code).toBe(200);
  const sent = echoed.traceparent.split('-');
  expect(xhr.resource.trace_id).toBe(sent[1]);
  expect(xhr.resource.span_id).toBe(sent[2]);

  expect(byType('js').some((event) => event.resource.url === 'http://127.0.0.1:4173/__rum/script.js')).toBe(true);
  expect(byType('css').some((event) => event.resource.url.endsWith('/__rum/style.css'))).toBe(true);
  const images = byType('image').filter((event) => event.resource.url.includes('/__rum/pixel.png'));
  expect(images.length).toBeGreaterThanOrEqual(1);
  expect(images.every((event) => !event.resource.url.includes('?'))).toBe(true);
  expect(byType('document').some((event) => event.resource.url === PAGE)).toBe(true);

  const unread = byType('fetch').filter((event) => event.resource.url.endsWith('/__rum/json'));
  expect(unread, 'one event per request, read or not').toHaveLength(2);
  if (browserName === 'chromium') {
    // Only Chromium waits for the body: the others time a response nobody reads as well.
    const measured = unread.find((event) => event.resource.first_byte === undefined);
    expect(measured.resource.status_code).toBe(200);
    expect(Number.isInteger(measured.resource.duration)).toBe(true);
    expect(measured.resource.trace_id).toMatch(/^[0-9a-f]{32}$/);
  }

  expect(latestView(rum).view.resource.count).toBeGreaterThanOrEqual(resources.length - 1);
});

test('clicks become actions with privacy-safe names, frustration signals and the work they caused', async ({
  page,
}) => {
  const rum = await start(page, { trackFrustrations: true });

  // A click the page ignores is a dead click.
  await page.locator(BUTTON('dead-button')).click();
  // Four quick clicks in one place are a rage click.
  const box = await page.locator(BUTTON('rage-button')).boundingBox();
  for (let click = 0; click < 4; click += 1) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  // A click that loads data: its loading time covers the request, which is counted on it.
  await page.locator(BUTTON('fetch-button')).click();
  await expect(page.locator('#mutation-target')).toHaveText('loaded 200');
  // A click whose handler throws.
  await page.locator(BUTTON('error-button')).click();

  await expect
    .poll(async () => {
      await page.waitForTimeout(150);
      return rum.events('action').length;
    }, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(7);
  await flush(page);

  const actions = rum.events('action');
  const named = (selector) => actions.filter((event) => event.action.target?.selector === selector);

  const dead = named('button:nth-of-type(2)');
  expect(dead[0].action.type).toBe('click');
  expect(dead[0].action.frustration.type).toContain('dead_click');
  expect(dead[0].action.target.name).toBe('Click button:nth-of-type(2)');
  expect(dead[0].action.name_source).toBe('mask_placeholder');
  expect(dead[0].action.target.width).toBeGreaterThan(0);
  expect(Number.isInteger(dead[0].action.target.height)).toBe(true);
  expect(Number.isInteger(dead[0].action.position.x)).toBe(true);
  expect(Number.isInteger(dead[0].action.position.y)).toBe(true);

  const rage = named('button:nth-of-type(3)');
  expect(rage.length).toBe(4);
  expect(rage.flatMap((event) => event.action.frustration?.type ?? [])).toContain('rage_click');
  expect(rage.filter((event) => event.action.frustration?.type.includes('rage_click'))).toHaveLength(1);

  const fetching = named('button:nth-of-type(5)')[0];
  expect(Number.isInteger(fetching.action.loading_time)).toBe(true);
  expect(fetching.action.loading_time).toBeGreaterThanOrEqual(50_000_000);
  expect(fetching.action.resource.count).toBeGreaterThanOrEqual(1);
  const caused = rum
    .events('resource')
    .find((event) => event.resource.url.endsWith('/__rum/json') && event.action);
  expect(caused.action.id).toBe(fetching.action.id);
  expect(caused.view.id).toBe(fetching.view.id);

  const failing = named('button:nth-of-type(6)')[0];
  expect(failing.action.error.count).toBe(1);
  expect(failing.action.frustration.type).toContain('error_click');
  const thrown = rum.events('error').find((event) => event.error.message === 'click failure');
  expect(thrown.action.id).toBe(failing.action.id);

  const view = latestView(rum);
  expect(view.view.action.count).toBe(actions.length);
  expect(view.view.frustration.count).toBeGreaterThanOrEqual(3);
});

test('with privacy allowed, actions are named from the page', async ({ page }) => {
  const rum = await start(page, { defaultPrivacyLevel: 'allow' });
  await page.locator(FIRST_BUTTON).click();
  await page.locator(BUTTON('dead-button')).click();
  await page.waitForTimeout(400);
  await flush(page);

  const actions = rum.events('action');
  const custom = actions.find((event) => event.action.target.name === 'Alice private account');
  expect(custom.action.name_source).toBe('custom_attribute');
  expect(custom.action.target.selector).toBe('[data-molesignal-name="Alice private account"]');
  const text = actions.find((event) => event.action.target.name === 'Does nothing');
  expect(text.action.name_source).toBe('text_content');
  expect(text.action.target.selector).toBe('button#dead-button');
});

test('errors carry structured frames and causes, and a fingerprint only when the developer passes one', async ({ page }) => {
  const rum = await start(page, { trackConsoleErrors: true, trackUserInteractions: false });
  await page.route('**/aborted-request', (route) => route.abort());

  await page.evaluate(async () => {
    window.fixture.throwUncaught();
    window.fixture.throwWithCause();
    window.fixture.rejectUnhandled();
    window.fixture.consoleError();
    window.rum.addError(new Error('declined by the bank'), { step: 'pay' }, { fingerprint: 'payment-declined' });
    window.fixture.loadBrokenScript();
    window.fixture.violateCsp();
    await window.fixture.failXhr();
    await window.fixture.failRequests();
  });
  await page.waitForTimeout(400);
  await flush(page);

  const errors = rum.events('error');
  const uncaught = errors.find((event) => event.error.message === 'uncaught boom');
  expect(uncaught.error).toMatchObject({
    source: 'source',
    handling: 'unhandled',
    type: 'TypeError',
    source_type: 'browser',
  });
  expect(uncaught.error.stack).toMatch(/^TypeError: uncaught boom\n {4}at /);
  expect(uncaught.error.stack).toContain('fixture.html:');
  expect(uncaught.error.frames.length).toBeGreaterThanOrEqual(1);
  const [top] = uncaught.error.frames;
  expect(top.file).toBe(PAGE);
  expect(Number.isInteger(top.line) && top.line > 0).toBe(true);
  expect(Number.isInteger(top.column) && top.column > 0).toBe(true);
  expect(uncaught.error.frames.every((frame) => frame.debug_id === 'e2e-build-1')).toBe(true);

  const caused = errors.find((event) => event.error.message === 'outer failure');
  expect(caused.error.causes[0]).toMatchObject({ message: 'inner failure', type: 'Error' });

  const rejected = errors.find((event) => event.error.message === 'rejected boom');
  expect(rejected.error).toMatchObject({ source: 'source', handling: 'unhandled', type: 'RangeError' });

  const logged = errors.find((event) => event.error.message === 'console boom');
  expect(logged.error).toMatchObject({ source: 'console', handling: 'handled' });
  expect(logged.error.handling_stack).toContain('fixture.html');

  const http = errors.find((event) => event.error.resource?.status_code === 500);
  expect(http.error).toMatchObject({
    source: 'network',
    type: 'HTTPError',
    resource: { method: 'GET', status_code: 500, url: 'http://127.0.0.1:4173/__rum/json' },
  });
  const offline = errors.find((event) => event.error.resource?.url.endsWith('/aborted-request'));
  expect(offline.error.source).toBe('network');
  expect(offline.error.resource.status_code).toBe(0);
  expect(offline.error.message).toContain('/aborted-request');

  const xhr = errors.find((event) => event.error.resource?.status_code === 404);
  expect(xhr.error).toMatchObject({ source: 'network', type: 'HTTPError', handling: 'handled' });
  expect(xhr.error.message).toMatch(/^GET http:\/\/127\.0\.0\.1:4173\/__rum\/json failed with status 404/);
  expect(xhr.error.resource).toEqual({
    method: 'GET',
    status_code: 404,
    url: 'http://127.0.0.1:4173/__rum/json',
  });

  const script = errors.find((event) => event.error.type === 'ResourceLoadError');
  expect(script.error.source).toBe('network');
  expect(script.error.resource).toEqual({
    method: 'GET',
    status_code: 0,
    url: 'http://127.0.0.1:4173/__rum/missing-script.js',
  });

  const csp = errors.find((event) => event.error.source === 'report');
  expect(csp.error.message).toBe("'script-src' directive violation: 'https://evil.example/inject.js' was blocked");
  expect(csp.error.csp).toEqual({ disposition: 'enforce' });

  // The server groups errors. The SDK sets a fingerprint on none of the errors it
  // collects, and sends the one the developer passed to addError as given.
  const chosen = errors.find((event) => event.error.message === 'declined by the bank');
  expect(chosen.error).toMatchObject({ source: 'custom', handling: 'handled', fingerprint: 'payment-declined' });
  expect(chosen.context.step).toBe('pay');
  expect(
    errors.filter((event) => 'fingerprint' in event.error).map((event) => event.error.message),
  ).toEqual(['declined by the bank']);

  expect(latestView(rum).view.error.count).toBe(errors.length);
});

test('long tasks come with the scripts that caused them', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'only Chromium reports long tasks and long animation frames');
  const rum = await start(page, { trackLongTasks: true });

  await page.locator(BUTTON('busy-button')).click();
  await expect
    .poll(async () => {
      await flush(page);
      return rum.events('long_task').length > 0 && rum.events('action').length > 0;
    })
    .toBe(true);

  const longTask = rum.events('long_task').find((event) => event.long_task.duration >= 200_000_000);
  expect(longTask, 'the 250 ms block').toBeDefined();
  const task = longTask.long_task;
  expect(['long-animation-frame', 'long-task']).toContain(task.entry_type);
  expect(Number.isInteger(task.duration)).toBe(true);
  expect(Number.isInteger(task.start_time) && task.start_time >= 0).toBe(true);
  if (task.entry_type === 'long-animation-frame') {
    expect(task.blocking_duration).toBeGreaterThan(0);
    expect(task.scripts.length).toBeGreaterThanOrEqual(1);
    const script = task.scripts.find((candidate) => candidate.invoker_type === 'event-listener');
    expect(script.source_url).toBe(PAGE);
    expect(Number.isInteger(script.start_time)).toBe(true);
    expect(script.invoker).not.toContain('#');
  }
  const action = rum.events('action').find((event) => event.action.target?.selector === 'button:nth-of-type(4)');
  expect(longTask.action.id).toBe(action.action.id);
  expect(action.action.long_task.count).toBeGreaterThanOrEqual(1);
  expect(latestView(rum).view.long_task.count).toBeGreaterThanOrEqual(1);
});

test('custom duration vitals are reported with nanosecond durations', async ({ page }) => {
  const rum = await start(page, { trackUserInteractions: false });
  await page.evaluate(async () => {
    const vital = window.rum.startDurationVital('checkout_form_ready', { description: 'form is usable' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    window.rum.stopDurationVital(vital, { context: { step: 'payment' } });
    window.rum.addDurationVital('image_decode', { startTime: Date.now() - 80, duration: 30, context: { kind: 'hero' } });
    await window.rum.flush();
  });

  await expect.poll(() => rum.events('vital').length).toBe(2);
  const [form, decode] = rum.events('vital');
  expect(form.vital).toMatchObject({ type: 'duration', name: 'checkout_form_ready', description: 'form is usable' });
  expect(Number.isInteger(form.vital.duration)).toBe(true);
  expect(form.vital.duration).toBeGreaterThanOrEqual(40_000_000);
  expect(form.vital.duration).toBeLessThan(5_000_000_000);
  expect(form.context.step).toBe('payment');
  expect(decode.vital.duration).toBe(30_000_000);
  expect(decode.context.kind).toBe('hero');
  expect(Math.abs(decode.date - (Date.now() - 80))).toBeLessThan(5_000);
});

test('tabs share one session and each has its own tab id', async ({ page, context }) => {
  const rum = await start(page, { trackUserInteractions: false });
  const other = await context.newPage();
  await other.goto('/fixture.html');
  await other.waitForFunction(() => window.fixtureReady === true);
  await boot(other, { trackUserInteractions: false });

  await page.evaluate(() => window.rum.addAction('from tab one'));
  await other.evaluate(() => window.rum.addAction('from tab two'));
  await flush(page);
  await flush(other);
  await expect.poll(() => rum.events('action').length).toBe(2);

  const [one, two] = ['from tab one', 'from tab two'].map((name) =>
    rum.events('action').find((event) => event.action.target.name === name),
  );
  expect(two.session.id).toBe(one.session.id);
  expect(two.session.start).toBe(one.session.start);
  expect(two.tab.id).not.toBe(one.tab.id);
  expect(two.view.id).not.toBe(one.view.id);

  // Ending the session in one tab ends it everywhere; user activity starts the next one.
  await page.evaluate(() => window.rum.stopSession());
  await other.evaluate(() => window.rum.addAction('after the end'));
  await flush(other);
  await other.locator(BUTTON('dead-button')).click();
  await other.evaluate(() => window.rum.addAction('next session'));
  await flush(other);
  await page.locator(BUTTON('dead-button')).click();
  await page.evaluate(() => window.rum.addAction('joins the next session'));
  await flush(page);
  await expect.poll(() => rum.events('action').some((event) => event.action.target?.name === 'joins the next session')).toBe(true);

  const names = rum.events('action').map((event) => event.action.target?.name);
  expect(names).not.toContain('after the end');
  const next = rum.events('action').find((event) => event.action.target?.name === 'next session');
  const joined = rum.events('action').find((event) => event.action.target?.name === 'joins the next session');
  expect(next.session.id).not.toBe(one.session.id);
  expect(joined.session.id).toBe(next.session.id);
  expect(rum.views().some((view) => view.view.loading_type === 'session_renewal')).toBe(true);
  await other.close();
});

test('events queued while offline are sent when the connection comes back', async ({ page }) => {
  const rum = await start(page, { trackResources: false });
  rum.setFailing('network');

  await page.evaluate(async () => {
    window.rum.addAction('queued while offline');
    await window.rum.flush();
  });
  expect(rum.events('action')).toHaveLength(0);
  await expect
    .poll(() => page.evaluate(() => window.rum.getTransportStats().retried))
    .toBeGreaterThan(0);

  rum.setFailing(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(() => rum.events('action').some((event) => event.action.target.name === 'queued while offline'))
    .toBe(true);
  await expect.poll(() => page.evaluate(() => window.rum.getTransportStats().queued)).toBe(0);
});

test('IndexedDB restores unsent events after a reload and delivers them', async ({ page }) => {
  const rum = await start(page, {});
  rum.setFailing('network');

  await page.evaluate(async () => {
    window.rum.addAction('persist-across-reload');
    window.rum.addError(new Error('persist me too'));
    await window.rum.flush();
  });
  const firstViewId = await page.evaluate(() => window.rum.getInternalContext().view?.id);
  expect(firstViewId).toBeTruthy();
  // Give the transaction time to commit before the page goes away.
  await page.waitForTimeout(400);
  expect(rum.events()).toHaveLength(0);

  await page.reload();
  await page.waitForFunction(() => window.fixtureReady === true);
  rum.setFailing(false);
  await boot(page, {});

  await expect
    .poll(() => rum.events('action').some((event) => event.action.target.name === 'persist-across-reload'))
    .toBe(true);
  await expect
    .poll(() => rum.events('error').some((event) => event.error.message === 'persist me too'))
    .toBe(true);
  const restored = rum.events('action').find((event) => event.action.target.name === 'persist-across-reload');
  expect(restored.view.id).toBe(firstViewId);
  await expect.poll(() => rum.views().map((view) => view.view.id)).toContain(firstViewId);
  const stats = await page.evaluate(() => window.rum.getTransportStats());
  expect(stats.restored).toBeGreaterThanOrEqual(3);
});

test('rrweb records a masked full snapshot and the view says the session has a replay', async ({
  page,
}) => {
  const rum = await start(page, {
    sessionReplaySampleRate: 100,
    sessionSampleRate: 100,
    trackUserInteractions: false,
  });

  await page.locator(FIRST_BUTTON).click();
  await page.evaluate(() => {
    document.querySelector('#mutation-target').textContent = 'Changed';
  });
  await expect
    .poll(() => rum.replay().flatMap((segment) => segment.events).some((event) => event.type === 2))
    .toBe(true);

  const segments = rum.replay();
  const events = segments.flatMap((segment) => segment.events);
  expect(events.some((event) => event.type === 2)).toBe(true);
  expect(JSON.stringify(events)).not.toContain('super-secret-input-value');
  expect(segments[0]).toMatchObject({ seq: 1 });
  expect(segments[0].session_id).toBe(rum.events('view')[0].session.id);
  expect(segments.map((segment) => segment.seq)).toEqual(
    segments.map((_, index) => index + 1),
  );

  await expect
    .poll(async () => {
      await flush(page);
      return rum.views().at(-1)?.session.has_replay;
    })
    .toBe(true);
  const requests = rum.requests.filter((request) => request.kind === 'replay');
  expect(requests[0].url).toBe('http://127.0.0.1:4173/api/v1/rum/replay');
});

test('the browser bundle loads asynchronously, queues onReady callbacks and records replay', async ({
  page,
}) => {
  const rum = await start(page, null);
  await page.goto('/test/e2e/snippet.html');
  await page.waitForFunction(() => window.snippetReady === true);
  await page.locator('#go').click();
  await page.evaluate(() => MoleSignalRum.addAction('from the snippet'));

  await expect
    .poll(() => rum.events('action').some((event) => event.action.target.name === 'from the snippet'))
    .toBe(true);
  await expect
    .poll(() => rum.events('action').some((event) => event.action.type === 'click'))
    .toBe(true);
  const action = rum.events('action').find((event) => event.action.target.name === 'from the snippet');
  expect(action.usr.id).toBe('cdn-user');
  expect(action.application).toEqual({ id: 'cdn-e2e' });
  expect(action.sdk.name).toBe('molesignal-browser-rum');
  expect(await page.evaluate(() => typeof MoleSignalRum.getRum)).toBe('function');

  // rrweb is part of the bundle.
  await expect
    .poll(() => rum.replay().flatMap((segment) => segment.events).some((event) => event.type === 2))
    .toBe(true);
});

test('browser events have the shape of the browser fixtures', async ({ page, browserName }) => {
  test.skip(Boolean(contractSkipReason()), String(contractSkipReason()));
  const rum = await start(page, {
    user: { id: 'u-42' },
    env: 'prod',
    trackFrustrations: true,
    trackLongTasks: true,
  });
  await page.route('**/aborted-request', (route) => route.abort());

  await page.locator(BUTTON('dead-button')).click();
  const box = await page.locator(BUTTON('rage-button')).boundingBox();
  for (let click = 0; click < 3; click += 1) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await page.locator(BUTTON('fetch-button')).click();
  await expect(page.locator('#mutation-target')).toHaveText('loaded 200');
  await page.locator(BUTTON('error-button')).click();
  if (browserName === 'chromium') await page.locator(BUTTON('busy-button')).click();
  await page.evaluate(async () => {
    window.fixture.throwUncaught();
    window.fixture.throwWithCause();
    await window.fixture.failRequests();
    window.rum.addDurationVital('image_decode', { startTime: Date.now() - 80, duration: 30 });
  });
  await page.waitForTimeout(600);
  await flush(page);

  // What the comparison leaves out: other metrics, parts of a request that need a
  // real connection, things only some pages have, data that belongs to the application,
  // `artifact_kind` (the server takes a frame with a file and a line as a source map frame)
  // and `error.fingerprint` (the developer's choice: the SDK sets it only when addError gets one).
  const ignored = (path) =>
    /^(usr\.(name|email|plan)|account\.|context\.|feature_flags\.|device\.type|session\.has_replay|synthetics\.|ci_test\.)/.test(path) ||
    /^error\.(frames\[\]\.artifact_kind|fingerprint)$/.test(path) ||
    /^view\.(performance\.|custom_timings\.|crash)/.test(path) ||
    /^resource\.(dns|connect|ssl|response|request|graphql)/.test(path) ||
    /^connectivity\.(interfaces|effective_type)/.test(path) ||
    /^action\.(loading_time|long_task|resource)/.test(path) ||
    /^long_task\.(first_ui_event_timestamp|scripts\[\]\.(pause_duration|forced_style_and_layout_duration|source_function_name|source_char_position|window_attribution))/.test(path);

  const sdk = rum.events();
  const find = (type, predicate = () => true) =>
    sdk.find((event) => event.type === type && predicate(event));
  const compare = (fixture, event) => {
    expect(event, `the SDK emitted a ${fixture.type} event like the fixture`).toBeDefined();
    const problems = shapeProblems(
      fixture,
      event,
      (path) => ignored(path) || (fixture.type !== 'action' && path === 'action.id'),
    );
    expect(problems).toEqual([]);
  };

  const compared = new Set();
  for (const fixture of browserFixtures()) {
    switch (fixture.type) {
      case 'view':
        compare(fixture, rum.views()[0]);
        compared.add('view');
        break;
      case 'action':
        if (fixture.action.type === 'click') {
          compare(fixture, find('action', (event) => event.action.frustration?.type.includes('rage_click')));
          compared.add('click');
        } else {
          rum.events('action'); // custom actions are covered by the unit tests
        }
        break;
      case 'error': {
        const network = fixture.error.source === 'network';
        compare(
          fixture,
          find('error', (event) => (event.error.source === 'network') === network && (network || event.error.causes)),
        );
        compared.add(network ? 'network error' : 'error');
        break;
      }
      case 'resource':
        if (fixture.resource.type === 'fetch') {
          compare(
            fixture,
            find('resource', (event) => event.resource.type === 'fetch' && event.resource.first_byte),
          );
          compared.add('resource');
        }
        break;
      case 'long_task':
        if (browserName === 'chromium') {
          compare(fixture, find('long_task', (event) => event.long_task.scripts?.length > 0));
          compared.add('long_task');
        }
        break;
      case 'vital':
        if (fixture.vital.type === 'duration') {
          compare(fixture, find('vital'));
          compared.add('vital');
        }
        break;
      default:
        break;
    }
  }
  for (const expected of ['view', 'click', 'error', 'network error', 'resource', 'vital']) {
    expect(compared.has(expected), `${expected} was compared with its fixture`).toBe(true);
  }
});

test('a log goes with its session and view, and the console only when asked', async ({ page }) => {
  const rum = await start(page, { forwardConsoleLogs: ['warn'] });

  await page.evaluate(async () => {
    window.rum.logger.info('cart opened', { items: 3 });
    window.rum.logger.debug('below the level of a logger that takes everything');
    console.warn('forwarded to the logs');
    console.info('not forwarded');
    await window.rum.flush();
  });

  await expect.poll(() => rum.events('log').length).toBeGreaterThanOrEqual(2);

  const logs = rum.events('log');
  const messages = logs.map((event) => event.message);

  expect(messages).toContain('cart opened');
  expect(messages).toContain('forwarded to the logs');
  expect(messages).not.toContain('not forwarded');

  const view = rum.events('view')[0];

  for (const log of logs) {
    expect(log.session.id).toBe(view.session.id);
    expect(log.view.id).toBe(view.view.id);
  }
});

test('a click says where its element stands and where in it it landed, and a view how far down it went', async ({
  page,
}) => {
  const rum = await start(page, { trackUserInteractions: true });

  await page.evaluate(() => {
    const tall = document.createElement('div');

    tall.style.height = '4000px';
    document.body.append(tall);
  });

  await page.locator('#dead-button').click({ position: { x: 5, y: 5 } });
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.rum.flush());

  await expect.poll(() => rum.events('action').some((event) => event.action.type === 'click')).toBe(true);

  const { target, page_position: place } = rum.events('action').find((event) => event.action.type === 'click').action;

  expect(target.path).toMatch(/^body>main.*button/);
  expect(target.path).not.toContain('Does nothing');
  expect(target.offset.x).toBeGreaterThanOrEqual(4);
  expect(target.offset.y).toBeGreaterThanOrEqual(4);
  expect(place.x).toBeGreaterThan(0);

  await expect
    .poll(async () => {
      await flush(page);

      return rum.views().at(-1)?.view.scroll?.max_depth ?? 0;
    })
    .toBeGreaterThan(1500);

  expect(rum.views().at(-1).view.scroll.max_scroll_height).toBeGreaterThan(4000);
});

test('a test that drives the page marks the session, keeps it whatever is sampled, and is told its id', async ({
  page,
}) => {
  const rum = await start(page, null);

  await page.evaluate(() => {
    window.__MOLESIGNAL_TEST_CONTEXT__ = { type: 'synthetics', test_id: 'check-1', result_id: 'run-1', location_id: 'eu' };
  });
  await boot(page, { sessionSampleRate: 0 });
  await flush(page);

  await expect.poll(() => rum.events('view').length).toBeGreaterThan(0);

  const view = rum.events('view')[0];

  expect(view.session.type).toBe('synthetics');
  expect(view.synthetics).toEqual({ test_id: 'check-1', result_id: 'run-1', location_id: 'eu' });
  expect(await page.evaluate(() => window.__MOLESIGNAL_RUM_SESSION__)).toBe(view.session.id);
  expect(await page.evaluate(() => window.rum.getSessionReplayLink())).toBe(
    `http://127.0.0.1:4173/rum/sessions/view/${view.session.id}`,
  );
});

test('a part of a masked page marked as allowed shows its text, but not what is masked in it', async ({
  page,
}) => {
  await page.evaluate(() => {
    const part = document.createElement('section');

    part.setAttribute('data-molesignal-allow', '');
    part.innerHTML = '<p>Plainly public words</p><p data-molesignal-mask>Quietly private words</p><div contenteditable="true">Freshly typed words</div>';
    document.body.append(part);

    const outside = document.createElement('p');

    outside.textContent = 'Everything else stays hidden';
    document.body.append(outside);
  });

  const rum = await start(page, { sessionReplaySampleRate: 100, sessionSampleRate: 100, defaultPrivacyLevel: 'mask' });

  await expect
    .poll(() => rum.replay().flatMap((segment) => segment.events).some((event) => event.type === 2))
    .toBe(true);

  const recorded = JSON.stringify(rum.replay().flatMap((segment) => segment.events));

  expect(recorded).toContain('Plainly public words');
  expect(recorded).not.toContain('Quietly private words');
  expect(recorded).not.toContain('Freshly typed words');
  expect(recorded).not.toContain('Everything else stays hidden');
});

test('mask-user-input shows the page and hides what is typed', async ({
  page,
}) => {
  const rum = await start(page, { sessionReplaySampleRate: 100, sessionSampleRate: 100, defaultPrivacyLevel: 'mask-user-input' });

  await expect
    .poll(() => rum.replay().flatMap((segment) => segment.events).some((event) => event.type === 2))
    .toBe(true);

  const recorded = JSON.stringify(rum.replay().flatMap((segment) => segment.events));

  expect(recorded).toContain('Does nothing');
  expect(recorded).not.toContain('super-secret-input-value');
});
