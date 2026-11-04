# MoleSignal Browser RUM

The official browser Real User Monitoring SDK for MoleSignal. It reports page
views, user actions, frontend errors, network resources, long tasks, Web Vitals
and custom timings as MoleSignal RUM events, correlates browser requests with
backend traces through W3C `traceparent`, and optionally records privacy-aware
DOM session replay.

[简体中文](README.zh-CN.md)

> **0.4.0 takes only `mspat-` client tokens.** See
> [Upgrading from 0.3](#upgrading-from-03).

## Install

```bash
npm install @molesignal/browser-rum
```

or load the single-file browser bundle ([see below](#load-it-from-a-script-tag)).

Installing from npm needs Node 24 or later.

## Quick start

```ts
import { init } from '@molesignal/browser-rum';

const rum = init({
  applicationId: 'checkout-web',
  clientToken: 'mspat-your-client-token',
  site: 'https://molesignal.example.com',
  service: 'web-frontend',
  env: 'production',
  version: 'v1.4.0',
  sessionSampleRate: 100,
  trackUserInteractions: true,
});
```

`init` returns the client; `initRum` is the same function under its 0.1 name,
and `molesignalRum` is the same API as a singleton (`molesignalRum.init(...)`,
`molesignalRum.setUser(...)`, in the style of `datadogRum`).

`applicationId` and `clientToken` come from MoleSignal's **Data Sources →
Frontend RUM** setup guide. The token is bound to one application, and
`applicationId` is sent as `application.id`: the server rejects events whose
`application.id` differs from the application of the token.

The SDK writes to two endpoints, both with `Authorization: Bearer <clientToken>`:

| Endpoint | Body |
| --- | --- |
| `POST {site}/api/v1/rum/events` | A JSON array of events (at most 100 per request). The answer is `{ "accepted": n, "rejected": [{ "index": i, "reason": "…" }] }`. |
| `POST {site}/api/v1/rum/replay` | rrweb segments `{ sessionId, seq, events, service, env, version }`, only for sessions that record replay. `env` and `version` are left out when they are not set. They tell the server where the session runs, which the retention filters of the application may look at. |

`site` may be an origin, or end in `/api`, `/api/v1` or `/api/v1/rum`.

## Load it from a script tag

`dist/molesignal-rum.js` is a self-contained bundle (rrweb and web-vitals
included) that defines the global `MoleSignalRum`. Load it asynchronously with
this snippet; callbacks passed to `onReady` wait until the script has loaded:

```html
<script>
  (function (w, d, s, u, n) {
    w[n] = w[n] || { q: [], onReady: function (callback) { w[n].q.push(callback); } };
    var script = d.createElement(s);
    script.async = 1;
    script.src = u;
    d.head.appendChild(script);
  })(window, document, 'script', 'https://cdn.jsdelivr.net/npm/@molesignal/browser-rum@0.5.0/dist/molesignal-rum.js', 'MoleSignalRum');

  MoleSignalRum.onReady(function () {
    MoleSignalRum.init({
      applicationId: 'checkout-web',
      clientToken: 'mspat-your-client-token',
      site: 'https://molesignal.example.com',
      service: 'web-frontend',
      env: 'production',
      version: 'v1.4.0',
    });
  });
</script>
```

To load it synchronously, include the file in a `<script src>` tag and call
`MoleSignalRum.init(...)` afterwards. With the npm package, calls made to
`molesignalRum` before `init` (`setUser`, `addAction`, `startView`, …) are kept
and replayed by `init`.

## What is sent

Every event has the attributes the contract shares (`type`, `date` in epoch
milliseconds, `service`, `env`, `version`, `session`, `view`, `usr`, `account`,
`tab`, `connectivity`, `display`, `device`, `sdk`, `context`, `feature_flags`).
Durations, and times relative to the start of a view, are integer nanoseconds.

| Event | What it describes |
| --- | --- |
| `view` | One page view or route: loading type and time, navigation timings, `time_spent`, `is_active`, Web Vitals (`fcp`, `lcp`, `fid`, `inp`, `cls`, with the element and the sub-parts), custom timings, and cumulative `action`, `error`, `resource`, `long_task`, `frustration` counts. |
| `action` | A click (`target.name`, `target.selector`, `position`, `loading_time`, `frustration.type` of `rage_click`, `dead_click`, `error_click`) or a custom action. Resources, errors and long tasks that start while the action is running carry its `action.id` and are counted on it. |
| `resource` | A fetch, XHR, script, stylesheet, image, font or media request, or the page document: `type`, `method`, `status_code`, `duration`, sizes, `protocol`, `delivery_type`, `render_blocking_status`, the `redirect`, `dns`, `connect`, `ssl`, `first_byte` and `download` phases, and `trace_id` / `span_id`. |
| `error` | A runtime error, unhandled rejection, `console.error`, `addError` call, CSP violation, or failed request (`source: network`, with `error.resource`): `message`, `type`, `stack` as text, `frames` with `debug_id`, `handling`, `causes`. The SDK sets no `fingerprint`: the server groups errors itself (see [Group errors your own way](#group-errors-your-own-way)). |
| `long_task` | A long animation frame with the scripts that caused it, or a `longtask` entry where animation frames are not available. |
| `vital` | A duration measured with `startDurationVital` / `stopDurationVital` / `addDurationVital`. |

FCP, LCP and FID describe the page load and are reported on the initial view.
INP and CLS come from `web-vitals`, which measures them once per page load; the
SDK reports each on the view in which the decisive interaction or layout shift
happened. Elements (`target_selector`) follow the privacy level: with `mask` they
are structural selectors such as `img:nth-of-type(2)`.

### Views

A view is reported as soon as it starts, again with a higher `view.revision`
(at most every three seconds, while something in it changes), every five
minutes while it is open and visible, and one last time when it ends. A view
ends when the route changes, when the session ends, and when the page is hidden
or unloaded: the final version (`is_active: false`) is sent immediately with
`keepalive`. The counts are cumulative and `date` never changes. Sessions are
derived by the server from the views; the SDK sends no session event.

Route changes are detected from the History API and `popstate`; a change of the
path or of a route-style fragment (`#/orders`) is a new view, a change of the
query string alone is not. Set `trackViewsManually: true` and call `startView`
yourself to name views and decide where they begin. Events that arrive before
the first `startView` are placed in an implicit page-load view.

### Sessions

The session lives in the cookie `_msrum_s_<applicationId>`, so every tab of the
application shares it. It ends after 15 minutes without activity (clicks, key
presses, scrolling, touches, a view starting) or after four hours, and the next
user activity starts a new one. Each session is sampled once: `sessionSampleRate`
decides whether it is collected and `sessionReplaySampleRate` whether it records
replay; both are written to `sdk.session_sample_rate` and `sdk.replay_sample_rate`.
`stopSession()` ends the session for all tabs. Each tab has its own `tab.id`.
Every event carries `session.id` and `session.start` (epoch milliseconds at which
the session began), which the server uses to tell a new session from one it lost
track of. Without cookies a session lives in memory, per page.

```ts
init({ /* … */ trackSessionAcrossSubdomains: true }); // or sessionCookieDomain: '.example.com'
```

## Identify users and add application context

```ts
const rum = init({
  applicationId: 'checkout-web',
  clientToken: 'mspat-your-client-token',
  site: 'https://molesignal.example.com',
  user: { id: currentUser.id, plan: currentUser.plan },
  globalContext: { region: 'eu-west-1' },
});

rum.setUser({ id: 'user-42', name: 'Ada', email: 'ada@example.com' });
rum.setUserProperty('plan', 'enterprise');
rum.setAccount({ id: 'acme' });
rum.setGlobalContextProperty('checkout_step', 'payment');
```

`setUser` needs at least one of `id`, `name` and `email`; other keys are kept as
free-form properties. When no user is set the SDK uses a stable anonymous ID
(`usr.anonymous_id`, kept in `localStorage`); set `trackAnonymousUser: false` to
disable it. Context set with the setters is added to every later event; the
global context, the view context and the context of the call are merged, the
latter winning.

## Tracking consent

```ts
const rum = init({ /* … */ trackingConsent: 'not-granted' });

rum.setTrackingConsent('granted');
rum.setTrackingConsent('not-granted');
```

While consent is not granted, the SDK creates no cookie, anonymous ID or tab ID,
installs no instrumentation and sends nothing. Revoking consent stops
instrumentation and clears the SDK's identifiers and its persistent queue.

## Instrument by hand

```ts
rum.addAction('Checkout submitted', { cart_size: 3 });

try {
  await submitOrder();
} catch (error) {
  rum.addError(error, { component: 'CheckoutForm' });
}

// Views: with trackViewsManually, or to name a route.
rum.startView({ name: 'Order confirmation', service: 'payments', context: { step: 3 } });
rum.setViewName('Order confirmation (3DS)');
rum.setViewContextProperty('gateway', 'adyen');

// Custom timings and feature flags belong to the current view.
rum.addTiming('cart_ready');
rum.addFeatureFlagEvaluation('new_checkout', true);

// Durations.
const vital = rum.startDurationVital('checkout_form_ready', { description: 'form is usable' });
rum.stopDurationVital(vital);
rum.addDurationVital('image_decode', { startTime: performance.now() - 80, duration: 30 });

await rum.flush();
```

`addTiming(name, time?)` takes a `performance.now()` timestamp or epoch
milliseconds. Timing names are limited to `A-Za-z0-9_.@$-` (other characters
become `_`), at most 50 per view. The package is safe to import and initialize
during SSR: instrumentation starts only in a browser.

### Group errors your own way

The server groups errors itself, by type, message and the first frames of your
own code, so the SDK sets no `error.fingerprint`. Choose the grouping only when
that is not what you want: errors of one application that name the same
fingerprint are one issue, whatever their messages and stacks. Pass it as the
third argument of `addError`; it is sent as given, up to 128 characters.

```ts
rum.addError(error, { component: 'CheckoutForm' }, { fingerprint: 'checkout-payment-declined' });
```

Errors the SDK collects by itself (uncaught errors, unhandled rejections,
`console.error`, failed requests) can be given one in `beforeSend`. The SDK does
not shorten it there: keep it within 128 characters, or the server rejects the
event.

```ts
init({
  /* … */
  beforeSend(event) {
    if (event.type === 'error' && event.error.resource?.url) {
      // One issue per endpoint, whatever the ids in the path.
      const { pathname } = new URL(event.error.resource.url);
      event.error.fingerprint = `${event.error.resource.method} ${pathname.replace(/\d+/g, ':id')}`;
    }
  },
});
```

### The client

| Group | Methods |
| --- | --- |
| Start | `init`, `initRum`, `getRum`, `onReady` |
| User | `setUser`, `getUser`, `setUserProperty`, `removeUserProperty`, `clearUser` |
| Account | `setAccount`, `getAccount`, `setAccountProperty`, `removeAccountProperty`, `clearAccount` |
| Global context | `setGlobalContext`, `getGlobalContext`, `setGlobalContextProperty`, `removeGlobalContextProperty`, `clearGlobalContext` |
| Events | `addAction`, `addError`, `addTiming`, `addFeatureFlagEvaluation` |
| Views | `startView`, `setViewName`, `setViewContext`, `setViewContextProperty`, `getViewContext` |
| Vitals | `startDurationVital`, `stopDurationVital`, `addDurationVital` |
| Session | `stopSession`, `startSessionReplayRecording`, `stopSessionReplayRecording`, `getInternalContext` |
| Consent | `setTrackingConsent`, `getTrackingConsent` |
| Delivery | `flush`, `stop`, `getTransportStats` |

## Logs

Logs go to the stream `rum_logs` with the session and the view they were written in, so they show on the
session page and in the Logs explorer. Nothing is sent until you write a log or ask for the console.

```ts
import { molesignalRum } from '@molesignal/browser-rum';

molesignalRum.logger.info('cart opened', { items: 3 });

const payments = molesignalRum.createLogger({ name: 'payments', level: 'warn', context: { provider: 'stripe' } });
payments.error('payment declined', { code: 402 }, error);

// Also forward what the page writes to the console.
init({ /* … */ forwardConsoleLogs: ['warn', 'error'] });
```

Logs written before `init` wait for it. A session the application does not keep leaves no logs either.

## React

`@molesignal/browser-rum/react` makes the routes of a router the views of the SDK, named by their patterns
(`/orders/:id`, not `/orders/42`), and reports what a tree of components throws. React is an optional peer.

```tsx
import { init } from '@molesignal/browser-rum';
import { reactPlugin, RumErrorBoundary, trackReactRouter } from '@molesignal/browser-rum/react';

init({ /* … */ plugins: [reactPlugin()] });
trackReactRouter(router); // a router of createBrowserRouter; trackTanStackRouter for TanStack Router

root.render(
  <RumErrorBoundary fallback={<Oops />}>
    <RouterProvider router={router} />
  </RumErrorBoundary>,
);
```

## Feature flags

`addFeatureFlagEvaluation(key, value)` puts a flag on the events of the current view. To follow LaunchDarkly,
hand it the evaluations of an inspector; to follow OpenFeature, of an `after` hook:

```ts
LDClient.initialize(id, user, {
  inspectors: [{
    type: 'flag-used',
    name: 'molesignal',
    method: (key, detail) => molesignalRum.addFeatureFlagEvaluation(key, detail.value),
  }],
});

OpenFeature.addHooks({
  after: (context, details) => molesignalRum.addFeatureFlagEvaluation(context.flagKey, details.value),
});
```

## Tests that drive the page

A session is of type `user` unless `window.__MOLESIGNAL_TEST_CONTEXT__` says otherwise before the SDK starts:
MoleSignal's browser checks set it, and a test run can too (Playwright: `page.addInitScript`).

```ts
window.__MOLESIGNAL_TEST_CONTEXT__ = { type: 'ci_test', test_execution_id: 'run-1234' };
```

Such a session is not sampled, and the figures of the application leave it out unless asked for. The SDK sets
`window.__MOLESIGNAL_RUM_SESSION__` to the id of the session.

## Session replay

Replay is disabled by default. Enable sampled replay at initialization or start
it for the current session:

```ts
init({
  /* … */
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

Recording loads rrweb on demand, then captures full DOM snapshots and incremental
changes: pointer movement, clicks, scrolling, viewport changes and media state.
Stylesheets are inlined when accessible. `defaultPrivacyLevel: 'mask'` masks all
page text and everything typed; `mask-user-input` shows the text of the page and
masks what is typed and contenteditable areas; `allow` also shows what is typed,
but for passwords, e-mail addresses, telephone numbers and fields marked for
cards or one-time codes. Use the selectors to block sensitive subtrees, mask
selected text when text is allowed, or ignore noisy elements, and mark a part of
a masked page `data-molesignal-allow` to show its text. Fonts, inline images and cooperating
cross-origin iframes are opt-in because they can make recordings much larger.
Views report `session.has_replay: true` while the session records.

## Trace correlation

For allowed tracing URLs, the fetch and XMLHttpRequest integrations keep an
existing W3C `traceparent` or inject a new one, then read the trace context
from the request, the response or a `Server-Timing` metric named `traceparent`.
The trace id and the span id are written to `resource.trace_id` and
`resource.span_id` (the span id of the response when it is exposed, otherwise
the one the SDK sent), which lets MoleSignal connect a browser request to backend
traces.

For a cross-origin response, expose the correlation headers:

```http
Access-Control-Expose-Headers: traceparent, server-timing
```

By default, trace context is injected and read only for same-origin requests.
Use `allowedTracingUrls` to opt more origins in:

```ts
allowedTracingUrls: [
  'https://api.example.com',
  /^https:\/\/edge-\w+\.example\.com\//,
]
```

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `applicationId` | required | Application identifier of the client token; sent as `application.id` |
| `clientToken` | required | Application-bound RUM client token (`mspat-<36>`) |
| `site` | required | MoleSignal origin, or an `/api`, `/api/v1`, `/api/v1/rum` base |
| `service` | `applicationId` | `service` of the events |
| `env`, `version` | unset | Deployment dimensions; `version` is required for Source Map lookup |
| `debugId` | unset | Build debug ID, sent as `debug_id` on error frames |
| `user`, `account`, `globalContext` | unset | Initial identity and custom attributes |
| `trackingConsent` | `granted` | Start or defer all tracking and identifier creation |
| `sessionSampleRate` | `100` | Percentage of sessions collected |
| `sessionReplaySampleRate` | `0` | Percentage of collected sessions that record replay |
| `sessionReplay` | privacy-safe defaults | DOM recording selectors and optional capture controls |
| `sessionInactivityTimeout` | `900000` | Idle time after which a session ends (ms) |
| `maxSessionDuration` | `14400000` | Longest a session lasts (ms) |
| `sessionCookieDomain` | host only | Domain of the session cookie, for example `.example.com` |
| `trackSessionAcrossSubdomains` | `false` | Find the registrable domain and share the session across subdomains |
| `useCrossSiteSessionCookie` | `false` | `SameSite=None; Secure` cookie, for pages embedded in other sites |
| `trackUserInteractions` | `false` | Report clicks as actions |
| `trackFrustrations` | interaction setting | Detect rage, dead and error clicks |
| `trackResources` | `true` | Report fetch, XHR and resource timing, and inject `traceparent` |
| `trackLongTasks` | `true` | Report long animation frames and long tasks |
| `trackWebVitals` | `true` | Report FCP, LCP, FID, INP and CLS on the view |
| `trackViewsManually` | `false` | Disable automatic route-change views |
| `trackBfcacheViews` | `false` | Start a `bf_cache` view when a page is restored from the back/forward cache |
| `trackConsoleErrors` | `false` | Report `console.error` as errors |
| `trackAnonymousUser` | `true` | Create a persistent anonymous user ID |
| `trackUrlQueryString` | `false` | Keep query strings in reported URLs |
| `trackScroll` | `true` | Keep how far down the page each view goes |
| `trackResourceHeaders` | `[]` | Headers of a fetch or XHR to keep, by name or RegExp; credentials never are |
| `forwardConsoleLogs` | `[]` | Console methods that also write logs (`'all'`, or some of `debug`, `log`, `info`, `warn`, `error`) |
| `trackSdkErrors` | `true` | Say what goes wrong in the SDK as logs of the application, a few per page load |
| `defaultPrivacyLevel` | `mask` | `mask`, `mask-user-input` or `allow`: how much of what is on the page and typed into it is sent |
| `actionNameAttribute` | `data-molesignal-name` | Attribute that names an action target (used with `allow`) |
| `excludedUrls` | `[]` | String, RegExp or callback URL exclusions for requests |
| `allowedTracingUrls` | same origin | Requests that receive and contribute trace context |
| `traceSampleRate` | `100` | Percentage of the traces requests start that a back end is asked to keep (the W3C sampled flag) |
| `enablePersistentQueue` | `true` | Recover unsent telemetry from IndexedDB after a reload |
| `compressIntakeRequests` | `false` | Gzip the requests of events where the browser can |
| `remoteConfiguration` | `false` | Read the sample rates, privacy level and the like the application's settings decide before starting |
| `appUrl` | `site` | Where people open MoleSignal, for `getSessionReplayLink` |
| `plugins` | `[]` | What extends the SDK, such as `reactPlugin()` |
| `flushInterval`, `batchSize` | `5000`, `50` | When and how many events go in a request (batches are capped at 100) |
| `maxQueueSize` | `1000` | Events kept while offline |
| `retryBaseDelay`, `retryMaxDelay` | `1000`, `60000` | Exponential retry bounds; `Retry-After` is honored |
| `beforeSend` | unset | Inspect, modify or drop an event |
| `onError` | unset | Receive SDK diagnostics (failed uploads, rejected events, …) |
| `transport` | browser fetch | Send through your own proxy |

`replayFlushInterval` and `replayBatchSize` tune replay uploads.

### `beforeSend`

`beforeSend(event, { kind })` receives the contract event object, so it can
rewrite any field. Return `false` to drop the event; a `view` event cannot be
dropped, because its counts would stop adding up.

```ts
init({
  /* … */
  beforeSend(event) {
    if (event.type === 'resource') {
      event.resource.url = event.resource.url.replace(/\/users\/\d+/, '/users/:id');
    }
    if (event.type === 'error' && event.error.message.includes('ResizeObserver')) {
      return false;
    }
  },
});
```

`RumEvent` and the types of the six event bodies are exported.

## Delivery

Events are queued, sent in batches, and persisted in IndexedDB until the server
accepts them. A request is retried with exponential backoff and jitter after a
network error, `408`, `425`, `429` or `5xx`, honoring `Retry-After`. Events the
server **rejects** (it answers `rejected: [{ index, reason }]` for a request it
otherwise accepted) are not retried: they are reported through `onError` and
counted in `getTransportStats().droppedByReason.rejected`. Any other `4xx` drops
the batch. When the queue is full, resources go first, then long tasks, replay,
vitals, actions, errors and, last, views; a new event never displaces one that is
more important than itself. When the page goes away the most
important events are sent first, in one `keepalive` request.

Tabs of the same application share the IndexedDB queue without sending each
other's events twice: a tab takes over the rows of an earlier page load in the
same tab, and of tabs that have been gone for a few minutes.

`getTransportStats()` returns the queued, sent, restored, retried and dropped
counts, with the drop reasons.

## Privacy and token security

- URL query strings and fragments are removed by default (a view URL keeps a
  `#/route` fragment, without its query). Credentials in URLs are always removed.
- Keys such as `password`, `token`, `authorization`, `cookie` and `api_key` are
  redacted recursively in user, account and context data.
- With the default `mask` privacy level, action names are
  `Click <structural selector>`, selectors carry no ids, test ids or classes,
  and element selectors in vitals and long-task invokers are structural too.
  `allow` names actions from the name attribute, `aria-label`, `title` or text,
  and records richer selectors.
  `mask-user-input` does the same with what is on the page, and masks what is typed into it in a
  replay; `allow` also shows what is typed, but for passwords, e-mail addresses, telephone numbers and
  fields marked for cards or one-time codes. Mark a part of a masked page `data-molesignal-allow` to
  show its text, and `data-molesignal-mask` to mask it whatever the level.
- Stack traces are sent as text and as structured frames; file names in them
  follow the URL rules above.
- `clientToken` ships to the browser and must be treated as public. Never reuse
  an owner/admin, personal or default intake token; use the application-bound
  token created by the data-source guide. Every MoleSignal token starts with
  `mspat-`, so the SDK cannot tell them apart.

## Browser support

The bundle targets ES2020 and ships ESM, CommonJS, an IIFE bundle and
TypeScript declarations. Optional browser APIs (`PerformanceObserver`, long
animation frames, `MutationObserver`, IndexedDB, cookies) degrade independently
when unavailable. The end-to-end suite runs against Chromium, Firefox and
WebKit.

## Upgrading from 0.3

- **Client tokens.** `clientToken` takes the `mspat-<36>` format. A token of the old
  `msrum_<16>_<32>` format is refused when the SDK starts.
- **Server.** The new format needs a MoleSignal server that issues it. Create a new client token there.

## Upgrading from 0.2

- **`allow` shows what is typed.** `defaultPrivacyLevel: 'allow'` now records what is typed into a
  field, but for passwords, e-mail addresses, telephone numbers and card or one-time-code fields. To
  keep what `allow` did before, use `mask-user-input`.
- **Node 24.** `engines.node` is `>=24`. npm warns on an older Node, and a package manager that
  enforces `engines` refuses to install. What runs in the browser does not change.
- **Server.** Logs, heatmaps and test traffic need a MoleSignal server that knows them.

## Upgrading from 0.1

0.2.0 moves the SDK to the MoleSignal RUM event protocol. There is no
compatibility mode.

- **Endpoints.** `POST /api/v1/rum/sessions`, `/actions` and `/errors` are gone;
  everything goes to `POST /api/v1/rum/events`. Replay still goes to
  `/api/v1/rum/replay`, with the same body plus `service`, `env` and `version`. Custom `transport`s receive
  `kind: 'events' | 'replay'` (was `'session' | 'action' | 'error' | 'replay'`)
  and should return the response `body`, from which rejected events are read.
- **No session events.** The server derives sessions from views. `view` events
  are new and carry `view.id` and `view.revision`.
- **Different events.** Resources, long tasks and page views are events of their
  own, no longer actions with `type: 'resource' | 'long_task' | 'view'`. Rage and
  dead clicks are `action.frustration.type` on the click, no longer actions of
  their own. Form submissions are no longer reported. Web Vitals are on the
  `view`; the separate TTFB metric is `view.first_byte`.
- **`beforeSend`** receives these event objects, not the 0.1 flat records, and
  `context.kind` is the event type (`view`, `action`, `error`, `resource`,
  `long_task`, `vital`). Replay segments no longer pass through `beforeSend`.
- **Sessions** are stored in the cookie `_msrum_s_<applicationId>` and shared by
  tabs, not in `sessionStorage`. The default inactivity timeout is 15 minutes
  (was 30). Session, view and event ids are UUIDs.
- **`applicationId`** must be 1–128 characters of `A-Za-z0-9._:-`, and is sent
  as `application.id`; it must match the application of the token.
- **Browser, OS and device** are no longer collected by the SDK; the server
  derives them from the `User-Agent`. `language`, `timezone` and `viewport` are
  now `device.locale`, `device.time_zone` and `display.viewport`.
- **`trackViewsManually: true`** no longer means "no view at all": the first
  event or `startView` call starts the page-load view.
- **Errors** carry `stack` (text) and `frames` (structured, with `debug_id`),
  not `raw_stack`; their ids are UUIDs. The SDK no longer computes
  `error.fingerprint` (0.1 sent `fp_<hash>`): the server groups errors, and a
  fingerprint passed to `addError(error, context, { fingerprint })` overrides
  that. The 0.1 `parent_span_id` is `resource.span_id`.
- **User** objects may omit `id` if they have a `name` or `email`.
- Unsent events queued in IndexedDB by 0.1 are discarded on upgrade: they were
  addressed to endpoints that no longer exist.

## Development

```bash
npm run typecheck
npm test                 # build, unit tests, contract tests, type tests
npm run test:e2e:install
npm run test:e2e         # builds, then runs Playwright on Chromium, Firefox and WebKit
npm run build
```

The unit tests run in Node with a small fake browser and need Node 24 or
later (they use module mocking). The contract tests validate every event the SDK
sends, in the unit and in the end-to-end suite, against `v1.schema.json` of the
MoleSignal server, and compare the events with its `source: browser` fixtures.
The contract is read from `MOLESIGNAL_CONTRACTS` (default
`../molesignal/contracts/rum/events`); when it cannot be found those tests are
skipped, and say so. The Playwright suite exercises real rrweb recording,
resource timing, long animation frames, consent, cross-tab sessions and
IndexedDB recovery.
