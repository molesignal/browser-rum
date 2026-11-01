# Changelog

## 0.4.0

### Breaking changes

- `clientToken` takes the new token format, `mspat-<36>`. A token of the old `msrum_<16>_<32>` format
  is refused when the SDK starts. It needs a MoleSignal server that issues the new format.

## 0.3.0

### Added

- **Logs.** `logger`, `createLogger` and `forwardConsoleLogs` write `log` events to the stream
  `rum_logs`, with the session and the view they happen in. What goes wrong in the SDK is said the
  same way, a few per page load (`trackSdkErrors`).
- `getSessionReplayLink()` and `appUrl`, `setViewLoadingTime()`.
- **Heatmaps.** A view reports how far down the page it went (`view.scroll`, `trackScroll`); a click says
  where the element stands in the page and where in it the click landed (`action.target.path`,
  `action.target.offset`, `action.page_position`). A click on what is not a control is a click too.
- **Test traffic.** `window.__MOLESIGNAL_TEST_CONTEXT__` marks a session as `synthetics` or `ci_test`;
  such a session is not sampled, and its id is set on `window.__MOLESIGNAL_RUM_SESSION__`.
- `traceSampleRate`, `trackResourceHeaders`, `compressIntakeRequests`, `remoteConfiguration`, `plugins`, and
  `@molesignal/browser-rum/react` (`reactPlugin`, `trackReactRouter`, `trackTanStackRouter`,
  `RumErrorBoundary`, `addReactError`).
- The privacy level `mask-user-input`, and `data-molesignal-allow` for a part of a masked page.

### Changed

- `defaultPrivacyLevel: 'allow'` now shows what is typed into a field, but for passwords, e-mail
  addresses, telephone numbers and card or one-time-code fields. What `allow` did before is
  `mask-user-input`.
- `engines.node` is `>=24`. npm warns on an older Node, and a package manager that enforces `engines`
  refuses to install. What runs in the browser does not change.
- Logs, heatmaps and test traffic need a MoleSignal server that knows them.

## 0.2.0

The SDK now speaks the MoleSignal RUM event contract (`contracts/rum/events`).
It is not compatible with the 0.1 protocol and needs a server that serves
`POST /api/v1/rum/events`. The README has the migration details under
"Upgrading from 0.1".

### Breaking changes

- **One endpoint.** Events go to `POST {site}/api/v1/rum/events` as a JSON array
  (at most 100 per request). `/api/v1/rum/sessions`, `/actions` and `/errors` are
  no longer used; `/api/v1/rum/replay` keeps its body and adds the `service`,
  `env` and `version` of the configuration (`env` and `version` when set), so
  that the server can tell whether the application keeps the session. A custom
  `transport`
  receives `kind: 'events' | 'replay'` and should return the response `body`,
  from which the SDK reads the events the server rejected.
- **No session events.** The server derives sessions from `view` events. A session
  lives in the cookie `_msrum_s_<applicationId>`, shared by the tabs of the
  application, not in `sessionStorage`. The inactivity timeout is now 15 minutes
  (was 30); the four-hour limit is unchanged. Session, view and event ids are
  UUIDs.
- **New event model.** The actions, resources, long tasks and page views of 0.1
  are replaced by the contract's `view`, `action`, `error`, `resource`,
  `long_task` and `vital` events. `date` is epoch milliseconds; durations and
  times relative to the start of a view are integer nanoseconds. Rage and dead
  clicks are `action.frustration.type` on the click. Form submissions are no
  longer reported. Web Vitals are on the `view`; the TTFB metric is
  `view.first_byte`.
- **`beforeSend`** receives these event objects, not the 0.1 flat records, and
  `context.kind` is the event type. A `view` event cannot be dropped. Replay
  segments no longer pass through it.
- **`applicationId`** must be 1–128 characters of `A-Za-z0-9._:-` and is sent as
  `application.id`; it must match the application of the token.
- **Browser, OS and device** are no longer collected by the SDK; the server
  derives them from the `User-Agent`. `language`, `timezone` and `viewport` are
  now `device.locale`, `device.time_zone` and `display.viewport`.
- **`trackViewsManually: true`** no longer means "no view at all": the first
  event or `startView` call starts the page-load view.
- **Errors.**
  - `error.stack` is the stack as text and `error.frames` the structured frames,
    each with the build's `debug_id`; `raw_stack` is gone.
  - `error.fingerprint` is no longer set by the SDK (0.1 sent `fp_<hash>`): the
    server groups errors. Pass `fingerprint` in the third argument of `addError`
    to choose the grouping; it is sent as given, up to 128 characters. For the
    errors the SDK collects by itself, set `event.error.fingerprint` in
    `beforeSend`.
- **`parent_span_id`** of 0.1 is now `resource.span_id`.
- **User** objects may omit `id` when they have a `name` or `email`.
- A queue persisted in IndexedDB by 0.1 is discarded on upgrade: its events were
  addressed to endpoints that no longer exist.

### Added

- `view` events: `view.id`, `view.revision` (each report of a view is cumulative
  and has a higher revision; its start `date` never changes), `time_spent`,
  `is_active`, `loading_type`, navigation timings, `custom_timings`, cumulative
  `action`, `error`, `resource`, `long_task` and `frustration` counts, and Web
  Vitals (`fcp`, `lcp`, `fid`, `inp`, `cls`) with their elements and sub-parts. A
  view is reported when it starts, when it changes (at most every three
  seconds), every five minutes while it is visible, and once more, with
  `keepalive`, when it ends.
- Actions with `target`, `position`, `name_source` and `frustration`. Resources,
  errors and long tasks that start while an action is running carry its
  `action.id` and are counted on it.
- `resource` events with the `redirect`, `dns`, `connect`, `ssl`, `first_byte`
  and `download` phases, sizes, `protocol` and `delivery_type`, and `trace_id` /
  `span_id` for traced requests. A failed request also produces a network error
  with `error.resource`.
- `long_task` events from long animation frames, with the scripts behind them,
  and from `longtask` entries where animation frames are not available.
- `vital` events: `startDurationVital`, `stopDurationVital`, `addDurationVital`.
- `session.start` and `tab.id` on every event, the sample rates in
  `sdk.session_sample_rate` and `sdk.replay_sample_rate`, and `stopSession()`.
- The `molesignalRum` singleton (`init`, `setUser`, `addAction`, …) in the style
  of `datadogRum`; calls made before `init` are kept and replayed by it. `init`
  is the new name of `initRum`, which stays.
- `setUserProperty`, `removeUserProperty`, `setAccount` (with `getAccount`,
  `setAccountProperty`, `removeAccountProperty` and `clearAccount`),
  `clearGlobalContext`, `addTiming`, `addFeatureFlagEvaluation`, `setViewName`,
  `setViewContext`, `setViewContextProperty`, `getViewContext`, `onReady`, and
  `startView` with `name`, `service`, `version` and `context` options.
- `addError(error, context, { fingerprint })`.
- Options `account`, `trackBfcacheViews`, `sessionCookieDomain`,
  `trackSessionAcrossSubdomains` and `useCrossSiteSessionCookie`.
- A single-file browser bundle, `dist/molesignal-rum.js`, that defines the global
  `MoleSignalRum`, and an async snippet that queues calls until it has loaded.
- Delivery: events the server rejects are reported through `onError` and never
  retried (`getTransportStats().droppedByReason.rejected`); when the queue is full
  the least important events go first; a request holds at most 100 events and
  512 KiB; tabs share the IndexedDB queue without sending an event twice.
- Contract tests: every event the SDK sends in the tests is validated against
  `v1.schema.json` (`MOLESIGNAL_CONTRACTS`, default
  `../molesignal/contracts/rum/events`; skipped with a message when the contract
  is absent) and compared with the browser fixtures.

## 0.1.0-alpha.1

First release.
