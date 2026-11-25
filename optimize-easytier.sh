#!/usr/bin/env bash
set -euo pipefail

CFG="/etc/easytier/config.toml"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Please run as root: sudo $0" >&2
  exit 1
fi

if [[ ! -f "$CFG" ]]; then
  echo "EasyTier config not found: $CFG" >&2
  exit 1
fi

BACKUP="${CFG}.bak-$(date +%Y%m%d-%H%M%S)"
cp -a "$CFG" "$BACKUP"
echo "Backed up $CFG -> $BACKUP"

python3 - "$CFG" <<'PY'
import re
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    text = f.read()

# 1. Ensure quic://0.0.0.0:11013 is in listeners without duplicating
def add_quic_listener(m):
    block = m.group(0)
    if "quic://" in block:
        return block
    return block[:-1] + '"quic://0.0.0.0:11013",\n]'

text = re.sub(r"listeners\s*=\s*\[.*?\]", add_quic_listener, text, count=1, flags=re.DOTALL)

# 2. Update default_protocol and latency_first under [flags]
text = re.sub(r'(?m)^default_protocol\s*=\s*"[^"]*"', 'default_protocol = "udp"', text)
text = re.sub(r"(?m)^latency_first\s*=\s*(?:true|false)", "latency_first = true", text)

# 3. Ensure multi_thread = true and enable_quic_proxy = true exist under [flags]
def ensure_flag(src, key, val):
    pat = re.compile(rf"(?m)^{re.escape(key)}\s*=\s*.*$")
    if pat.search(src):
        return pat.sub(f"{key} = {val}", src)
    return re.sub(r"(?m)^\[flags\]\s*$", f"[flags]\n{key} = {val}", src, count=1)

text = ensure_flag(text, "multi_thread", "true")
text = ensure_flag(text, "enable_quic_proxy", "true")

with open(path, "w", encoding="utf-8") as f:
    f.write(text)
PY

echo "=== Config diff ==="
diff -u "$BACKUP" "$CFG" || true

echo "=== Restarting easytier.service ==="
systemctl restart easytier.service
systemctl is-active easytier.service
sleep 2
easytier-cli peer || true
