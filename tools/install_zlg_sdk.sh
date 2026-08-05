#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$ROOT/vendor"
INSTALL_DIR="$VENDOR_DIR/official_sdk"
ENV_FILE="$VENDOR_DIR/zlgcan_env.sh"
BUNDLED_ZIP="$VENDOR_DIR/packages/usbcanfd_libusb_x64_1.0.14_260701.zip"

log() { printf '[ZLG SDK] %s\n' "$*"; }
die() { printf '[ZLG SDK] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage:
  ./tools/install_zlg_sdk.sh
      Validate and activate the bundled official ZLG Linux SDK.

  ./tools/install_zlg_sdk.sh /path/to/usbcanfd_libusb_x64_xxx.zip
      Install from an official ZLG Linux ZIP package.

  ./tools/install_zlg_sdk.sh /path/to/libusbcanfd.so
      Install from a local official Linux shared library.

No network download is performed.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi
if [[ $# -gt 1 ]]; then usage >&2; exit 2; fi

command -v file >/dev/null 2>&1 || die "缺少 file：sudo apt install file"
command -v python3 >/dev/null 2>&1 || die "缺少 python3"

MACHINE="$(uname -m)"
case "$MACHINE" in
  x86_64|amd64) ARCH_PATTERN='x86-64|x86_64|AMD64' ;;
  *) die "当前内置官方包是 x86-64，主机架构为 $MACHINE。请下载匹配架构的官方 Linux SDK。" ;;
esac

REQUIRED=(
  VCI_OpenDevice VCI_CloseDevice VCI_InitCAN VCI_StartCAN
  VCI_Transmit VCI_Receive VCI_TransmitFD VCI_ReceiveFD
)
OPTIONAL=(
  VCI_ReadBoardInfo VCI_ReadErrInfo VCI_ReadCANStatus
  VCI_SetReference VCI_GetReference
  VCI_InitLIN VCI_StartLIN VCI_TransmitLIN VCI_ReceiveLIN
  VCI_UDS_Request VCI_UDS_Control
)

check_so() {
  local so="$1" desc
  [[ -s "$so" ]] || die "动态库不存在或为空：$so"
  desc="$(file -b "$so")"
  log "动态库：$so"
  log "文件类型：$desc"
  grep -Eqi "$ARCH_PATTERN" <<<"$desc" || die "动态库架构不匹配：$desc"
  LD_LIBRARY_PATH="$(dirname "$so"):${LD_LIBRARY_PATH:-}" python3 - "$so" "${REQUIRED[@]}" <<'PY'
import ctypes
import sys
path, *required = sys.argv[1:]
try:
    lib = ctypes.CDLL(path, mode=getattr(ctypes, "RTLD_GLOBAL", 0))
except OSError as exc:
    raise SystemExit(f"无法加载动态库: {exc}")
missing = [name for name in required if not hasattr(lib, name)]
if missing:
    raise SystemExit("缺少必需 VCI_* 符号: " + ", ".join(missing))
print("ctypes.CDLL + required VCI_* symbols: OK")
PY
}

write_env() {
  cat > "$ENV_FILE" <<'ENVEOF'
#!/usr/bin/env bash
_VENDOR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ZLGCAN_LIB="$_VENDOR_ROOT/official_sdk/libusbcanfd.so"
export ZLGCAN_UDS_LIB="$_VENDOR_ROOT/official_sdk/libzuds.so"
export ZLGCAN_LIBRARY_DIR="$_VENDOR_ROOT/official_sdk"
export LD_LIBRARY_PATH="$_VENDOR_ROOT/official_sdk:${LD_LIBRARY_PATH:-}"
unset _VENDOR_ROOT
ENVEOF
  chmod 0644 "$ENV_FILE"
}

install_dir() {
  local source_dir="$1"
  local core="$source_dir/libusbcanfd.so"
  check_so "$core"

  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  cp -aL "$core" "$INSTALL_DIR/libusbcanfd.so"

  # Only copy same-architecture optional libraries. The official x64 ZIP
  # currently contains a misleading ARM64 file named libusb-1.0.so; never copy it.
  if [[ -s "$source_dir/libzuds.so" ]] && file -b "$source_dir/libzuds.so" | grep -Eqi "$ARCH_PATTERN"; then
    cp -aL "$source_dir/libzuds.so" "$INSTALL_DIR/libzuds.so"
  fi
  for f in zcan.h zuds.h readme.txt USBCANFD_DEMO.py LIN_DEMO.py; do
    [[ -f "$source_dir/$f" ]] && cp -a "$source_dir/$f" "$INSTALL_DIR/$f"
  done

  # The shared object advertises this SONAME. Keep a local link for vendor demos.
  ln -sfn libusbcanfd.so "$INSTALL_DIR/libusbcanfd.so.1.0.14"
  write_env
  check_so "$INSTALL_DIR/libusbcanfd.so"

  if command -v ldd >/dev/null 2>&1; then
    local missing
    missing="$(LD_LIBRARY_PATH="$INSTALL_DIR:${LD_LIBRARY_PATH:-}" ldd "$INSTALL_DIR/libusbcanfd.so" | grep 'not found' || true)"
    if [[ -n "$missing" ]]; then
      printf '%s\n' "$missing" >&2
      die "缺少运行依赖。Ubuntu/Debian：sudo apt install libusb-1.0-0 libudev1 libcap2"
    fi
  fi

  log "官方 SDK 已启用：$INSTALL_DIR/libusbcanfd.so"
  log "未复制包内 libusb-1.0.so：该文件是 ARM64，x86-64 主机应使用系统 libusb-1.0.so.0。"
  log "下一步：source vendor/zlgcan_env.sh && python3 tools/check_environment.py"
}

install_zip() {
  local archive="$1" tmp
  command -v unzip >/dev/null 2>&1 || die "缺少 unzip：sudo apt install unzip"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  log "解压官方 Linux SDK：$archive"
  unzip -q -o "$archive" -d "$tmp"
  local core
  core="$(find "$tmp" -type f -name libusbcanfd.so -size +0c | head -n1 || true)"
  [[ -n "$core" ]] || die "压缩包中未找到非空的 libusbcanfd.so"
  install_dir "$(dirname "$core")"
  rm -rf "$tmp"
  trap - RETURN
}

if [[ $# -eq 0 ]]; then
  if [[ -s "$INSTALL_DIR/libusbcanfd.so" ]]; then
    check_so "$INSTALL_DIR/libusbcanfd.so"
    write_env
    log "使用项目内置的官方 Linux SDK 1.0.14。"
  elif [[ -f "$BUNDLED_ZIP" ]]; then
    install_zip "$BUNDLED_ZIP"
  else
    die "未找到内置官方 SDK。请把官方 ZIP 或 libusbcanfd.so 作为参数传入。"
  fi
else
  INPUT="$1"
  [[ -f "$INPUT" ]] || die "找不到输入文件：$INPUT"
  case "$INPUT" in
    *.zip|*.ZIP) install_zip "$INPUT" ;;
    *.so|*.so.*)
      tmp="$(mktemp -d)"
      cp -aL "$INPUT" "$tmp/libusbcanfd.so"
      install_dir "$tmp"
      rm -rf "$tmp"
      ;;
    *) die "只支持官方 Linux ZIP 或 libusbcanfd.so" ;;
  esac
fi

source "$ENV_FILE"
python3 "$ROOT/tools/check_environment.py"
