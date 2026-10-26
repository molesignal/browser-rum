import { contractViolations, sessionStartViolations } from '../support/contract.mjs';

/**
 * Stands in for the MoleSignal server: answers the RUM endpoints, keeps what
 * the SDK sent, and checks every event against the event contract (when the
 * contract is available).
 */
export async function collectRum(page, context = page.context()) {
  const state = {
    requests: [],
    violations: [],
    failing: false,
    echo: [],
  };

  const handler = async (route) => {
    const request = route.request();
    let body;
    try {
      body = request.postDataJSON();
    } catch {
      body = undefined;
    }
    if (state.failing === 'network') {
      await route.abort('internetdisconnected');
      return;
    }
    if (state.failing) {
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'unavailable' });
      return;
    }
    const kind = request.url().endsWith('/replay') ? 'replay' : 'events';
    state.requests.push({ url: request.url(), kind, body, headers: request.headers() });
    if (kind === 'events' && Array.isArray(body)) {
      state.violations.push(...contractViolations(body), ...sessionStartViolations(body));
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accepted: Array.isArray(body) ? body.length : 0, rejected: [] }),
    });
  };
  await context.route('**/api/v1/rum/**', handler);

  const events = (type) =>
    state.requests
      .filter((request) => request.kind === 'events' && Array.isArray(request.body))
      .flatMap((request) => request.body)
      .filter((event) => type === undefined || event.type === type);

  return {
    requests: state.requests,
    events,
    /** The highest revision of every view that was sent. */
    views() {
      const latest = new Map();
      for (const view of events('view')) {
        const known = latest.get(view.view.id);
        if (!known || view.view.revision >= known.view.revision) latest.set(view.view.id, view);
      }
      return [...latest.values()].sort((a, b) => a.date - b.date);
    },
    replay: () =>
      state.requests.filter((request) => request.kind === 'replay').map((request) => request.body),
    violations: () => state.violations,
    /**
     * Make the endpoints fail: `'network'` as when the browser is offline (the
     * request fails), `'status'` (or true) as when the server answers 503.
     */
    setFailing(value) {
      state.failing = value;
    },
  };
}

/** Boots the SDK in the fixture page; `overrides` must be JSON. */
export function boot(page, overrides = {}) {
  return page.evaluate((options) => window.bootRum(options), overrides);
}

export function flush(page) {
  return page.evaluate(() => window.rum.flush());
}

/** Pretends the page went to the background, the way `visibilitychange` does. */
export function hidePage(page) {
  return page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

export function showPage(page) {
  return page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

export function isInteger(value) {
  return Number.isInteger(value);
}
