# agy-web-relay

零依赖的 Antigravity 本地 Web 反向代理与移动端 PWA 增强中继。通过 EasyTier 等虚拟局域网或本地回环，从手机浏览器安全直连本机 `language_server` Web 界面。

## 核心能力

- **双协议传输与保活**：内置 `node:http2` 服务与可选 Go HTTP/3 + WebTransport 边缘代理（`h3-edge`），移动端自动通过 Happy Eyeballs 竞速回退到 `wss://`，并在客户端与上游双向启用 HTTP/2 PING 与 TCP Keep-Alive。
- **WebSocket 压缩桥接**：实现流水线化的 RFC 7692 `permessage-deflate` 桥接与 WebTransport 帧复用，降低实时状态流传输体积。
- **四层冷启动加速**：`#root:empty` 即时视觉骨架 + Service Worker SPA App Shell 缓存 + IndexedDB（`agy-relay-cache-v1`）离线快照水合 + 首屏状态流预取与接管，消除进入会话的白屏等待。
- **移动端适配与 Web Push**：自动注入移动端视口与抽屉交互、支持 VAPID + RFC 8291 加密的后台任务完成/等待通知推送，通知点击直接在 SPA 内跳转不丢失运行状态。
- **本机预览反代**：通过 `/_relay_local/<proto>/<port>/...` 转发本地开发服务器页面，自动改写绝对路径与 `iframe` 策略。
- **零外部 npm 依赖**：服务端与前端逻辑全部基于 Node.js 标准库（`>=22`）及原生浏览器 API；仅可选 HTTP/3 边缘组件使用 Go 构建。

## 快速开始

### 1. 仅使用 Node.js 启动（HTTP/2 + WSS）

```bash
git clone https://github.com/xihale/agy-web-relay.git
cd agy-web-relay
node agy-web-relay.mjs --wait-easytier --port 8421
```

若仅运行在受信私有 EasyTier 虚拟局域网内，可追加 `--no-auth` 关闭 Basic Auth：

```bash
node agy-web-relay.mjs --wait-easytier --no-auth --port 8421
```

### 2. 可选：构建并启用 HTTP/3 + WebTransport 边缘代理（Go）

```bash
npm run build:h3
node agy-web-relay.mjs --wait-easytier --no-auth --port 8421 --http3
```

当 `h3-edge/agy-h3-edge` 未构建或不存在时，`--http3` 会自动回退为 HTTP/2 服务。

## 常用路由

| 路径 | 用途 |
|---|---|
| `/` 与 `/c/<uuid>` | 代理 Antigravity SPA 主界面与指定会话 |
| `/setup` | 移动端 HTTPS 根证书下载与信任指引页 |
| `/ca.crt` | 直接下载本机自动生成的 CA 根证书 |
| `/push` | 多设备 Web Push 订阅管理与测试推送页 |
| `/relay-health` | 返回当前已发现的 `language_server` 状态与端口（`200` / `503`） |
| `/_relay_local/<proto>/<port>/` | 本机 Web 服务（HTTP/HTTPS/WS）反向代理前缀 |

## 检查与测试

```bash
npm run check
npm test
cd h3-edge && go vet ./...
```

## 延伸文档

- [CLI 参数、环境变量与 systemd 部署](docs/configuration.md)
- [模块架构、请求链路与多层缓存](docs/architecture.md)
- [移动端 PWA、CA 证书、Web Push 与插件桥接](docs/mobile-pwa.md)
