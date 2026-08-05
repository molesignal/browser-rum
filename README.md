# MoleSignal Browser RUM

The official browser Real User Monitoring SDK for MoleSignal. It reports
sessions, page views, user actions, frontend errors, Web Vitals, network
resources, W3C trace correlation, and optional privacy-aware DOM session replay.

[简体中文](README.zh-CN.md)

## Install

```bash
npm install @molesignal/browser-rum
```

## Quick start

```ts
import { initRum } from '@molesignal/browser-rum';

const rum = initRum({
  applicationId: 'checkout-web',
  clientToken: 'msrum_your_client_token',
  site: 'https://molesignal.example.com',
  service: 'web-frontend',
  env: 'production',
  version: 'v1.4.0',
  sessionSampleRate: 100,
  trackUserInteractions: true,
});
```

This is the same API used by MoleSignal's **Data Sources → Frontend RUM**
setup guide. The SDK writes to:

- `POST /api/v1/rum/sessions`
- `POST /api/v1/rum/actions`
- `POST /api/v1/rum/errors`
- `POST /api/v1/rum/replay`

All requests use `Authorization: Bearer <clientToken>`.

## Identify users and add application context

Pass the initial user during initialization when possible, so the first session
row is associated with the correct user.

```ts
const rum = initRum({
  applicationId: 'checkout-web',
  clientToken: 'msrum_your_client_token',
  site: 'https://molesignal.example.com',
  user: {
    id: currentUser.id,
    plan: currentUser.plan,
  },
  globalContext: {
    region: 'eu-west-1',
  },
});

rum.setUser({ id: 'user-42', plan: 'enterprise' });
rum.setGlobalContextProperty('feature_flags', ['new-checkout']);
```

When no user is provided, the SDK creates a stable anonymous ID in
`localStorage`. Set `trackAnonymousUser: false` to disable this.

## Tracking consent

Set consent before initialization when a consent-management platform has not
yet granted analytics collection:

```ts
const rum = initRum({
  applicationId: 'checkout-web',
  clientToken: 'msrum_your_client_token',
  site: 'https://molesignal.example.com',
  trackingConsent: 'not-granted',
});

rum.setTrackingConsent('granted');
rum.setTrackingConsent('not-granted');
```

While consent is not granted, the SDK creates no anonymous ID or session,
installs no instrumentation, and sends no telemetry. Revoking consent stops
instrumentation and clears SDK identifiers plus the persistent upload queue.

## Manual instrumentation

```ts
rum.addAction('Checkout submitted', {
  cart_size: 3,
  payment_method: 'card',
});

try {
  await submitOrder();
} catch (error) {
  rum.addError(error, { component: 'CheckoutForm' });
}

// Use this when trackViewsManually is true.
rum.startView('Order confirmation');

await rum.flush();
```

The package is safe to import and initialize during SSR. Browser
instrumentation starts only when `window`, `document`, and `navigator` exist.

## Session replay

Replay is disabled by default. Enable sampled replay at initialization or start
it for the current sampled session:

```ts
const rum = initRum({
  applicationId: 'checkout-web',
  clientToken: 'msrum_your_client_token',
  site: 'https://molesignal.example.com',
  sessionSampleRate: 100,
  sessionReplaySampleRate: 20,
  sessionReplay: {
    blockSelector: '[data-molesignal-block]',
    maskTextSelector: '[data-molesignal-mask]',
    ignoreSelector: '[data-molesignal-ignore]',
  },
});

rum.startSessionReplayRecording();
rum.stopSessionReplayRecording();
```

Sampled replay sessions dynamically load rrweb, then record full DOM snapshots and incremental mutations,
including pointer movement, clicks, scrolling, viewport changes, and media
state. Stylesheets are inlined when accessible. All input and contenteditable
values are always masked; `defaultPrivacyLevel: 'mask'` additionally masks all page text. Use the
selectors above to block sensitive subtrees, mask selected text when visible
text is allowed, or ignore noisy elements. Font, inline-image, and cooperating
cross-origin iframe capture remain opt-in because they can
significantly increase recording size.

## Trace correlation

For allowed tracing URLs, the fetch and XMLHttpRequest integrations preserve an
existing W3C `traceparent` or inject a new one. They then read trace context from
the outgoing request, response, or a `Server-Timing` metric named `traceparent`.
The resulting `trace_id` and `parent_span_id` are stored on `rum_actions`, which
lets MoleSignal connect a browser request to backend traces.

For a cross-origin response, expose the correlation headers:

```http
Access-Control-Expose-Headers: traceparent, server-timing
```

By default, response trace context is read only for same-origin requests. Use
`allowedTracingUrls` to opt additional origins in:

```ts
allowedTracingUrls: [
  'https://api.example.com',
  /^https:\/\/edge-\w+\.example\.com\//,
]
```

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `applicationId` | required | Stable RUM application name |
| `clientToken` | required | Application-bound `msrum_` RUM client token |
| `site` | required | MoleSignal origin or `/api`/`/api/v1` base |
| `service` | `applicationId` | Service stored on actions and errors |
| `env`, `version` | unset | Deployment dimensions; `version` is required for Source Map lookup |
| `debugId` | unset | Optional build debug ID used to disambiguate Source Maps |
| `user`, `globalContext` | unset | Initial identity and custom dimensions |
| `trackingConsent` | `granted` | Start or defer all tracking and identifier creation |
| `sessionSampleRate` | `100` | Percentage of sessions collected |
| `sessionReplaySampleRate` | `0` | Percentage of sampled sessions with replay |
| `sessionReplay` | privacy-safe defaults | DOM recording selectors and optional capture controls |
| `trackUserInteractions` | `false` | Capture clicks and form submissions |
| `trackFrustrations` | interaction setting | Detect rage and dead clicks |
| `trackResources` | `true` | Capture fetch, XHR, and resource timing |
| `trackLongTasks` | `true` | Capture browser long tasks |
| `trackWebVitals` | `true` | Capture official LCP, CLS, TTFB, and INP metrics; retain FID when available |
| `trackViewsManually` | `false` | Disable automatic History API view tracking |
| `trackConsoleErrors` | `false` | Capture `console.error` in addition to runtime errors |
| `trackAnonymousUser` | `true` | Create a persistent anonymous user ID |
| `trackUrlQueryString` | `false` | Preserve query strings in reported URLs |
| `defaultPrivacyLevel` | `mask` | Allow or mask interaction labels/raw stacks |
| `excludedUrls` | `[]` | String, RegExp, or callback URL exclusions |
| `allowedTracingUrls` | same origin | Requests allowed to receive and contribute trace context |
| `enablePersistentQueue` | `true` | Recover unsent telemetry from IndexedDB after reload |
| `retryBaseDelay`, `retryMaxDelay` | `1000`, `60000` | Exponential retry bounds; server `Retry-After` is honored |
| `beforeSend` | unset | Inspect, modify, or return `false` to drop an event |
| `onError` | unset | Receive SDK transport/configuration diagnostics |
| `transport` | browser fetch | Route uploads through a custom proxy transport |

Batch sizes, flush intervals, queue limits, and session timeouts are also
configurable and fully typed through `RumInitConfiguration`.

`rum.getTransportStats()` exposes queued, sent, restored, retried, and dropped
counts, including drop reasons. Session summaries are refreshed with duration,
view/action/error counts, and the last page during flush, backgrounding,
session rotation, and shutdown.

## Privacy and token security

- URL query strings and fragments are removed by default.
- Keys such as `password`, `token`, `authorization`, `cookie`, and `api_key`
  are redacted recursively.
- Interaction text, ARIA labels, raw error stacks, DOM contents, and input
  values are not collected with the default `mask` privacy level.
- Default interaction selectors omit IDs, test IDs, classes, and custom names.
- `clientToken` is shipped to the browser and must be treated as public.
  Never reuse an owner/admin, personal, or default ingestion token. Use the
  application-bound `msrum_` client token created by the data-source guide.

## Browser support

The distributed bundle targets ES2020 and ships ESM, CommonJS, and TypeScript
declarations. Optional browser APIs such as `PerformanceObserver`,
`MutationObserver`, and persistent storage degrade independently when
unavailable. The E2E suite runs against Chromium, Firefox, and WebKit.

## Development

```bash
npm run typecheck
npm test
npm run test:e2e:install
npm run test:e2e
npm run build
```

`npm test` verifies the public API, SSR behavior, MoleSignal ingest payloads,
replay segmentation, privacy redaction, and W3C trace correlation. The
Playwright suite additionally exercises real rrweb recording, consent,
cross-browser transport, and IndexedDB recovery.
