# 配置与部署

## CLI 参数与环境变量

CLI 参数优先级高于环境变量。端口参数支持 `1..65535`（`--port` 与 `--target-port` 均支持 `0` 表示随机端口或自动发现）。

| CLI 参数 | 环境变量 | 默认值与说明 |
|---|---|---|
| `--bind <ip>` | `AGY_RELAY_BIND` | 自动探测 `tun0` / `100.64.x.x`（EasyTier 网段），否则回退 `127.0.0.1` |
| `--wait-easytier` | `AGY_RELAY_WAIT_EASYTIER=1`（兼容 `AGY_RELAY_WAIT_EASYTIE=1`） | 启动前阻塞等待 EasyTier 网卡就绪 |
| `--port <port>` | `AGY_RELAY_PORT` | `8421`（对外 HTTPS 监听端口） |
| `--target-port <p>` | `AGY_RELAY_TARGET_PORT`（兼容 `AGY_TARGET_PORT`） | `0`（自动从 `~/.gemini/antigravity/daemon` 发现 `language_server` 端口与 CSRF Token） |
| `--cert <path>` | `AGY_RELAY_CERT` | `~/.config/agy-web-relay/cert.pem` |
| `--key <path>` | `AGY_RELAY_KEY` | `~/.config/agy-web-relay/key.pem` |
| `--user <name>` | `AGY_RELAY_USER` | `agy`（Basic Auth 用户名） |
| `--pass <password>` | `AGY_RELAY_PASS` | 未设置时每次启动随机生成并打印一次 |
| `--no-auth` | `AGY_RELAY_NO_AUTH=1` | 关闭认证；仅建议用于已隔离的私有 EasyTier 网络 |
| `--no-mobile-patch` | `AGY_RELAY_NO_MOBILE_PATCH=1` | 禁止向 SPA HTML 注入移动端样式、脚本与 Manifest |
| `--http3` | `AGY_RELAY_HTTP3=1` | 启用 Go HTTP/3 (QUIC) + WebTransport 边缘代理（二进制不存在时回退 HTTP/2） |
| `--h3-bin <path>` | `AGY_RELAY_H3_BIN` | `<repo>/h3-edge/agy-h3-edge` |
| `-h`, `--help` | — | 打印命令行帮助并退出 |

进阶心跳调优环境变量：

- `AGY_RELAY_H2_PING_MS`：HTTP/2 PING 心跳周期（毫秒，最小 `100`，默认 `25000`）。
- `AGY_RELAY_H2_PING_TIMEOUT_MS`：HTTP/2 PING 等待 ACK 超时（毫秒，最小 `100`，默认 `10000`）。

## 认证与 TLS 证书

1. **TLS 与 CA**：首次启动若目标绑定 IP 尚无匹配证书，会自动在 `~/.config/agy-web-relay/` 下通过 `openssl` 生成私有 CA（`ca.crt` / `ca.key`）以及绑定 `IP:<bindIp>` SAN 的服务器证书（`cert.pem` / `key.pem`）。切换网络 IP 后会自动重签服务器证书，无需重新安装手机端根证书。
2. **Basic Auth + Session Cookie**：开启认证时，首次验证通过后会签发 `HttpOnly` 会话 Cookie（`agy_relay_sid`，24 小时有效），避免 WebSocket、PWA 资源加载或 Service Worker 重复弹窗。

## systemd 用户服务部署

仓库提供通用模板 [examples/agy-web-relay.service](../examples/agy-web-relay.service)：

```bash
mkdir -p ~/.config/systemd/user
cp examples/agy-web-relay.service ~/.config/systemd/user/agy-web-relay.service
# 按实际克隆目录与参数修改 ExecStart 后启用：
systemctl --user daemon-reload
systemctl --user enable --now agy-web-relay.service
```

常用运维命令：

```bash
systemctl --user status agy-web-relay.service
systemctl --user restart agy-web-relay.service
journalctl --user -u agy-web-relay.service -f
```

如需开机无人登录即保持运行，可执行 `sudo loginctl enable-linger "$USER"`。
