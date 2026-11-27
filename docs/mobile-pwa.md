# 移动端 PWA、Web Push 与扩展能力

## 1. 手机端证书信任与 PWA 安装

首次打开 `https://<EasyTier-IP>:8421/setup` 或直接下载 `/ca.crt`：

- **Android**：进入系统设置搜索“加密与凭据 / 安装证书 -> CA 证书”导入 `agy-relay-ca.crt`；安装后 Chrome/Edge 的独立 WebAPK、Service Worker 与 Web Push 才能信任自签 TLS 站点。
- **iOS / Safari**：下载配置描述文件并在“设置 -> 通用 -> VPN 与设备管理”完成安装，随后在“设置 -> 通用 -> 关于本机 -> 证书信任设置”开启对 `Antigravity Local Relay CA` 的完全信任，再通过 Safari“添加到主屏幕”安装 PWA。

## 2. 后台 Web Push 推送 (`/push`)

1. 使用受信任的 PWA 浏览器访问 `/push`，填写设备标签并点击开启通知订阅。
2. 服务端 [web-push.mjs](../web-push.mjs) 自动生成并保存 P-256 VAPID 密钥与设备列表（存于 `~/.config/agy-web-relay/`），采用 RFC 8291（`aes128gcm`）加密推送载荷，并在后台独立跟踪会话生命周期：
   - 对话完成生成时触发完成通知；
   - 出现等待用户确认的步骤（命令执行、文件权限、等待输入等）时触发提醒通知；
   - 推送返回 `404` / `410` 的失效订阅会自动清理。
3. **无刷新通知跳转**：点击通知时，[client/sw.js](../client/sw.js) 优先向已打开的 SPA 客户端发送 `AGY_OPEN_CASCADE`，前端通过 `history.pushState` 与内部切换逻辑打开对应 `/c/<uuid>`，保留当前插件注入状态且无需整页重载；若从通知冷启动新窗口，`/c/<uuid>` 由 App Shell 与 IndexedDB 快照快速恢复。

## 3. 本机开发服务反向代理 (`/_relay_local/`)

在代理页面内打开本机启动的开发服务器（如 `http://127.0.0.1:5173`）或预览 `iframe` 时，客户端会自动将目标地址改写为：

```text
/_relay_local/<http|https>/<port>/<path>
```

[lib/local-proxy.mjs](../lib/local-proxy.mjs) 会自动修正相对资源、重定向 `Location`、WebSocket 路径，并在保留非限制性 CSP 指令的前提下剥离 `frame-ancestors` / `X-Frame-Options`，使本地前端预览可在手机端稳定加载。

## 4. 可选组件

### `antigravity-context` 插件桥接

当 `~/.gemini/config/plugins/antigravity-context/` 已安装时，[lib/context-bridge.mjs](../lib/context-bridge.mjs) 会暴露只读代理端点 `/relay-plugin/antigravity-context.js`、`/metrics` 与 `/preferences`，并使用 [lib/usage-reader.mjs](../lib/usage-reader.mjs) 加速账本读取；未安装时上述路由优雅返回降级响应，不影响主中继功能。

### EasyTier 链路优化脚本

若服务器使用 `/etc/easytier/config.toml` 部署 EasyTier，可按需运行仓库根目录下的 `sudo ./optimize-easytier.sh`：脚本会先备份原配置，开启 `quic://0.0.0.0:11013` 监听并配置 `default_protocol = "udp"`、`latency_first = true`、`multi_thread = true` 与 `enable_quic_proxy = true`，最后重启 `easytier.service`。
