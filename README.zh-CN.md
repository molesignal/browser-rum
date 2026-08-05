# MoleSignal Browser RUM

MoleSignal 官方浏览器端 Real User Monitoring SDK，采集会话、页面访问、用户行为、
前端错误、Web Vitals、网络资源、W3C Trace Context 关联，以及可选的隐私友好型
会话 DOM 回放。

[English](README.md)

## 安装与初始化

```bash
npm install @molesignal/browser-rum
```

```ts
import { initRum } from '@molesignal/browser-rum';

const rum = initRum({
  applicationId: 'checkout-web',
  clientToken: 'ms_token',
  site: 'https://molesignal.example.com',
  service: 'web-frontend',
  env: 'production',
  version: 'v1.4.0',
  sessionSampleRate: 100,
  trackUserInteractions: true,
});
```

该 API 与 MoleSignal「数据源 → 前端 RUM」页面生成的接入代码一致。SDK 会携带
`Authorization: Bearer <clientToken>` 写入以下端点：

- `POST /api/v1/rum/v1/sessions`
- `POST /api/v1/rum/v1/actions`
- `POST /api/v1/rum/v1/errors`
- `POST /api/v1/rum/v1/replay`

## 用户与自定义上下文

建议初始化时就传入用户，以便第一条 session 数据关联到正确用户：

```ts
const rum = initRum({
  applicationId: 'checkout-web',
  clientToken: 'ms_token',
  site: 'https://molesignal.example.com',
  user: { id: currentUser.id, plan: currentUser.plan },
  globalContext: { region: 'cn-east-1' },
});

rum.setUser({ id: 'user-42', plan: 'enterprise' });
rum.setGlobalContextProperty('feature_flags', ['new-checkout']);
```

未传用户时，SDK 默认在 `localStorage` 中生成稳定的匿名 ID；可通过
`trackAnonymousUser: false` 关闭。

## 手动埋点

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

// trackViewsManually: true 时使用
rum.startView('Order confirmation');

await rum.flush();
```

包在 SSR 中可安全导入和初始化；只有检测到 `window`、`document` 与
`navigator` 后才会启动浏览器采集。

## 会话回放

回放默认关闭，可按采样率启用，或为当前已采样会话手动开启：

```ts
const rum = initRum({
  applicationId: 'checkout-web',
  clientToken: 'ms_token',
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

采样命中的回放会使用 rrweb 记录 DOM 全量快照与增量变化，包括鼠标移动、点击、滚动、
视口变化和媒体状态；可访问的样式表会内联。所有输入框与可编辑区域内容始终脱敏，
`defaultPrivacyLevel: 'mask'` 还会遮罩全部页面文本。可以用上述选择器阻止敏感子树、
在允许普通文本时单独遮罩指定区域，或忽略高噪声元素。字体、内联图片以及协作式
跨域 iframe 默认关闭，因为这些能力可能显著增加回放体积。

## Trace 关联

fetch/XHR 插件会从请求、响应或名为 `traceparent` 的 `Server-Timing` 指标中
读取 W3C `traceparent`，并把 `trace_id`、`parent_span_id` 写入
`rum_actions`，供 MoleSignal 关联后端链路。

跨域响应需要暴露相关响应头：

```http
Access-Control-Expose-Headers: traceparent, server-timing
```

默认只读取同源请求的 Trace Context；可通过 `allowedTracingUrls` 增加允许的域名。

## 默认采集范围

- 自动跟踪首屏和 History API SPA 路由；
- 捕获运行时错误、未处理 Promise rejection，可选捕获 `console.error`；
- 捕获 fetch、XHR、静态资源耗时与 HTTP 状态；
- 采集 LCP、FID、CLS、TTFB，并在 payload 中附带 INP；
- 可选捕获点击、表单提交、愤怒点击和无效点击；
- 批量发送、失败重试、离线恢复、`pagehide` keepalive flush；
- 自动提取浏览器、操作系统、设备、语言、时区和视口维度。

所有选项均由 `RumInitConfiguration` 提供完整 TypeScript 类型。常用默认值：

| 选项 | 默认值 |
| --- | --- |
| `sessionSampleRate` | `100` |
| `sessionReplaySampleRate` | `0` |
| `trackResources` / `trackLongTasks` / `trackWebVitals` | `true` |
| `trackUserInteractions` / `trackConsoleErrors` | `false` |
| `trackViewsManually` | `false` |
| `trackAnonymousUser` | `true` |
| `trackUrlQueryString` | `false` |
| `defaultPrivacyLevel` | `mask` |

## 隐私与令牌安全

- 默认移除 URL query 与 hash；
- 递归脱敏 `password`、`token`、`authorization`、`cookie`、`api_key`
  等敏感字段；
- 默认不采集交互文本、ARIA label、原始错误栈、DOM 内容和输入框值；
- `clientToken` 会随前端代码下发，必须视为公开凭证。不要复用 Owner/Admin
  或个人 token。生产环境应使用专用的 ingest-only token；如果当前 MoleSignal
  部署只有宽权限的角色 token，应通过同源采集代理转发四个 RUM 端点。

## 开发验证

```bash
npm run typecheck
npm test
npm run build
```

测试覆盖公开 API、SSR、四类 MoleSignal ingest payload、回放分段、隐私脱敏和
W3C Trace Context 关联。
