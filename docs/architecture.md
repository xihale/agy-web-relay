# 架构与缓存设计

## 目录结构

```text
agy-web-relay/
├── agy-web-relay.mjs        # 主入口：参数编排、H2/H3 服务启动、SPA 注入与 RPC 转发
├── mobile-assets.mjs        # 客户端静态包与页面模板统一导出
├── web-push.mjs             # VAPID 密钥管理、RFC 8291 加密与上游任务状态监听推送
├── ws-deflate-bridge.mjs    # RFC 7692 permessage-deflate 流式 WebSocket 桥接
├── h3-edge/main.go          # 可选 Go QUIC HTTP/3 与 /wt-websocket WebTransport 边缘代理
├── lib/
│   ├── constants.mjs        # 路径、超时、压缩阈值与可缓存静态资源白名单
│   ├── cli-tls.mjs          # CLI 解析、EasyTier IP 探测、TLS 签发、鉴权与上游发现
│   ├── static-cache.mjs     # 内存/磁盘 Brotli/Gzip/Zstd 协商缓存与 ETag 条件响应
│   ├── html-patch.mjs       # SPA Shell 识别、CSRF Token 注入与移动端头改写
│   ├── local-proxy.mjs      # /_relay_local/ 本机开发服务反代与 CSP/HTML 改写
│   ├── local-routes.mjs     # /relay-health、/relay-push/*、/relay-plugin/* 等本地路由
│   ├── upstream-h2.mjs      # 单例上游 HTTP/2 连接池、静态预热与回源合并
│   ├── ws-upgrade.mjs       # HTTP/1.1 WebSocket Upgrade 转发与断线重选端口
│   ├── context-bridge.mjs   # 可选 antigravity-context 插件指标与偏好桥接
│   └── usage-reader.mjs     # 快速用量账本聚合读取器
└── client/
    ├── mobile.css           # 移动端样式与 #root:empty 即时视觉骨架
    ├── idb-cache.js         # IndexedDB 持久化冷启动快照缓存（agy-relay-cache-v1）
    ├── ws-transport.js      # WebTransportWebSocket 与 180ms Happy Eyeballs ws:// 回退
    ├── ws-control.js        # /connect-websocket 控制通道接管、预取流合并与状态保活
    ├── bridges.js           # 本机链接改写、iframe/storage/notifications 桥接
    ├── file-sheet.js        # 移动端文件路径交互与工作区文件抽屉
    ├── ui-runtime.js        # 健康探测横幅、重连与 SW 消息处理调度
    ├── sw.js                # Service Worker：App Shell 缓存与通知 SPA 跳转
    └── pages.mjs            # /setup 与 /push HTML 页面生成
```

## 请求与连接链路

```text
手机浏览器 (HTTPS/H3/H2/WT/WSS)
   │
   ▼  (可选 --http3)
h3-edge (UDP 8421 HTTP/3 + /wt-websocket) ──► 127.0.0.1:<internalPort>
   │
   ▼
agy-web-relay.mjs (node:http2 + allowHTTP1)
   ├── 本地静态与控制路由 ──► lib/local-routes.mjs (/setup, /push, /relay-push/*, /relay-health)
   ├── 本机服务预览反代   ──► lib/local-proxy.mjs (/_relay_local/<proto>/<port>/...)
   ├── HTTP/1.1 Upgrade    ──► lib/ws-upgrade.mjs + ws-deflate-bridge.mjs ──► language_server
   └── HTTP/2 静态与 RPC   ──► lib/upstream-h2.mjs ──► language_server (127.0.0.1:<port>)
```

## 四层冷启动与缓存机制

1. **服务端内存 + 磁盘压缩缓存 (`lib/static-cache.mjs`)**：上游 `/main.js` 等大包使用 120 秒 TTL 与 `If-None-Match` 条件回源；`br`（q11 后台升级）、`gzip` 与 `zstd` 持久化至 `~/.config/agy-web-relay/cache`，HTML 注入与 RPC 响应按协商编码异步压缩并支持流式 Gzip。
2. **HTML Shell 骨架与记忆化 (`agy-web-relay.mjs`, `client/mobile.css`)**：代理 `/` 与 `/c/<uuid>` 时注入真实 `csrfToken`、版本化资源 `<link rel="preload">`、`103 Early Hints` 与 `#root:empty` 骨架样式，并计算 `x-agy-shell-hash` 响应头供客户端增量校验。
3. **Service Worker App Shell (`client/sw.js`)**：导航请求直接返回已缓存的 `/__agy_app_shell` 并在后台触发 `revalidateShell`，`x-agy-shell-hash` 变化时自动通知页面更新 `window.__APP_CONFIG__.csrfToken` 与运行时配置。
4. **IndexedDB + 预取控制流 (`client/idb-cache.js`, `client/ws-control.js`)**：页面脚本执行即并发预取 `GetUserStatus`、`JetboxSubscribeToSummaries` 与当前会话状态；服务端尚未吐帧前，优先从 `agy-relay-cache-v1`（24 小时 TTL，`boot:summaries` 裁剪至最多 150 条，`convo:*` 最多保留最近 8 个会话）同步或异步吐出缓存帧，真实流量到达后无缝合并接管并防抖落盘。
