#!/usr/bin/env python3
"""Offline USBCANFD-200U Linux VCI ABI checker. It never opens the adapter."""
from __future__ import annotations

import ctypes as C
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.drivers.zlgcan import (  # noqa: E402
    VCI_BIT_TIMING,
    VCI_BOARD_INFO,
    VCI_CANFD_INIT_CONFIG,
    VCI_CANFD_MSG,
    VCI_CAN_MSG,
    VCI_CAN_STATUS,
    VCI_FILTER,
    VCI_FILTER_TABLE,
    VCI_LIN_INIT_CONFIG,
    VCI_TTX,
    VCI_TTX_CONFIG,
    calculate_bit_timing,
    locate_library,
    timing_dict,
)

REQUIRED = (
    "VCI_OpenDevice", "VCI_CloseDevice", "VCI_InitCAN", "VCI_StartCAN",
    "VCI_ResetCAN", "VCI_ClearBuffer", "VCI_GetReceiveNum", "VCI_Transmit",
    "VCI_Receive", "VCI_TransmitFD", "VCI_ReceiveFD",
)
OPTIONAL = (
    "VCI_ReadBoardInfo", "VCI_ReadErrInfo", "VCI_ReadCANStatus",
    "VCI_GetReference", "VCI_SetReference", "VCI_Debug",
    "VCI_InitLIN", "VCI_StartLIN", "VCI_ResetLIN", "VCI_TransmitLIN",
    "VCI_GetLINReceiveNum", "VCI_ClearLINBuffer", "VCI_ReceiveLIN",
    "VCI_SetLINSubscribe", "VCI_SetLINPublish", "VCI_TransmitData",
    "VCI_ReceiveData", "VCI_UDS_Request", "VCI_UDS_Control",
)


def command(name: str, path: Path) -> None:
    executable = shutil.which(name)
    if not executable:
        return
    try:
        print(f"\n$ {name} {path}")
        print(subprocess.check_output([executable, str(path)], stderr=subprocess.STDOUT, text=True).strip())
    except subprocess.CalledProcessError as exc:
        print(exc.output.strip())


def main() -> int:
    print("USBCANFD-200U / 官方 Linux SDK VCI_* 环境检查")
    print(f"OS: {platform.platform()}")
    print(f"Machine: {platform.machine()}  Python: {platform.python_version()}  Pointer: {C.sizeof(C.c_void_p)*8}-bit")
    print(f"ZLGCAN_LIB: {os.getenv('ZLGCAN_LIB', '(未设置)')}")

    rows = (
        ("BIT_TIMING", VCI_BIT_TIMING, 6),
        ("CANFD_INIT", VCI_CANFD_INIT_CONFIG, 20),
        ("CAN_MSG", VCI_CAN_MSG, 24),
        ("CANFD_MSG", VCI_CANFD_MSG, 80),
        ("BOARD_INFO", VCI_BOARD_INFO, 79),
        ("CAN_STATUS", VCI_CAN_STATUS, 12),
        ("FILTER", VCI_FILTER, 12),
        ("FILTER_TABLE", VCI_FILTER_TABLE, 772),
        ("TTX", VCI_TTX, 88),
        ("TTX_CONFIG", VCI_TTX_CONFIG, 708),
        ("LIN_INIT", VCI_LIN_INIT_CONFIG, 8),
    )
    print("\nABI:")
    abi_ok = True
    for name, typ, expected in rows:
        actual = C.sizeof(typ)
        good = actual == expected
        abi_ok &= good
        print(f"  {'OK' if good else 'ERR':3} {name:16} size={actual}, expected={expected}")
    print("  CAN_MSG offsets:", {name: getattr(VCI_CAN_MSG, name).offset for name, _ in VCI_CAN_MSG._fields_})

    print("\n常用波特率位时序（60 MHz 自动计算）:")
    timing_ok = True
    for rate in (40_000, 125_000, 250_000, 500_000, 1_000_000, 2_000_000, 4_000_000, 5_000_000):
        try:
            timing = calculate_bit_timing(rate, 0.75 if rate >= 5_000_000 else 0.80)
            print(f"  {rate:>7}: {timing_dict(timing)}")
        except Exception as exc:
            timing_ok = False
            print(f"  ERR {rate}: {exc}")

    try:
        lib, path = locate_library()
    except Exception as exc:
        print(f"\nERR 动态库加载失败: {exc}")
        return 2
    print(f"\nOK 动态库已加载: {path}")
    resolved = Path(path)
    if resolved.exists():
        command("file", resolved)
        command("ldd", resolved)

    missing = [name for name in REQUIRED if not hasattr(lib, name)]
    print("\n必需 VCI_* 符号:")
    for name in REQUIRED:
        print(f"  {'OK ' if hasattr(lib, name) else 'ERR'} {name}")
    print("\n可选/扩展符号:")
    for name in OPTIONAL:
        print(f"  {'YES' if hasattr(lib, name) else ' no'} {name}")

    if hasattr(lib, "ZCAN_OpenDevice"):
        print("\n提示：该库也导出 ZCAN_*，但本项目在 Linux 200U 上使用 VCI_* 接口。")
    if missing or not abi_ok or not timing_ok:
        print("\n检查失败：缺少必需 VCI_* 符号、ABI 尺寸不匹配或位时序计算失败。")
        return 3
    print("\n检查通过。此工具没有打开设备；下一步执行 ./run_real.sh。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
