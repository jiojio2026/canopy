#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RULE_SRC="$ROOT/tools/99-usbcanfd.rules"
RULE_DST="/etc/udev/rules.d/99-usbcanfd.rules"

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo "$0" "$@"
fi
install -m 0644 "$RULE_SRC" "$RULE_DST"
udevadm control --reload-rules
udevadm trigger --subsystem-match=usb --attr-match=idVendor=3068 --attr-match=idProduct=0009 || true
printf '已安装 %s\n' "$RULE_DST"
printf '规则来自你提供的 x86-64 SDK 包说明：3068:0009，MODE=0666。\n'
printf '请重新插拔 USBCANFD-200U，然后执行：lsusb -d 3068:0009\n'
printf '再执行：python3 tools/probe_device.py\n'
