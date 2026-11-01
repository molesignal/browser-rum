# MoleSignal Browser RUM

MoleSignal 官方浏览器端 Real User Monitoring SDK。它把页面视图、用户操作、前端错误、
网络资源、长任务、Web Vitals 和自定义耗时作为 MoleSignal RUM 事件上报，通过 W3C
`traceparent` 把浏览器请求与后端链路关联起来，并可选地提供注重隐私的 DOM 会话回放。

[English](README.md)

> **0.3.0 改变了 `allow` 录制的内容，安装需要 Node 24。** 详见[从 0.2 升级](#从-02-升级)。

## 安装

```bash
npm install @molesignal/browser-rum
```

也可以直接加载单文件浏览器包（见[脚本标签加载](#脚本标签加载)）。

通过 npm 安装需要 Node 24 及以上。

## 快速开始

```ts
import { init } from '@molesignal/browser-rum';

const rum = init({
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

`init` 返回客户端；`initRum` 是同一个函数的 0.1 旧名；`molesignalRum` 是同一套 API 的单例
形式（`molesignalRum.init(...)`、`molesignalRum.setUser(...)`，与 `datadogRum` 风格一致）。

`applicationId` 与 `clientToken` 来自 MoleSignal「数据源 → 前端 RUM」接入向导。令牌绑定
一个应用，`applicationId` 会作为 `application.id` 上报：事件里的 `application.id` 与令牌所属
应用不一致时，服务端会拒收。

SDK 写入两个端点，均携带 `Authorization: Bearer <clientToken>`：

| 端点 | 请求体 |
| --- | --- |
| `POST {site}/api/v1/rum/events` | 事件 JSON 数组（每次最多 100 条）。应答为 `{ "accepted": n, "rejected": [{ "index": i, "reason": "…" }] }`。 |
| `POST {site}/api/v1/rum/replay` | rrweb 分段 `{ session_id, seq, events, service, env, version }`，仅记录回放的会话才会发送；`env`、`version` 未设置时不带。服务端靠它们知道会话在哪里运行，应用的保留过滤器可能按它们决定是否保留。 |

`site` 可以是源站地址，也可以以 `/api`、`/api/v1` 或 `/api/v1/rum` 结尾。

## 脚本标签加载

`dist/molesignal-rum.js` 是自包含的单文件包（已内置 rrweb 与 web-vitals），定义全局变量
`MoleSignalRum`。用下面的片段异步加载；传给 `onReady` 的回调会排队，等脚本加载完成后按顺序执行：

```html
<script>
  (function (w, d, s, u, n) {
    w[n] = w[n] || { q: [], onReady: function (callback) { w[n].q.push(callback); } };
    var script = d.createElement(s);
    script.async = 1;
    script.src = u;
    d.head.appendChild(script);
  })(window, document, 'script', 'https://cdn.jsdelivr.net/npm/@molesignal/browser-rum@0.3.0/dist/molesignal-rum.js', 'MoleSignalRum');

  MoleSignalRum.onReady(function () {
    MoleSignalRum.init({
      applicationId: 'checkout-web',
      clientToken: 'msrum_your_client_token',
      site: 'https://molesignal.example.com',
      service: 'web-frontend',
      env: 'production',
      version: 'v1.4.0',
    });
  });
</script>
```

需要同步加载时，用 `<script src>` 引入该文件，再调用 `MoleSignalRum.init(...)`。使用 npm
包时，在 `init` 之前对 `molesignalRum` 发起的调用（`setUser`、`addAction`、`startView` 等）会被
保存，并在 `init` 时回放。

## 上报内容

所有事件都带有契约规定的公共属性（`type`、毫秒级 `date`、`service`、`env`、`version`、
`session`、`view`、`usr`、`account`、`tab`、`connectivity`、`display`、`device`、`sdk`、
`context`、`feature_flags`）。时长以及相对于 view 开始的时间都是整数纳秒。

| 事件 | 含义 |
| --- | --- |
| `view` | 一次页面视图或路由：加载类型与耗时、导航时序、`time_spent`、`is_active`、Web Vitals（`fcp`、`lcp`、`fid`、`inp`、`cls`，含元素与分段）、自定义耗时，以及累计的 `action`、`error`、`resource`、`long_task`、`frustration` 计数。 |
| `action` | 一次点击（`target.name`、`target.selector`、`position`、`loading_time`，`frustration.type` 取 `rage_click`、`dead_click`、`error_click`）或自定义操作。操作进行期间开始的资源、错误和长任务会带上它的 `action.id`，并计入它的计数。 |
| `resource` | 一次 fetch、XHR、脚本、样式、图片、字体、媒体请求，或页面文档本身：`type`、`method`、`status_code`、`duration`、大小、`protocol`、`delivery_type`、`render_blocking_status`，`redirect`、`dns`、`connect`、`ssl`、`first_byte`、`download` 各阶段，以及 `trace_id` / `span_id`。 |
| `error` | 运行时错误、未处理的 rejection、`console.error`、`addError` 调用、CSP 违规，或失败的请求（`source: network`，带 `error.resource`）：`message`、`type`、文本 `stack`、带 `debug_id` 的 `frames`、`handling`、`causes`。SDK 不设置 `fingerprint`：错误由服务端自行聚合（见[自定义错误聚合](#自定义错误聚合)）。 |
| `long_task` | 长动画帧及造成它的脚本；不支持长动画帧的浏览器回退为 `longtask` 条目。 |
| `vital` | 用 `startDurationVital` / `stopDurationVital` / `addDurationVital` 测得的一段时长。 |

FCP、LCP、FID 描述页面加载，记在初始 view 上。INP 与 CLS 来自 `web-vitals`，它对每次页面加载
只测一次；SDK 把它们记在决定性的交互或布局偏移发生的那个 view 上。元素（`target_selector`）
遵循隐私级别：`mask` 时是 `img:nth-of-type(2)` 这样的结构化选择器。

### View

view 在开始时立即上报；之后只要其中有变化就以更高的 `view.revision` 再次上报（至多每三秒一次）；
打开且可见时每五分钟上报一次；结束时再报最后一版。view 在路由变化、会话结束、页面隐藏或
卸载时结束：最后一版（`is_active: false`）会立即用 `keepalive` 发出。计数是累计值，`date` 恒为
view 开始时间。会话由服务端根据 view 派生，SDK 不发送 session 事件。

路由变化通过 History API 与 `popstate` 检测：路径或路由式片段（`#/orders`）变化会产生新的
view，仅查询串变化不会。设置 `trackViewsManually: true` 并自行调用 `startView`，可以命名
view 并决定它从哪里开始；第一次 `startView` 之前到达的事件归入一个隐式的页面加载 view。

### 会话

会话存放在 cookie `_msrum_s_<applicationId>` 中，应用的所有标签页共享。15 分钟没有活动
（点击、按键、滚动、触摸、新 view 开始）或满四小时即结束，下一次用户活动会开启新会话。
每个会话只抽样一次：`sessionSampleRate` 决定是否采集，`sessionReplaySampleRate` 决定是否
录制回放，二者写入 `sdk.session_sample_rate` 与 `sdk.replay_sample_rate`。`stopSession()` 会
让所有标签页的会话结束。每个标签页有自己的 `tab.id`。每个事件都带 `session.id` 和
`session.start`（会话开始的毫秒级 epoch），服务端用后者区分刚开始的新会话和丢了状态的老会话。
没有 cookie 时，会话仅保存在内存里（按页面）。

```ts
init({ /* … */ trackSessionAcrossSubdomains: true }); // 或 sessionCookieDomain: '.example.com'
```

## 用户与自定义上下文

```ts
const rum = init({
  applicationId: 'checkout-web',
  clientToken: 'msrum_your_client_token',
  site: 'https://molesignal.example.com',
  user: { id: currentUser.id, plan: currentUser.plan },
  globalContext: { region: 'cn-east-1' },
});

rum.setUser({ id: 'user-42', name: 'Ada', email: 'ada@example.com' });
rum.setUserProperty('plan', 'enterprise');
rum.setAccount({ id: 'acme' });
rum.setGlobalContextProperty('checkout_step', 'payment');
```

`setUser` 至少要有 `id`、`name`、`email` 之一，其余键作为自由属性保留。没有用户时，SDK 使用
稳定的匿名 ID（`usr.anonymous_id`，存于 `localStorage`），可用 `trackAnonymousUser: false`
关闭。通过 setter 设置的上下文会附加到之后的每个事件；全局上下文、view 上下文和调用时
传入的上下文会合并，后者优先。

## Tracking Consent

```ts
const rum = init({ /* … */ trackingConsent: 'not-granted' });

rum.setTrackingConsent('granted');
rum.setTrackingConsent('not-granted');
```

未授权期间，SDK 不创建 cookie、匿名 ID 或标签页 ID，不安装采集监听器，也不发送任何数据。
撤回授权会停止采集，并清除 SDK 的标识符与持久化队列。

## 手动埋点

```ts
rum.addAction('Checkout submitted', { cart_size: 3 });

try {
  await submitOrder();
} catch (error) {
  rum.addError(error, { component: 'CheckoutForm' });
}

// View：trackViewsManually 时使用，或用来给路由命名。
rum.startView({ name: 'Order confirmation', service: 'payments', context: { step: 3 } });
rum.setViewName('Order confirmation (3DS)');
rum.setViewContextProperty('gateway', 'adyen');

// 自定义耗时与 feature flag 属于当前 view。
rum.addTiming('cart_ready');
rum.addFeatureFlagEvaluation('new_checkout', true);

// 时长。
const vital = rum.startDurationVital('checkout_form_ready', { description: 'form is usable' });
rum.stopDurationVital(vital);
rum.addDurationVital('image_decode', { startTime: performance.now() - 80, duration: 30 });

await rum.flush();
```

`addTiming(name, time?)` 的 `time` 可以是 `performance.now()` 时间戳或毫秒级 epoch。耗时名称
只允许 `A-Za-z0-9_.@$-`（其它字符会被替换为 `_`），每个 view 最多 50 个。包在 SSR 中可安全
导入和初始化：只有在浏览器里才会启动采集。

### 自定义错误聚合

服务端会按类型、消息和你自己代码里最靠前的几帧自行聚合错误，所以 SDK 不设置
`error.fingerprint`。只有默认聚合不合你意时才需要指定：同一应用里 fingerprint 相同的错误就是
同一个问题，不论消息和堆栈是否相同。把它放在 `addError` 的第三个参数里，SDK 原样发送，最长
128 个字符。

```ts
rum.addError(error, { component: 'CheckoutForm' }, { fingerprint: 'checkout-payment-declined' });
```

SDK 自己采集的错误（未捕获错误、未处理的 rejection、`console.error`、失败的请求）可以在
`beforeSend` 里设置。SDK 不会在这里截断：请控制在 128 个字符以内，否则服务端会拒收该事件。

```ts
init({
  /* … */
  beforeSend(event) {
    if (event.type === 'error' && event.error.resource?.url) {
      // 每个接口一个问题，路径里的 ID 不再拆分。
      const { pathname } = new URL(event.error.resource.url);
      event.error.fingerprint = `${event.error.resource.method} ${pathname.replace(/\d+/g, ':id')}`;
    }
  },
});
```

### 客户端 API

| 分组 | 方法 |
| --- | --- |
| 启动 | `init`、`initRum`、`getRum`、`onReady` |
| 用户 | `setUser`、`getUser`、`setUserProperty`、`removeUserProperty`、`clearUser` |
| 账户 | `setAccount`、`getAccount`、`setAccountProperty`、`removeAccountProperty`、`clearAccount` |
| 全局上下文 | `setGlobalContext`、`getGlobalContext`、`setGlobalContextProperty`、`removeGlobalContextProperty`、`clearGlobalContext` |
| 事件 | `addAction`、`addError`、`addTiming`、`addFeatureFlagEvaluation` |
| View | `startView`、`setViewName`、`setViewContext`、`setViewContextProperty`、`getViewContext` |
| 时长 | `startDurationVital`、`stopDurationVital`、`addDurationVital` |
| 会话 | `stopSession`、`startSessionReplayRecording`、`stopSessionReplayRecording`、`getInternalContext` |
| 授权 | `setTrackingConsent`、`getTrackingConsent` |
| 发送 | `flush`、`stop`、`getTransportStats` |

## 日志

日志写进 `rum_logs` 流，带着写下它时的会话和页面，所以在会话页和日志探索器里都能看到。只有你写日志或者要求转发控制台时才会发送。

```ts
import { molesignalRum } from '@molesignal/browser-rum';

molesignalRum.logger.info('打开购物车', { items: 3 });

const payments = molesignalRum.createLogger({ name: 'payments', level: 'warn', context: { provider: 'stripe' } });
payments.error('支付被拒', { code: 402 }, error);

// 同时转发页面写到控制台的内容。
init({ /* … */ forwardConsoleLogs: ['warn', 'error'] });
```

`init` 之前写的日志会等到 `init`。应用不保留的会话也不留日志。

## React

`@molesignal/browser-rum/react` 把路由器的路由变成 SDK 的视图，按路由模式命名（`/orders/:id`，不是 `/orders/42`），并上报组件树抛出的错误。React 是可选的 peer 依赖。

```tsx
import { init } from '@molesignal/browser-rum';
import { reactPlugin, RumErrorBoundary, trackReactRouter } from '@molesignal/browser-rum/react';

init({ /* … */ plugins: [reactPlugin()] });
trackReactRouter(router); // createBrowserRouter 创建的路由器；TanStack Router 用 trackTanStackRouter

root.render(
  <RumErrorBoundary fallback={<Oops />}>
    <RouterProvider router={router} />
  </RumErrorBoundary>,
);
```

## 功能开关

`addFeatureFlagEvaluation(key, value)` 把开关放到当前视图的事件上。跟随 LaunchDarkly 用 inspector，跟随 OpenFeature 用 `after` hook：

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

## 测试驱动的页面

会话默认是 `user` 类型，除非 SDK 启动前 `window.__MOLESIGNAL_TEST_CONTEXT__` 另有说明：MoleSignal 的浏览器拨测会设置它，测试运行也可以设置（Playwright 用 `page.addInitScript`）。

```ts
window.__MOLESIGNAL_TEST_CONTEXT__ = { type: 'ci_test', test_execution_id: 'run-1234' };
```

这样的会话不会被采样掉，应用的统计默认也不算它。SDK 把会话 ID 写到 `window.__MOLESIGNAL_RUM_SESSION__`。

## 会话回放

回放默认关闭，可按采样率启用，或为当前会话手动开启：

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

录制时按需加载 rrweb，记录 DOM 全量快照与增量变化，包括鼠标移动、点击、滚动、视口变化和
媒体状态；可访问的样式表会内联。`defaultPrivacyLevel: 'mask'` 遮罩全部页面文本和输入内容；
`mask-user-input` 显示页面文本，遮罩输入内容和可编辑区域；`allow` 也显示输入内容，但密码、邮箱、
电话以及标记为银行卡或一次性验证码的字段除外。给被遮罩页面的一部分加 `data-molesignal-allow` 可以显示它的文本。可以用上述选择器阻止敏感子树、在允许普通文本时单独遮罩
指定区域，或忽略高噪声元素。字体、内联图片以及协作式跨域 iframe 默认关闭，因为它们会显著
增大录制体积。会话正在录制时，view 会带上 `session.has_replay: true`。

## Trace 关联

对允许关联的 URL，fetch 与 XMLHttpRequest 插件会保留已有的 W3C `traceparent`，缺失时自动
注入，然后从请求、响应或名为 `traceparent` 的 `Server-Timing` 指标中读取上下文。trace id 与
span id 写入 `resource.trace_id`、`resource.span_id`（响应里暴露了 traceparent 时用响应的
span id，否则用 SDK 发出的那个），MoleSignal 据此把浏览器请求与后端链路关联起来。

跨域响应需要暴露相关响应头：

```http
Access-Control-Expose-Headers: traceparent, server-timing
```

默认只对同源请求注入和读取 trace 上下文；用 `allowedTracingUrls` 增加允许的来源：

```ts
allowedTracingUrls: [
  'https://api.example.com',
  /^https:\/\/edge-\w+\.example\.com\//,
]
```

## 配置

| 选项 | 默认值 | 作用 |
| --- | --- | --- |
| `applicationId` | 必填 | 令牌所属应用的标识；作为 `application.id` 上报 |
| `clientToken` | 必填 | 与应用绑定的 `msrum_` Client Token |
| `site` | 必填 | MoleSignal 源站地址，或 `/api`、`/api/v1`、`/api/v1/rum` 前缀 |
| `service` | `applicationId` | 事件的 `service` |
| `env`、`version` | 未设置 | 部署维度；Source Map 查找需要 `version` |
| `debugId` | 未设置 | 构建 Debug ID，作为错误栈帧的 `debug_id` 上报 |
| `user`、`account`、`globalContext` | 未设置 | 初始身份与自定义属性 |
| `trackingConsent` | `granted` | 启动或推迟全部采集与标识符创建 |
| `sessionSampleRate` | `100` | 会话采集百分比 |
| `sessionReplaySampleRate` | `0` | 已采集会话中录制回放的百分比 |
| `sessionReplay` | 隐私安全默认值 | DOM 录制选择器与可选采集项 |
| `sessionInactivityTimeout` | `900000` | 会话的空闲过期时间（毫秒） |
| `maxSessionDuration` | `14400000` | 会话最长持续时间（毫秒） |
| `sessionCookieDomain` | 仅当前主机 | 会话 cookie 的域，例如 `.example.com` |
| `trackSessionAcrossSubdomains` | `false` | 自动查找可注册域名，让子域名共享会话 |
| `useCrossSiteSessionCookie` | `false` | 使用 `SameSite=None; Secure` cookie，用于被其它站点嵌入的页面 |
| `trackUserInteractions` | `false` | 把点击上报为 action |
| `trackFrustrations` | 跟随交互设置 | 检测愤怒点击、无效点击和报错点击 |
| `trackResources` | `true` | 上报 fetch、XHR 与资源时序，并注入 `traceparent` |
| `trackLongTasks` | `true` | 上报长动画帧与长任务 |
| `trackWebVitals` | `true` | 在 view 上报告 FCP、LCP、FID、INP、CLS |
| `trackViewsManually` | `false` | 关闭自动的路由 view |
| `trackBfcacheViews` | `false` | 页面从前进/后退缓存恢复时开启 `bf_cache` view |
| `trackConsoleErrors` | `false` | 把 `console.error` 上报为错误 |
| `trackAnonymousUser` | `true` | 创建持久化匿名用户 ID |
| `trackUrlQueryString` | `false` | 在上报的 URL 中保留查询串 |
| `trackScroll` | `true` | 记录每个视图往下看到多远 |
| `trackResourceHeaders` | `[]` | 保留 fetch、XHR 的哪些请求头和响应头（名称或正则）；凭据从不保留 |
| `forwardConsoleLogs` | `[]` | 哪些 console 方法同时写日志（`'all'`，或 `debug`、`log`、`info`、`warn`、`error` 的子集） |
| `trackSdkErrors` | `true` | 把 SDK 自身的问题写成应用的日志，每次页面加载最多几条 |
| `defaultPrivacyLevel` | `mask` | `mask`、`mask-user-input` 或 `allow`：页面内容和输入内容上报多少 |
| `compressIntakeRequests` | `false` | 浏览器支持时 gzip 压缩事件请求 |
| `remoteConfiguration` | `false` | 启动前读取应用设置决定的采样率、隐私级别等 |
| `appUrl` | `site` | MoleSignal 的访问地址，给 `getSessionReplayLink` 用 |
| `plugins` | `[]` | 扩展 SDK 的插件，比如 `reactPlugin()` |
| `actionNameAttribute` | `data-molesignal-name` | 给操作目标命名的属性（配合 `allow`） |
| `excludedUrls` | `[]` | 排除请求的字符串、RegExp 或回调 |
| `allowedTracingUrls` | 同源 | 允许注入并读取 trace 上下文的请求 |
| `traceSampleRate` | `100` | 请求发起的 trace 中，要求后端保留的百分比（W3C sampled 标志） |
| `enablePersistentQueue` | `true` | 刷新后从 IndexedDB 恢复未发送数据 |
| `flushInterval`、`batchSize` | `5000`、`50` | 发送时机与每次请求的事件数（上限 100） |
| `maxQueueSize` | `1000` | 离线时保留的事件数 |
| `retryBaseDelay`、`retryMaxDelay` | `1000`、`60000` | 指数退避上下限，遵守 `Retry-After` |
| `beforeSend` | 未设置 | 检查、修改或丢弃事件 |
| `onError` | 未设置 | 接收 SDK 诊断信息（上传失败、事件被拒等） |
| `transport` | 浏览器 fetch | 通过自己的代理发送 |

`replayFlushInterval` 与 `replayBatchSize` 用于调整回放上传。

### `beforeSend`

`beforeSend(event, { kind })` 拿到的是契约事件对象，可以改写任意字段；返回 `false` 丢弃该
事件。`view` 事件不能丢弃，否则计数对不上。

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

`RumEvent` 以及六类事件主体的类型均已导出。

## 发送可靠性

事件先入队，批量发送，并在服务端接受之前持久化在 IndexedDB 里。网络错误、`408`、`425`、
`429`、`5xx` 会按带抖动的指数退避重试，并遵守 `Retry-After`。被服务端**拒收**的事件（请求整体
被接受，应答里 `rejected: [{ index, reason }]` 指出的那些）不会重试：它们通过 `onError` 报告，
并计入 `getTransportStats().droppedByReason.rejected`。其它 `4xx` 会丢弃整批。队列满时，先丢
资源，再依次是长任务、回放、vital、action、error，最后才是 view；新事件不会挤掉比它
更重要的事件。页面即将离开时，最重要的
事件会先发，并放在同一个 `keepalive` 请求里。

同一应用的多个标签页共享 IndexedDB 队列，但不会重复发送彼此的事件：标签页只接管自己上一次
页面加载留下的行，以及已消失数分钟的其它标签页留下的行。

`getTransportStats()` 返回排队、发送、恢复、重试和丢弃数量，以及丢弃原因。

## 隐私与令牌安全

- 默认移除 URL 的查询串和片段（view 的 URL 会保留 `#/route` 形式的路由片段，但去掉其中的
  查询）。URL 中的用户名密码一律移除。
- 用户、账户和上下文数据里的 `password`、`token`、`authorization`、`cookie`、`api_key` 等
  键会被递归脱敏。
- 默认的 `mask` 隐私级别下，操作名称为 `Click <结构化选择器>`，选择器不含 id、test id 或
  class；vital 与长任务 invoker 中的元素选择器同样只保留结构。`allow` 则按名称属性、
  `aria-label`、`title` 或文本给操作命名，并记录更丰富的选择器。
- 栈既以文本也以结构化帧上报；其中的文件名遵循上面的 URL 规则。
- `clientToken` 会随前端代码下发，必须视为公开凭证。不要复用 Owner/Admin、个人 Token 或
  默认接入 Token，请使用数据源接入向导生成的应用绑定 `msrum_` Client Token。

## 浏览器支持

构建产物面向 ES2020，提供 ESM、CommonJS、IIFE 单文件包和 TypeScript 声明。
`PerformanceObserver`、长动画帧、`MutationObserver`、IndexedDB、cookie 等可选浏览器能力在
不可用时各自独立降级。端到端测试覆盖 Chromium、Firefox 与 WebKit。

## 从 0.2 升级

- **`allow` 会显示输入内容。** `defaultPrivacyLevel: 'allow'` 现在会录制输入框里的内容，但密码、邮箱、电话、银行卡和一次性验证码字段除外。要保持 `allow` 以前的行为，请改用 `mask-user-input`。
- **Node 24。** `engines.node` 是 `>=24`。Node 版本更低时 npm 会警告，强制检查 `engines` 的包管理器会拒绝安装。在浏览器里运行的部分没有变化。
- **服务端。** 日志、热力图和测试流量需要支持它们的 MoleSignal 服务端。

## 从 0.1 升级

0.2.0 把 SDK 迁移到 MoleSignal RUM 事件协议，没有兼容模式。

- **端点。** `POST /api/v1/rum/sessions`、`/actions`、`/errors` 已移除，一律发往
  `POST /api/v1/rum/events`。回放仍发往 `/api/v1/rum/replay`，请求体多了 `service`、`env`、`version`。自定义 `transport`
  收到的 `kind` 为 `'events' | 'replay'`（原为 `'session' | 'action' | 'error' | 'replay'`），
  并应返回应答 `body`，SDK 从中读取被拒收的事件。
- **不再有 session 事件。** 会话由服务端从 view 派生。新增 `view` 事件，带 `view.id` 与
  `view.revision`。
- **事件类型变化。** 资源、长任务、页面视图是独立事件，不再是 `type: 'resource' | 'long_task'
  | 'view'` 的 action。愤怒点击、无效点击成为点击上的 `action.frustration.type`，不再是独立
  action。不再上报表单提交。Web Vitals 在 `view` 上；单独的 TTFB 指标改用 `view.first_byte`。
- **`beforeSend`** 拿到的是上述事件对象，而不是 0.1 的扁平记录；`context.kind` 是事件类型
  （`view`、`action`、`error`、`resource`、`long_task`、`vital`）。回放分段不再经过 `beforeSend`。
- **会话** 存放在 cookie `_msrum_s_<applicationId>` 中并由标签页共享，不再放在
  `sessionStorage`；默认空闲超时为 15 分钟（原为 30 分钟）。会话、view 与事件 ID 均为 UUID。
- **`applicationId`** 必须是 1–128 个 `A-Za-z0-9._:-` 字符，并作为 `application.id` 上报，
  必须与令牌所属应用一致。
- **浏览器、操作系统、设备** 不再由 SDK 采集，由服务端根据 `User-Agent` 得出；`language`、
  `timezone`、`viewport` 变为 `device.locale`、`device.time_zone`、`display.viewport`。
- **`trackViewsManually: true`** 不再表示“完全没有 view”：第一个事件或 `startView` 调用会开启
  页面加载 view。
- **错误** 带 `stack`（文本）与 `frames`（结构化，含 `debug_id`），不再有 `raw_stack`；错误 ID
  为 UUID。SDK 不再计算 `error.fingerprint`（0.1 发送 `fp_<hash>`）：错误由服务端聚合，通过
  `addError(error, context, { fingerprint })` 传入的 fingerprint 会覆盖默认聚合。0.1 的
  `parent_span_id` 现为 `resource.span_id`。
- **用户** 对象只要有 `name` 或 `email`，可以没有 `id`。
- 0.1 在 IndexedDB 里排队、尚未发送的事件会在升级时丢弃：它们的目标端点已不存在。

## 开发验证

```bash
npm run typecheck
npm test                 # 构建、单元测试、契约测试、类型测试
npm run test:e2e:install
npm run test:e2e         # 构建后用 Playwright 在 Chromium、Firefox、WebKit 中运行
npm run build
```

单元测试在 Node 中借助一个小型假浏览器环境运行，需要 Node 24 及以上（使用了模块 mock）。
契约测试会把 SDK 发出的每条事件（单元测试与端到端测试里都是）用 MoleSignal 服务端的
`v1.schema.json` 校验，并与其中 `source: browser` 的夹具对比形状。契约目录由环境变量
`MOLESIGNAL_CONTRACTS` 指定（默认 `../molesignal/contracts/rum/events`），找不到时这些测试会被
跳过并说明原因。Playwright 套件覆盖真实的 rrweb 录制、资源时序、长动画帧、Consent、跨标签页
会话和 IndexedDB 恢复。
