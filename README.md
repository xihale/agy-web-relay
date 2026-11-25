# agy-web-relay

零依赖的本地 Antigravity Web 反向代理（HTTPS + HTTP/2 + Brotli/Gzip + PWA），用于通过 EasyTier 虚拟局域网从手机浏览器直连本机 `language_server` 内置的 Web 界面。

## 特性

- **HTTPS + HTTP/2 多路复用 & 双向心跳保活**：使用 `node:http2` 提供 `h2` 服务（兼容 HTTP/1.1 WebSocket Upgrade），在客户端↔中继与中继↔`language_server` 双向连接上均启用 25 秒 HTTP/2 PING 心跳（含 10 秒 ACK 超时检测）与 15 秒 TCP Keep-Alive；收到上游 `GOAWAY` 时优雅排空现有流并自动重连，幂等 `GET`/`HEAD` 请求自动在新建会话上重试，避免移动网络长连接假死。
- **异步压缩与条件缓存（`ETag` / `304`）**：
  - `/main.js`（12MB）等上游静态大包使用 30 秒 TTL + 上游条件校验（`If-None-Match` / `If-Modified-Since`），命中上游 `304` 时零重复下载与零重复压缩，并发回源自动合并；`.br` 与 `.gz` 持久化缓存在 `~/.config/agy-web-relay/cache`。
  - `/setup`、`/manifest.webmanifest`、`/relay-mobile.css`、`/relay-mobile.js`、`/sw.js`、图标及 `/ca.crt` 启动时异步预压缩并生成 SHA-256 `ETag`，支持 `304 Not Modified`。
  - 所有请求路径均使用异步 `zlib`，不阻塞事件循环。
- **实时流式 `grpc-web+json` 与本地侧边服务代理**：
  - `grpc-web+json` 响应仅在存在显式 `Content-Length <= 256 KiB` 时进行异步压缩；其余流式响应零缓冲直接透传。
  - `/_relay_local/<proto>/<port>/...` 复用 HTTP/HTTPs Keep-Alive `Agent` 连接池与 30 秒超时，剥离 `X-Frame-Options` 与 `frame-ancestors`，并在严格 CSP 下为注入脚本自动附加单次随机 `nonce`。
  - `Access-Control-Allow-Origin` 仅允许同源域名，拒绝任意第三方 `Origin` 反射。
- **移动端体验增强 & PWA**：自动规范化 `viewport`（`viewport-fit=cover`、`interactive-widget=resizes-content`）、发送 `103 Early Hints` 与 `<link rel="preload">`、注入 `standalone` PWA Manifest（含 `crossorigin="use-credentials"`）、Service Worker v5（`/relay-mobile.{css,js}` 网络优先，静态大包后台更新并通知页面提示刷新）、`/relay-health` 断网状态探测与自动恢复提示条（可用 `--no-mobile-patch` 关闭）。

## 常用地址

- 主界面：`https://<EasyTier-IP>:8421/`
- 手机端证书安装指引：`https://<EasyTier-IP>:8421/setup`（含 Android 与 iOS 证书完全信任步骤）
- 直接下载根证书：`https://<EasyTier-IP>:8421/ca.crt`
- 中继健康检查：`https://<EasyTier-IP>:8421/relay-health`

## CLI 选项与环境变量

| 选项 | 环境变量 | 默认值 / 说明 |
|---|---|---|
| `--bind <ip>` | `AGY_RELAY_BIND` | 自动探测 `tun0` / `100.64.x.x`，否则 `127.0.0.1` |
| `--wait-easytier` | `AGY_RELAY_WAIT_EASYTIER=1`（兼容 `AGY_RELAY_WAIT_EASYTIE=1`） | 等待 EasyTier 网卡就绪后再启动 |
| `--port <port>` | `AGY_RELAY_PORT` | `8421`（支持 `0..65535`，`0` 为临时端口） |
| `--target-port <p>` | `AGY_RELAY_TARGET_PORT`（兼容 `AGY_TARGET_PORT`） | `0`（自动发现本机 `language_server` 端口） |
| `--cert <path>` | `AGY_RELAY_CERT` | `~/.config/agy-web-relay/cert.pem` |
| `--key <path>` | `AGY_RELAY_KEY` | `~/.config/agy-web-relay/key.pem` |
| `--user <username>` | `AGY_RELAY_USER` | `agy` |
| `--pass <password>` | `AGY_RELAY_PASS` | 启动时随机生成 |
| `--no-auth` | `AGY_RELAY_NO_AUTH=1` | 关闭 Basic Auth（仅建议在私有 EasyTier 网络使用） |
| `--no-mobile-patch` | `AGY_RELAY_NO_MOBILE_PATCH=1` | 关闭 HTML 移动端增强注入 |

## systemd 用户服务（开机自启）

- 服务单元：`~/.config/systemd/user/agy-web-relay.service`
- 默认参数：`--wait-easytier --no-auth --port 8421`（仅绑定 EasyTier 网卡 `tun0` / `100.64.x.x`）

```bash
systemctl --user status agy-web-relay.service
systemctl --user restart agy-web-relay.service
journalctl --user -u agy-web-relay.service -f
```

## 语法检查与测试

```bash
node --check agy-web-relay.mjs
node --check mobile-assets.mjs
node agy-web-relay.mjs --help
```

`agy-web-relay.mjs` 导出 `parseArgs`、`pickEncoding`、`matchesIfNoneMatch`、`injectMobileHead`、`rewriteLocalHtml`、`parseLocalProxyTarget`、`buildH2UpstreamHeaders`、`createAuth`、`createStaticAssetEntry` 等纯辅助函数，可直接通过 `node --test` 导入做隔离单元测试而不触发服务端口监听。
