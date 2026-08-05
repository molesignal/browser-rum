import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/fixture.html');
  await page.waitForFunction(() => window.fixtureReady === true);
});

test('consent, lifecycle, privacy, errors, and trace injection work in a real browser', async ({
  page,
}) => {
  const ingested = [];
  let traceparent;
  await page.route('**/api/v1/rum/**', async (route) => {
    const request = route.request();
    ingested.push({
      url: request.url(),
      body: request.postDataJSON(),
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/trace-target', async (route) => {
    traceparent = route.request().headers().traceparent;
    await route.fulfill({ status: 204 });
  });

  await page.evaluate(() => window.bootRum({ trackingConsent: 'not-granted' }));
  await page.waitForTimeout(350);
  expect(ingested).toHaveLength(0);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).concat(Object.keys(sessionStorage)),
    ),
  ).toEqual([]);

  await page.evaluate(() => window.rum.setTrackingConsent('granted'));
  await page.locator('button').click();
  await page.evaluate(async () => {
    window.rum.startView('Checkout');
    window.rum.addError(new Error('Browser E2E failure'));
    await fetch('/trace-target');
    await window.rum.flush();
  });

  await expect.poll(() => ingested.length).toBeGreaterThan(0);
  expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

  const actions = bodiesFor(ingested, 'actions');
  const click = actions.find((event) => event.type === 'click');
  expect(click.name).toBe('Click button');
  expect(click.payload.selector).toBe('button');
  expect(JSON.stringify(click)).not.toContain('alice@example.com');

  const error = bodiesFor(ingested, 'errors').find(
    (event) => event.message === 'Browser E2E failure',
  );
  expect(error.platform).toBe('web');
  const latestSession = bodiesFor(ingested, 'sessions').at(-1);
  expect(latestSession.view_count).toBe(1);
  expect(latestSession.error_count).toBe(1);
  expect(latestSession.last_page).toBe('/fixture.html');

  await page.evaluate(() => window.rum.setTrackingConsent('not-granted'));
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).concat(Object.keys(sessionStorage)),
    ),
  ).toEqual([]);
});

test('rrweb records a masked full snapshot', async ({ page }) => {
  const replay = [];
  await page.route('**/api/v1/rum/**', async (route) => {
    if (route.request().url().endsWith('/replay')) {
      replay.push(route.request().postDataJSON());
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.evaluate(() =>
    window.bootRum({
      sessionReplaySampleRate: 100,
      sessionSampleRate: 100,
    }),
  );
  await page.locator('button').click();
  await page.evaluate(() => {
    document.querySelector('#mutation-target').textContent = 'Changed';
  });
  await expect
    .poll(() =>
      replay.flatMap((segment) => segment.events).some((event) => event.type === 2),
    )
    .toBe(true);

  const events = replay.flatMap((segment) => segment.events);
  expect(events.some((event) => event.type === 2)).toBe(true);
  expect(JSON.stringify(events)).not.toContain('super-secret-input-value');
});

test('IndexedDB restores an offline action after reload', async ({ page }) => {
  let offline = true;
  const deliveredActions = [];
  await page.route('**/api/v1/rum/**', async (route) => {
    if (offline) {
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'offline' });
      return;
    }
    if (route.request().url().endsWith('/actions')) {
      deliveredActions.push(...route.request().postDataJSON());
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.evaluate(() => window.bootRum());
  await page.evaluate(async () => {
    window.rum.addAction('persist-across-reload');
    await window.rum.flush();
  });
  await page.reload();
  await page.waitForFunction(() => window.fixtureReady === true);
  offline = false;
  await page.evaluate(() => window.bootRum());

  await expect
    .poll(() => deliveredActions.some((event) => event.name === 'persist-across-reload'))
    .toBe(true);
});

function bodiesFor(requests, endpoint) {
  return requests
    .filter((request) => request.url.endsWith(`/${endpoint}`))
    .flatMap((request) => (Array.isArray(request.body) ? request.body : []));
}
