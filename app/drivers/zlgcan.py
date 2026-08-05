from __future__ import annotations

import ctypes as C
import ctypes.util
import logging
import os
import grp
import pwd
import re
import shutil
import stat
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.drivers.base import CanDriver, DriverError
from app.models import (
    CanFrame,
    DeviceConfig,
    FilterItem,
    HardwareQueueFrame,
    LinFrame,
    LinPublish,
    LinSchedule,
    LinSubscribe,
    SavedMessage,
)

log = logging.getLogger(__name__)

STATUS_OK = 1
ZCAN_USBCANFD_LINUX = 33
ZCAN_USBCANFD_200U_ENUM = 41
CLOCK_HZ = 60_000_000
USB_VENDOR_ID = "3068"
USB_PRODUCT_ID = "0009"

# VCI_Set/GetReference command IDs used by the Linux USBCANFD library.
CMD_CAN_FILTER = 0x14
CMD_CAN_TTX = 0x16
CMD_CAN_TTX_CTL = 0x17
CMD_CAN_TRES = 0x18
CMD_SET_CHNL_RECV_MERGE = 0x32
CMD_GET_CHNL_RECV_MERGE = 0x33
CMD_CAN_TX_TIMEOUT = 0x44
CMD_GET_SEND_QUEUE_SIZE = 0x100
CMD_GET_SEND_QUEUE_SPACE = 0x101
CMD_SET_SEND_QUEUE_CLR = 0x102
CMD_SET_SEND_QUEUE_EN = 0x103

# ZCAN_MSG_INFO bit layout in the Linux VCI_* ABI.
FLAG_TX_MODE_MASK = 0xF
FLAG_CANFD = 1 << 4
FLAG_RTR = 1 << 8
FLAG_EXT = 1 << 9
FLAG_ERROR = 1 << 10
FLAG_BRS = 1 << 11
FLAG_ESI = 1 << 12
FLAG_TX = 1 << 13
FLAG_ECHO = 1 << 14
FLAG_QSEND_100US = 1 << 15
FLAG_QSEND = 1 << 16
TX_MODE = {"normal": 0, "once": 1, "self": 2, "self_once": 3}


class VCI_BOARD_INFO(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("hw_Version", C.c_ushort),
        ("fw_Version", C.c_ushort),
        ("dr_Version", C.c_ushort),
        ("in_Version", C.c_ushort),
        ("irq_Num", C.c_ushort),
        ("can_Num", C.c_ubyte),
        ("str_Serial_Num", C.c_ubyte * 20),
        ("str_hw_Type", C.c_ubyte * 40),
        ("reserved", C.c_ushort * 4),
    ]


class VCI_BIT_TIMING(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("tseg1", C.c_ubyte),
        ("tseg2", C.c_ubyte),
        ("sjw", C.c_ubyte),
        ("smp", C.c_ubyte),
        ("brp", C.c_ushort),
    ]


class VCI_CANFD_INIT_CONFIG(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("clk", C.c_uint32),
        ("mode", C.c_uint32),
        ("abit", VCI_BIT_TIMING),
        ("dbit", VCI_BIT_TIMING),
    ]


class VCI_CAN_MSG(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("timestamp", C.c_uint32),
        ("can_id", C.c_uint32),
        ("flags", C.c_uint32),
        ("delay", C.c_uint16),
        ("channel", C.c_uint8),
        ("length", C.c_uint8),
        ("data", C.c_ubyte * 8),
    ]


class VCI_CANFD_MSG(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("timestamp", C.c_uint32),
        ("can_id", C.c_uint32),
        ("flags", C.c_uint32),
        ("delay", C.c_uint16),
        ("channel", C.c_uint8),
        ("length", C.c_uint8),
        ("data", C.c_ubyte * 64),
    ]


class VCI_FILTER(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("type", C.c_uint8),
        ("pad", C.c_uint8 * 3),
        ("start_id", C.c_uint32),
        ("end_id", C.c_uint32),
    ]


class VCI_FILTER_TABLE(C.Structure):
    _pack_ = 1
    _fields_ = [("size", C.c_uint32), ("table", VCI_FILTER * 64)]


class VCI_TTX(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("interval", C.c_uint32),  # 100 us units
        ("repeat", C.c_uint16),    # 0 means continuous
        ("index", C.c_uint8),
        ("flags", C.c_uint8),
        ("msg", VCI_CANFD_MSG),
    ]


class VCI_TTX_CONFIG(C.Structure):
    _pack_ = 1
    # The public Linux demo exposes eight entries per configuration call.
    _fields_ = [("size", C.c_uint32), ("table", VCI_TTX * 8)]


class VCI_CAN_STATUS(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("errInterrupt", C.c_ubyte),
        ("regMode", C.c_ubyte),
        ("regStatus", C.c_ubyte),
        ("regALCapture", C.c_ubyte),
        ("regECCapture", C.c_ubyte),
        ("regEWLimit", C.c_ubyte),
        ("regRECounter", C.c_ubyte),
        ("regTECounter", C.c_ubyte),
        ("Reserved", C.c_uint32),
    ]


class VCI_LIN_INIT_CONFIG(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("linMode", C.c_ubyte),
        ("chkSumMode", C.c_ubyte),
        ("reserved", C.c_uint16),
        ("linBaud", C.c_uint32),
    ]


class VCI_LIN_PUBLISH_CFG(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("ID", C.c_ubyte),
        ("dataLen", C.c_ubyte),
        ("data", C.c_ubyte * 8),
        ("chkSumMode", C.c_ubyte),
        ("reserved", C.c_ubyte * 5),
    ]


class VCI_LIN_SUBSCRIBE_CFG(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("ID", C.c_ubyte),
        ("dataLen", C.c_ubyte),
        ("chkSumMode", C.c_ubyte),
        ("reserved", C.c_ubyte * 5),
    ]


class VCI_LIN_RX_DATA(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("timeStamp", C.c_uint64),
        ("dataLen", C.c_ubyte),
        ("dir", C.c_ubyte),
        ("chkSum", C.c_ubyte),
        ("reserved", C.c_ubyte * 13),
        ("data", C.c_ubyte * 8),
    ]


class VCI_LIN_DATA(C.Structure):
    _pack_ = 1
    _fields_ = [("PID", C.c_ubyte), ("RxData", VCI_LIN_RX_DATA), ("reserved", C.c_ubyte * 7)]


class VCI_LIN_ERROR_DATA(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("timeStamp", C.c_uint64),
        ("PID", C.c_ubyte),
        ("dataLen", C.c_ubyte),
        ("Data", C.c_ubyte * 8),
        ("errBits", C.c_ushort),
        ("dir", C.c_ubyte),
        ("chkSum", C.c_ubyte),
        ("reserved", C.c_ubyte * 10),
    ]


class VCI_LIN_EVENT_DATA(C.Structure):
    _pack_ = 1
    _fields_ = [("timeStamp", C.c_uint64), ("type", C.c_ubyte), ("res", C.c_ubyte * 7)]


class VCI_LIN_DATA_UNION(C.Union):
    _pack_ = 1
    _fields_ = [
        ("linData", VCI_LIN_DATA),
        ("linError", VCI_LIN_ERROR_DATA),
        ("linEvent", VCI_LIN_EVENT_DATA),
        ("raw", C.c_ubyte * 46),
    ]


class VCI_LIN_MSG(C.Structure):
    _pack_ = 1
    _fields_ = [("channel", C.c_ubyte), ("dataType", C.c_ubyte), ("data", VCI_LIN_DATA_UNION)]


# Compatibility aliases retained for external tests/tools that imported v2.0 names.
ZCAN_DEVICE_INFO = VCI_BOARD_INFO
ZCAN_CHANNEL_CANFD_INIT_CONFIG = VCI_CANFD_INIT_CONFIG
ZCAN_CAN_FRAME = VCI_CAN_MSG
ZCAN_CANFD_FRAME = VCI_CANFD_MSG
ZCAN_CHANNEL_STATUS = VCI_CAN_STATUS
ZCAN_LIN_INIT_CONFIG = VCI_LIN_INIT_CONFIG


def _decode_bytes(arr: Any) -> str:
    return bytes(arr).split(b"\0", 1)[0].decode("utf-8", "replace")


def _version(value: int) -> str:
    return f"V{(value >> 8) & 0xFF}.{value & 0xFF:02x}"


def locate_library() -> Tuple[Any, str]:
    env = os.getenv("ZLGCAN_LIB")
    candidates: List[str] = []
    if env:
        candidates.append(env)
    base = Path(__file__).resolve().parents[2] / "vendor"
    names = ("libusbcanfd.so", "libcontrolcanfd.so", "libzlgcan.so", "libzcan.so")
    for name in names:
        candidates.append(str(base / name))
        candidates.extend(str(path) for path in base.rglob(name))
        candidates.append(name)
    for name in ("usbcanfd", "controlcanfd", "zlgcan", "zcan"):
        found = ctypes.util.find_library(name)
        if found:
            candidates.append(found)

    errors: List[str] = []
    seen = set()
    for path in candidates:
        if path in seen:
            continue
        seen.add(path)
        try:
            lib = C.CDLL(path, mode=getattr(C, "RTLD_GLOBAL", 0))
            return lib, path
        except OSError as exc:
            errors.append(f"{path}: {exc}")
    detail = "; ".join(errors[-3:])
    raise DriverError(
        "未找到或无法加载 USBCANFD Linux 动态库。请设置 ZLGCAN_LIB，或把 "
        "libusbcanfd.so/libcontrolcanfd.so 放到 vendor/。"
        + (f" 最近错误: {detail}" if detail else "")
    )


def _group_exists(gid: int) -> bool:
    try:
        grp.getgrgid(gid)
        return True
    except KeyError:
        return False


def probe_usb_access() -> Dict[str, Any]:
    """Inspect the exact USB adapter identified by the supplied x86-64 SDK package."""
    current_uid = os.geteuid()
    current_gid = os.getegid()
    result: Dict[str, Any] = {
        "vid": USB_VENDOR_ID,
        "pid": USB_PRODUCT_ID,
        "user": pwd.getpwuid(current_uid).pw_name,
        "uid": current_uid,
        "gid": current_gid,
        "groups": [grp.getgrgid(g).gr_name for g in os.getgroups() if _group_exists(g)],
        "found": False,
        "devices": [],
        "udev_rules": [
            str(path) for path in (
                Path("/etc/udev/rules.d/99-usbcanfd.rules"),
                Path("/etc/udev/rules.d/50-usbcanfd.rules"),
            ) if path.exists()
        ],
    }

    seen = set()
    lsusb = shutil.which("lsusb")
    if lsusb:
        try:
            proc = subprocess.run(
                [lsusb, "-d", f"{USB_VENDOR_ID}:{USB_PRODUCT_ID}"],
                text=True, capture_output=True, timeout=3, check=False,
            )
            result["lsusb_command"] = f"lsusb -d {USB_VENDOR_ID}:{USB_PRODUCT_ID}"
            result["lsusb_output"] = proc.stdout.strip()
            for line in proc.stdout.splitlines():
                match = re.search(r"Bus\s+(\d+)\s+Device\s+(\d+):", line)
                if match:
                    seen.add((int(match.group(1)), int(match.group(2)), line.strip()))
        except Exception as exc:
            result["lsusb_error"] = str(exc)
    else:
        result["lsusb_error"] = "未安装 lsusb（usbutils）；已继续检查 sysfs"

    sysfs_root = Path("/sys/bus/usb/devices")
    if sysfs_root.exists():
        for entry in sysfs_root.iterdir():
            try:
                if (entry / "idVendor").read_text().strip().lower() != USB_VENDOR_ID:
                    continue
                if (entry / "idProduct").read_text().strip().lower() != USB_PRODUCT_ID:
                    continue
                bus = int((entry / "busnum").read_text().strip())
                dev = int((entry / "devnum").read_text().strip())
                seen.add((bus, dev, str(entry)))
            except (OSError, ValueError):
                continue

    for bus, dev, source in sorted(seen):
        node = Path(f"/dev/bus/usb/{bus:03d}/{dev:03d}")
        item: Dict[str, Any] = {"bus": bus, "device": dev, "node": str(node), "source": source}
        if node.exists():
            info = node.stat()
            item.update({
                "exists": True,
                "mode": stat.filemode(info.st_mode),
                "mode_octal": oct(info.st_mode & 0o777),
                "owner": pwd.getpwuid(info.st_uid).pw_name,
                "group": grp.getgrgid(info.st_gid).gr_name if _group_exists(info.st_gid) else str(info.st_gid),
                "readable": os.access(node, os.R_OK),
                "writable": os.access(node, os.W_OK),
            })
            item["accessible"] = bool(item["readable"] and item["writable"])
        else:
            item.update({"exists": False, "readable": False, "writable": False, "accessible": False})
        result["devices"].append(item)

    result["found"] = bool(result["devices"])
    result["accessible"] = any(item.get("accessible") for item in result["devices"])
    if not result["found"]:
        result["summary"] = f"未发现 USB 设备 {USB_VENDOR_ID}:{USB_PRODUCT_ID}；检查连接、供电和 lsusb"
    elif not result["accessible"]:
        result["summary"] = "设备已枚举，但当前 Web 服务进程对 USB 节点没有读写权限"
    else:
        result["summary"] = "设备已枚举，当前进程具备 USB 读写权限"
    return result


def probe_runtime_environment() -> Dict[str, Any]:
    output: Dict[str, Any] = {"usb": probe_usb_access()}
    try:
        lib, path = locate_library()
        symbols = {
            name: hasattr(lib, name) for name in (
                "VCI_OpenDevice", "VCI_CloseDevice", "VCI_InitCAN", "VCI_StartCAN",
                "VCI_Transmit", "VCI_Receive", "VCI_TransmitFD", "VCI_ReceiveFD",
            )
        }
        output["library"] = {"ok": all(symbols.values()), "path": path, "required_symbols": symbols}
    except Exception as exc:
        output["library"] = {"ok": False, "error": str(exc)}
    output["ready"] = bool(output["library"].get("ok") and output["usb"].get("accessible"))
    return output


def calculate_bit_timing(bitrate: int, sample_point: float = 0.80, clock_hz: int = CLOCK_HZ) -> VCI_BIT_TIMING:
    """Calculate an exact 60 MHz timing tuple for the vendor's Linux ABI.

    The encoded total time quanta is tseg1 + tseg2 + 3 and the prescaler is brp + 1.
    The solver only returns exact integer bitrates and favours sample points near the target.
    """
    if bitrate <= 0 or clock_hz % bitrate:
        raise DriverError(f"当前 60 MHz 时钟无法精确生成波特率 {bitrate} bit/s")
    ratio = clock_hz // bitrate
    candidates = []
    for prescaler in range(1, min(ratio, 1024) + 1):
        if ratio % prescaler:
            continue
        total_tq = ratio // prescaler
        if not 5 <= total_tq <= 258:
            continue
        # sample point = (tseg1 + 2) / total_tq
        tseg1 = int(round(sample_point * total_tq - 2))
        tseg1 = max(0, min(255, tseg1))
        tseg2 = total_tq - tseg1 - 3
        if not 0 <= tseg2 <= 127:
            continue
        actual_sp = (tseg1 + 2) / total_tq
        sjw = min(max(tseg2, 0), 2)
        # Prefer target sample point, then a moderate number of TQ.
        score = (abs(actual_sp - sample_point), abs(total_tq - 20), prescaler)
        candidates.append((score, tseg1, tseg2, sjw, prescaler - 1))
    if not candidates:
        raise DriverError(f"找不到波特率 {bitrate} 的合法位时序")
    _, tseg1, tseg2, sjw, brp = min(candidates, key=lambda item: item[0])
    return VCI_BIT_TIMING(tseg1, tseg2, sjw, 0, brp)


def timing_dict(value: VCI_BIT_TIMING) -> Dict[str, int]:
    return {
        "tseg1": int(value.tseg1),
        "tseg2": int(value.tseg2),
        "sjw": int(value.sjw),
        "smp": int(value.smp),
        "brp": int(value.brp),
    }


class ZlgCanDriver(CanDriver):
    """USBCANFD-200U Linux backend using the vendor VCI_* ABI."""

    def __init__(self, on_frame):
        super().__init__(on_frame)
        self.lib = None
        self.lib_path: Optional[str] = None
        self.config: Optional[DeviceConfig] = None
        self.opened = False
        self.active_device_type: Optional[int] = None
        self.channels: Dict[int, bool] = {}
        self.lin_channels: Dict[int, bool] = {}
        self.stop_evt = threading.Event()
        self.rx_threads: List[threading.Thread] = []
        self.lock = threading.RLock()
        self.capability_results: Dict[str, Any] = {}
        self.periodic_slots: Dict[int, Dict[int, SavedMessage]] = {0: {}, 1: {}}
        self.queue_enabled: Dict[int, bool] = {0: False, 1: False}
        self.operation_state: Dict[str, Any] = {"state": "idle", "stage": "未开始", "updated_ns": time.time_ns()}

    def _operation(self, state: str, stage: str, **details: Any) -> None:
        self.operation_state = {"state": state, "stage": stage, "updated_ns": time.time_ns(), **details}

    def preflight(self) -> Dict[str, Any]:
        result = probe_runtime_environment()
        result["configured_device_type"] = int(self.config.device_type if self.config else ZCAN_USBCANFD_LINUX)
        result["device_index"] = self.dev_index
        return result

    @property
    def dev_type(self) -> int:
        if self.active_device_type is not None:
            return int(self.active_device_type)
        return int(self.config.device_type if self.config else ZCAN_USBCANFD_LINUX)

    @property
    def dev_index(self) -> int:
        return int(self.config.device_index if self.config else 0)

    def _bind(self) -> None:
        lib = self.lib
        required = (
            "VCI_OpenDevice",
            "VCI_CloseDevice",
            "VCI_InitCAN",
            "VCI_StartCAN",
            "VCI_ResetCAN",
            "VCI_ClearBuffer",
            "VCI_GetReceiveNum",
            "VCI_Transmit",
            "VCI_Receive",
            "VCI_TransmitFD",
            "VCI_ReceiveFD",
        )
        missing = [name for name in required if not hasattr(lib, name)]
        if missing:
            exported = "ZCAN_*" if hasattr(lib, "ZCAN_OpenDevice") else "未知"
            raise DriverError(
                "动态库不是 USBCANFD Linux VCI_* ABI，缺少: " + ", ".join(missing)
                + f"；检测到的另一接口族: {exported}"
            )

        u32 = C.c_uint32
        lib.VCI_OpenDevice.argtypes = [u32, u32, u32]
        lib.VCI_OpenDevice.restype = u32
        lib.VCI_CloseDevice.argtypes = [u32, u32]
        lib.VCI_CloseDevice.restype = u32
        lib.VCI_InitCAN.argtypes = [u32, u32, u32, C.POINTER(VCI_CANFD_INIT_CONFIG)]
        lib.VCI_InitCAN.restype = u32
        for name in ("VCI_StartCAN", "VCI_ResetCAN", "VCI_ClearBuffer"):
            fn = getattr(lib, name)
            fn.argtypes = [u32, u32, u32]
            fn.restype = u32
        lib.VCI_GetReceiveNum.argtypes = [u32, u32, u32]
        lib.VCI_GetReceiveNum.restype = u32
        lib.VCI_Transmit.argtypes = [u32, u32, u32, C.POINTER(VCI_CAN_MSG), u32]
        lib.VCI_Transmit.restype = u32
        lib.VCI_Receive.argtypes = [u32, u32, u32, C.POINTER(VCI_CAN_MSG), u32, u32]
        lib.VCI_Receive.restype = u32
        lib.VCI_TransmitFD.argtypes = [u32, u32, u32, C.POINTER(VCI_CANFD_MSG), u32]
        lib.VCI_TransmitFD.restype = u32
        lib.VCI_ReceiveFD.argtypes = [u32, u32, u32, C.POINTER(VCI_CANFD_MSG), u32, u32]
        lib.VCI_ReceiveFD.restype = u32

        if hasattr(lib, "VCI_ReadBoardInfo"):
            lib.VCI_ReadBoardInfo.argtypes = [u32, u32, C.POINTER(VCI_BOARD_INFO)]
            lib.VCI_ReadBoardInfo.restype = u32
        if hasattr(lib, "VCI_ReadCANStatus"):
            lib.VCI_ReadCANStatus.argtypes = [u32, u32, u32, C.POINTER(VCI_CAN_STATUS)]
            lib.VCI_ReadCANStatus.restype = u32
        if hasattr(lib, "VCI_ReadErrInfo"):
            # Use a generously sized raw buffer because SDK revisions expose two error layouts.
            lib.VCI_ReadErrInfo.argtypes = [u32, u32, u32, C.c_void_p]
            lib.VCI_ReadErrInfo.restype = u32
        if hasattr(lib, "VCI_SetReference"):
            lib.VCI_SetReference.argtypes = [u32, u32, u32, u32, C.c_void_p]
            lib.VCI_SetReference.restype = u32
        if hasattr(lib, "VCI_GetReference"):
            lib.VCI_GetReference.argtypes = [u32, u32, u32, u32, C.c_void_p]
            lib.VCI_GetReference.restype = u32

        lin_signatures = {
            "VCI_InitLIN": ([u32, u32, u32, C.POINTER(VCI_LIN_INIT_CONFIG)], u32),
            "VCI_StartLIN": ([u32, u32, u32], u32),
            "VCI_ResetLIN": ([u32, u32, u32], u32),
            "VCI_TransmitLIN": ([u32, u32, u32, C.POINTER(VCI_LIN_MSG), u32], u32),
            "VCI_GetLINReceiveNum": ([u32, u32, u32], u32),
            "VCI_ClearLINBuffer": ([u32, u32, u32], u32),
            "VCI_ReceiveLIN": ([u32, u32, u32, C.POINTER(VCI_LIN_MSG), u32, u32], u32),
            "VCI_SetLINSubscribe": ([u32, u32, u32, C.POINTER(VCI_LIN_SUBSCRIBE_CFG), u32], u32),
            "VCI_SetLINPublish": ([u32, u32, u32, C.POINTER(VCI_LIN_PUBLISH_CFG), u32], u32),
        }
        for name, (argtypes, restype) in lin_signatures.items():
            if hasattr(lib, name):
                fn = getattr(lib, name)
                fn.argtypes = argtypes
                fn.restype = restype

    def _set_reference(self, channel: int, command: int, value: Any, strict: bool = True) -> int:
        if not self.lib or not hasattr(self.lib, "VCI_SetReference"):
            if strict:
                raise DriverError("当前动态库未导出 VCI_SetReference")
            return 0
        ptr = C.cast(C.byref(value), C.c_void_p)
        ret = int(self.lib.VCI_SetReference(self.dev_type, self.dev_index, channel, command, ptr))
        self.capability_results[f"set_ref/{channel}/{command:#x}"] = {"status": ret, "type": type(value).__name__}
        if strict and ret != STATUS_OK:
            raise DriverError(f"VCI_SetReference 失败: CAN{channel}, cmd={command:#x}, status={ret}")
        return ret

    def _get_reference(self, channel: int, command: int, value: Any, strict: bool = True) -> int:
        if not self.lib or not hasattr(self.lib, "VCI_GetReference"):
            if strict:
                raise DriverError("当前动态库未导出 VCI_GetReference")
            return 0
        ptr = C.cast(C.byref(value), C.c_void_p)
        ret = int(self.lib.VCI_GetReference(self.dev_type, self.dev_index, channel, command, ptr))
        self.capability_results[f"get_ref/{channel}/{command:#x}"] = {"status": ret, "type": type(value).__name__}
        if strict and ret != STATUS_OK:
            raise DriverError(f"VCI_GetReference 失败: CAN{channel}, cmd={command:#x}, status={ret}")
        return ret

    def open(self, config: DeviceConfig) -> Dict[str, Any]:
        with self.lock:
            self._operation("running", "清理旧连接")
            self.close()
            self._operation("running", "检查上传包中的 x86-64 动态库")
            self.config = config
            self.capability_results = {}
            self.periodic_slots = {0: {}, 1: {}}
            self.queue_enabled = {0: False, 1: False}
            self.lib, self.lib_path = locate_library()
            self._bind()

            preflight = self.preflight()
            self.capability_results["preflight"] = preflight
            skip_usb = os.getenv("ZLGCAN_SKIP_USB_PREFLIGHT") == "1"
            if not skip_usb and not preflight["usb"].get("found"):
                self._operation("failed", "USB 设备未发现", error=preflight["usb"].get("summary"), preflight=preflight)
                raise DriverError(
                    f"{preflight['usb'].get('summary')}。目标 VID:PID={USB_VENDOR_ID}:{USB_PRODUCT_ID}。"
                    "请执行 lsusb -d 3068:0009；若无输出，先检查 USB 连接。"
                )
            if not skip_usb and not preflight["usb"].get("accessible"):
                self._operation("failed", "USB 权限不足", error=preflight["usb"].get("summary"), preflight=preflight)
                nodes = ", ".join(item.get("node", "") for item in preflight["usb"].get("devices", []))
                raise DriverError(
                    f"{preflight['usb'].get('summary')}：{nodes}。"
                    "执行 sudo ./tools/install_udev_rule.sh，然后重新插拔设备。"
                )

            requested_type = int(config.device_type)
            probe_types = [requested_type]
            # Official Linux SDK 1.0.14 demos use type 33. Newer cross-platform
            # enums may identify USBCANFD-200U as 41, so probe the alternate value.
            if requested_type == ZCAN_USBCANFD_LINUX:
                probe_types.append(ZCAN_USBCANFD_200U_ENUM)
            elif requested_type == ZCAN_USBCANFD_200U_ENUM:
                probe_types.append(ZCAN_USBCANFD_LINUX)
            open_results = {}
            self._operation("running", "调用 VCI_OpenDevice", device_types=probe_types, device_index=self.dev_index)
            for candidate in probe_types:
                ret = int(self.lib.VCI_OpenDevice(candidate, self.dev_index, 0))
                open_results[candidate] = ret
                if ret == STATUS_OK:
                    self.active_device_type = candidate
                    break
            if self.active_device_type is None:
                self._operation("failed", "VCI_OpenDevice 失败", results=open_results, preflight=preflight)
                raise DriverError(
                    f"VCI_OpenDevice 失败: index={self.dev_index}, 尝试结果={open_results}。"
                    "检查 USB 权限、设备索引，以及 SDK Demo 中定义的设备类型。"
                )
            self.capability_results["device_type_probe"] = {
                "requested": requested_type, "selected": self.active_device_type, "results": open_results
            }
            self.opened = True
            try:
                for channel, cfg in enumerate(config.channels):
                    self._operation("running", f"初始化 CAN{channel}", selected_device_type=self.active_device_type)
                    if not cfg.enabled:
                        continue
                    abit = calculate_bit_timing(cfg.arbitration_bitrate, 0.80)
                    effective_dbit = cfg.data_bitrate if cfg.protocol == "canfd" else cfg.arbitration_bitrate
                    dbit = calculate_bit_timing(effective_dbit, 0.75 if effective_dbit >= 5_000_000 else 0.80)
                    init = VCI_CANFD_INIT_CONFIG()
                    init.clk = CLOCK_HZ
                    init.mode = 1 if cfg.mode == "listen_only" else 0
                    if cfg.canfd_standard == "non_iso" and cfg.protocol == "canfd":
                        init.mode |= 2
                    init.abit = abit
                    init.dbit = dbit
                    ret = int(self.lib.VCI_InitCAN(self.dev_type, self.dev_index, channel, C.byref(init)))
                    if ret != STATUS_OK:
                        raise DriverError(
                            f"VCI_InitCAN CAN{channel} 失败，status={ret}，"
                            f"abit={timing_dict(abit)}, dbit={timing_dict(dbit)}"
                        )
                    if int(self.lib.VCI_StartCAN(self.dev_type, self.dev_index, channel)) != STATUS_OK:
                        raise DriverError(f"VCI_StartCAN CAN{channel} 失败")
                    self.channels[channel] = True
                    self.capability_results[f"timing/{channel}"] = {
                        "arbitration_bitrate": cfg.arbitration_bitrate,
                        "data_bitrate": effective_dbit,
                        "abit": timing_dict(abit),
                        "dbit": timing_dict(dbit),
                        "clock_hz": CLOCK_HZ,
                    }
                    if hasattr(self.lib, "VCI_SetReference"):
                        self._set_reference(channel, CMD_CAN_TX_TIMEOUT, C.c_uint32(cfg.tx_timeout_ms), False)
                        self._set_reference(channel, CMD_CAN_TRES, C.c_uint8(1 if cfg.resistance_120ohm else 0), False)
                        if cfg.receive_merge:
                            raise DriverError(
                                "receive_merge 暂未开放：启用后必须改用 VCI_ReceiveData 合并接收 ABI，"
                                "不能与逐通道 VCI_Receive/VCI_ReceiveFD 混用"
                            )
                self._open_lin(config)
                self.stop_evt.clear()
                self.rx_threads = []
                for channel in self.channels:
                    thread = threading.Thread(
                        target=self._rx_loop,
                        args=(channel,),
                        daemon=True,
                        name=f"vci-rx-{channel}",
                    )
                    thread.start()
                    self.rx_threads.append(thread)
                for channel in self.lin_channels:
                    thread = threading.Thread(
                        target=self._lin_rx_loop,
                        args=(channel,),
                        daemon=True,
                        name=f"vci-lin-rx-{channel}",
                    )
                    thread.start()
                    self.rx_threads.append(thread)
                self._operation("success", "设备已打开", selected_device_type=self.active_device_type, can_started=sorted(self.channels), lin_started=sorted(self.lin_channels))
                return self.status()
            except Exception as exc:
                failed_state = dict(self.operation_state)
                self.close()
                if failed_state.get("state") == "failed":
                    self.operation_state = failed_state
                else:
                    self._operation("failed", failed_state.get("stage", "打开设备失败"), error=str(exc))
                raise

    def _open_lin(self, config: DeviceConfig) -> None:
        if not all(hasattr(self.lib, name) for name in ("VCI_InitLIN", "VCI_StartLIN")):
            return
        checksum = {"classic": 1, "enhanced": 2, "auto": 3}
        for channel, cfg in enumerate(config.lin_channels):
            if not cfg.enabled:
                continue
            init = VCI_LIN_INIT_CONFIG(
                1 if cfg.mode == "master" else 0,
                checksum[cfg.checksum],
                0,
                cfg.baudrate,
            )
            ret = int(self.lib.VCI_InitLIN(self.dev_type, self.dev_index, channel, C.byref(init)))
            if ret == STATUS_OK:
                ret = int(self.lib.VCI_StartLIN(self.dev_type, self.dev_index, channel))
            if ret == STATUS_OK:
                self.lin_channels[channel] = True
            else:
                self.capability_results[f"lin/{channel}/open"] = {"status": ret, "message": "LIN init/start failed"}

    def close(self) -> None:
        self.stop_evt.set()
        for thread in getattr(self, "rx_threads", []):
            if thread.is_alive():
                thread.join(timeout=0.3)
        if self.lib and self.opened:
            for channel in list(getattr(self, "lin_channels", {})):
                try:
                    if hasattr(self.lib, "VCI_ResetLIN"):
                        self.lib.VCI_ResetLIN(self.dev_type, self.dev_index, channel)
                except Exception:
                    pass
            for channel in list(getattr(self, "channels", {})):
                try:
                    self.lib.VCI_ResetCAN(self.dev_type, self.dev_index, channel)
                except Exception:
                    pass
            try:
                self.lib.VCI_CloseDevice(self.dev_type, self.dev_index)
            except Exception:
                pass
        self.opened = False
        self.active_device_type: Optional[int] = None
        self.channels = {}
        self.lin_channels = {}
        self.rx_threads = []

    def _rx_loop(self, channel: int) -> None:
        while not self.stop_evt.wait(0.001):
            try:
                count = min(int(self.lib.VCI_GetReceiveNum(self.dev_type, self.dev_index, channel)), 512)
                if count:
                    frames = (VCI_CAN_MSG * count)()
                    got = int(
                        self.lib.VCI_Receive(
                            self.dev_type, self.dev_index, channel, frames, count, 0
                        )
                    )
                    for index in range(min(got, count)):
                        self._emit_can(frames[index], False, channel)
                fd_selector = channel | 0x80000000
                count_fd = min(int(self.lib.VCI_GetReceiveNum(self.dev_type, self.dev_index, fd_selector)), 512)
                if count_fd:
                    frames_fd = (VCI_CANFD_MSG * count_fd)()
                    got_fd = int(
                        self.lib.VCI_ReceiveFD(
                            self.dev_type, self.dev_index, channel, frames_fd, count_fd, 0
                        )
                    )
                    for index in range(min(got_fd, count_fd)):
                        self._emit_can(frames_fd[index], True, channel)
            except Exception as exc:
                log.exception("CAN%d receive failed", channel)
                self.capability_results[f"rx/{channel}"] = {"error": str(exc)}
                time.sleep(0.1)

    def _lin_rx_loop(self, channel: int) -> None:
        if not all(hasattr(self.lib, name) for name in ("VCI_GetLINReceiveNum", "VCI_ReceiveLIN")):
            return
        while not self.stop_evt.wait(0.002):
            try:
                count = min(
                    int(self.lib.VCI_GetLINReceiveNum(self.dev_type, self.dev_index, channel)),
                    256,
                )
                if not count:
                    continue
                frames = (VCI_LIN_MSG * count)()
                got = int(
                    self.lib.VCI_ReceiveLIN(
                        self.dev_type, self.dev_index, channel, frames, count, 0
                    )
                )
                for index in range(min(got, count)):
                    msg = frames[index]
                    if int(msg.dataType) == 0:
                        data = msg.data.linData
                        rx = data.RxData
                        length = min(int(rx.dataLen), 8)
                        self.on_frame(
                            {
                                "timestamp_ns": int(rx.timeStamp) * 1000,
                                "device_timestamp_us": int(rx.timeStamp),
                                "direction": "tx" if int(rx.dir) else "rx",
                                "channel": channel,
                                "frame_kind": "lin",
                                "can_id": int(data.PID) & 0x3F,
                                "extended": False,
                                "remote": False,
                                "brs": False,
                                "esi": False,
                                "data": [int(rx.data[i]) for i in range(length)],
                                "checksum": int(rx.chkSum),
                                "source": "zlgcan_vci",
                            }
                        )
                    elif int(msg.dataType) == 1:
                        error = msg.data.linError
                        self.on_frame(
                            {
                                "timestamp_ns": int(error.timeStamp) * 1000,
                                "device_timestamp_us": int(error.timeStamp),
                                "direction": "rx",
                                "channel": channel,
                                "frame_kind": "lin",
                                "can_id": int(error.PID) & 0x3F,
                                "extended": False,
                                "remote": False,
                                "brs": False,
                                "esi": False,
                                "data": [int(error.Data[i]) for i in range(min(int(error.dataLen), 8))],
                                "lin_error_bits": int(error.errBits),
                                "source": "zlgcan_vci_error",
                            }
                        )
            except Exception as exc:
                self.capability_results[f"lin_rx/{channel}"] = {"error": str(exc)}
                time.sleep(0.1)

    def _emit_can(self, msg: Any, fd: bool, fallback_channel: int) -> None:
        flags = int(msg.flags)
        length = min(int(msg.length), 64 if fd else 8)
        channel = int(msg.channel)
        if channel not in (0, 1):
            channel = fallback_channel
        self.on_frame(
            {
                "timestamp_ns": int(msg.timestamp) * 1000,
                "device_timestamp_us": int(msg.timestamp),
                "direction": "tx" if flags & FLAG_TX else "rx",
                "channel": channel,
                "frame_kind": "canfd" if fd else "can",
                "can_id": int(msg.can_id) & (0x1FFFFFFF if flags & FLAG_EXT else 0x7FF),
                "extended": bool(flags & FLAG_EXT),
                "remote": bool(flags & FLAG_RTR),
                "brs": bool(flags & FLAG_BRS),
                "esi": bool(flags & FLAG_ESI),
                "data": [int(msg.data[i]) for i in range(length)],
                "source": "zlgcan_vci",
            }
        )

    def _frame_flags(self, frame: CanFrame, fd: bool, queue: bool = False) -> int:
        flags = TX_MODE[frame.tx_mode] & FLAG_TX_MODE_MASK
        if fd:
            flags |= FLAG_CANFD
        if frame.remote:
            flags |= FLAG_RTR
        if frame.extended:
            flags |= FLAG_EXT
        if frame.brs:
            flags |= FLAG_BRS
        if frame.esi:
            flags |= FLAG_ESI
        if queue:
            flags |= FLAG_QSEND
        return flags

    def _build_can(self, frame: CanFrame, queue_delay: int = 0, precision_100us: bool = False) -> VCI_CAN_MSG:
        msg = VCI_CAN_MSG()
        msg.can_id = int(frame.can_id)
        msg.flags = self._frame_flags(frame, False, queue=queue_delay > 0)
        if queue_delay > 0 and precision_100us:
            msg.flags |= FLAG_QSEND_100US
        msg.delay = queue_delay
        msg.channel = frame.channel
        msg.length = len(frame.data)
        for index, value in enumerate(frame.data):
            msg.data[index] = value
        return msg

    def _build_canfd(self, frame: CanFrame, queue_delay: int = 0, precision_100us: bool = False) -> VCI_CANFD_MSG:
        msg = VCI_CANFD_MSG()
        msg.can_id = int(frame.can_id)
        msg.flags = self._frame_flags(frame, True, queue=queue_delay > 0)
        if queue_delay > 0 and precision_100us:
            msg.flags |= FLAG_QSEND_100US
        msg.delay = queue_delay
        msg.channel = frame.channel
        msg.length = len(frame.data)
        for index, value in enumerate(frame.data):
            msg.data[index] = value
        return msg

    def transmit(self, frame: CanFrame) -> int:
        if frame.channel not in self.channels:
            raise DriverError(f"CAN{frame.channel} 未启动")
        if self.config and self.config.channels[frame.channel].protocol == "can" and frame.frame_kind == "canfd":
            raise DriverError(f"CAN{frame.channel} 配置为 Classic CAN，拒绝发送 CAN FD 帧")
        if frame.frame_kind == "canfd":
            msg = self._build_canfd(frame)
            ret = int(
                self.lib.VCI_TransmitFD(
                    self.dev_type, self.dev_index, frame.channel, C.byref(msg), 1
                )
            )
        else:
            msg = self._build_can(frame)
            ret = int(
                self.lib.VCI_Transmit(
                    self.dev_type, self.dev_index, frame.channel, C.byref(msg), 1
                )
            )
        if ret == 1:
            self.on_frame(dict(timestamp_ns=time.time_ns(), direction="tx", source="host", **frame.dict()))
        return ret

    def status(self) -> Dict[str, Any]:
        info: Dict[str, Any] = {}
        if self.opened and hasattr(self.lib, "VCI_ReadBoardInfo"):
            board = VCI_BOARD_INFO()
            ret = int(self.lib.VCI_ReadBoardInfo(self.dev_type, self.dev_index, C.byref(board)))
            if ret == STATUS_OK:
                info = {
                    "hardware_version": _version(board.hw_Version),
                    "firmware_version": _version(board.fw_Version),
                    "driver_version": _version(board.dr_Version),
                    "interface_version": _version(board.in_Version),
                    "can_channels": int(board.can_Num),
                    "serial": _decode_bytes(board.str_Serial_Num),
                    "hardware": _decode_bytes(board.str_hw_Type),
                }
        has_ref_set = bool(self.lib and hasattr(self.lib, "VCI_SetReference"))
        has_ref_get = bool(self.lib and hasattr(self.lib, "VCI_GetReference"))
        return {
            "opened": self.opened,
            "online": self.opened,
            "driver": "zlgcan_vci_linux",
            "library": self.lib_path,
            "abi": "VCI_*",
            "device_type": self.dev_type,
            "device_info": info,
            "can_started": sorted(self.channels),
            "lin_started": sorted(self.lin_channels),
            "capability_probe": self.capability_results,
            "operation": self.operation_state,
            "capabilities": {
                "can": True,
                "canfd": True,
                "lin": bool(self.lib and hasattr(self.lib, "VCI_InitLIN")),
                "hardware_filters": 64 if has_ref_set else 0,
                "hardware_periodic": 8 if has_ref_set else 0,
                "hardware_periodic_note": "Linux public VCI demo exposes 8 entries per table; larger firmware limits require hardware verification",
                "tx_queue": has_ref_set,
                "tx_queue_clear": has_ref_set,
                "internal_resistance": has_ref_set,
                "raw_reference": has_ref_set or has_ref_get,
                "reference_backend": "VCI_SetReference/VCI_GetReference" if has_ref_set or has_ref_get else None,
                "receive_merge": False,
                "lin_schedule": False,
            },
        }

    def clear_buffer(self, channel: int) -> None:
        if channel not in self.channels:
            raise DriverError(f"CAN{channel} 未启动")
        ret = int(self.lib.VCI_ClearBuffer(self.dev_type, self.dev_index, channel))
        if ret != STATUS_OK:
            raise DriverError(f"清空 CAN{channel} 接收缓冲失败，status={ret}")

    def reset_channel(self, channel: int) -> None:
        if channel not in self.channels:
            raise DriverError(f"CAN{channel} 未启动")
        if int(self.lib.VCI_ResetCAN(self.dev_type, self.dev_index, channel)) != STATUS_OK:
            raise DriverError(f"VCI_ResetCAN CAN{channel} 失败")
        if int(self.lib.VCI_StartCAN(self.dev_type, self.dev_index, channel)) != STATUS_OK:
            raise DriverError(f"VCI_StartCAN CAN{channel} 失败")

    def _queue_uint(self, channel: int, command: int) -> Optional[int]:
        if not hasattr(self.lib, "VCI_GetReference"):
            return None
        value = C.c_uint32(0)
        ret = self._get_reference(channel, command, value, False)
        return int(value.value) if ret == STATUS_OK else None

    def diagnostics(self, channel: int) -> Dict[str, Any]:
        if channel not in self.channels:
            raise DriverError(f"CAN{channel} 未启动")
        output: Dict[str, Any] = {
            "channel": channel,
            "rx_pending_can": int(self.lib.VCI_GetReceiveNum(self.dev_type, self.dev_index, channel)),
            "rx_pending_canfd": int(
                self.lib.VCI_GetReceiveNum(self.dev_type, self.dev_index, channel | 0x80000000)
            ),
            "tx_queue_size": self._queue_uint(channel, CMD_GET_SEND_QUEUE_SIZE),
            "tx_queue_space": self._queue_uint(channel, CMD_GET_SEND_QUEUE_SPACE),
        }
        if hasattr(self.lib, "VCI_ReadCANStatus"):
            status = VCI_CAN_STATUS()
            ret = int(
                self.lib.VCI_ReadCANStatus(
                    self.dev_type, self.dev_index, channel, C.byref(status)
                )
            )
            output["channel_status_status"] = ret
            if ret == STATUS_OK:
                output.update(
                    {
                        "status_register": int(status.regStatus),
                        "rx_errors": int(status.regRECounter),
                        "tx_errors": int(status.regTECounter),
                        "error_warning_limit": int(status.regEWLimit),
                        "error_capture": int(status.regECCapture),
                        "arbitration_lost_capture": int(status.regALCapture),
                        "bus_off": bool(status.regStatus & 0x80),
                    }
                )
        if hasattr(self.lib, "VCI_ReadErrInfo"):
            raw = (C.c_ubyte * 80)()
            ret = int(
                self.lib.VCI_ReadErrInfo(
                    self.dev_type, self.dev_index, channel, C.cast(raw, C.c_void_p)
                )
            )
            output["error_info_status"] = ret
            if ret == STATUS_OK:
                output["error_info_raw_hex"] = bytes(raw).hex()
        return output

    def configure_filters(self, channel: int, filters: List[FilterItem]) -> Dict[str, Any]:
        if channel not in self.channels:
            raise DriverError(f"CAN{channel} 未启动")
        if len(filters) > 64:
            raise DriverError("硬件过滤最多 64 条")
        table = VCI_FILTER_TABLE()
        table.size = C.sizeof(VCI_FILTER) * len(filters)
        for index, item in enumerate(filters):
            table.table[index].type = 1 if item.extended else 0
            table.table[index].start_id = item.start_id
            table.table[index].end_id = item.end_id
        self._set_reference(channel, CMD_CAN_FILTER, table)
        return {"channel": channel, "count": len(filters), "max": 64, "backend": "VCI_SetReference(0x14)"}

    def _sync_hardware_periodic(self, channel: int) -> Dict[str, Any]:
        slots = self.periodic_slots[channel]
        if len(slots) > 8:
            raise DriverError("当前 Linux VCI 定时发送表一次最多配置 8 条")
        if not slots:
            self._set_reference(channel, CMD_CAN_TTX_CTL, C.c_uint32(0))
            return {
                "channel": channel,
                "active": 0,
                "indices": [],
                "backend": "VCI_SetReference(0x17)",
                "interval_unit": "100us",
                "max_per_table": 8,
            }
        cfg = VCI_TTX_CONFIG()
        cfg.size = C.sizeof(VCI_TTX) * len(slots)
        for table_index, (slot_index, saved) in enumerate(sorted(slots.items())):
            item = cfg.table[table_index]
            item.interval = max(1, int(round(float(saved.period_ms) * 10)))
            item.repeat = 0
            item.index = slot_index
            item.flags = 1
            item.msg = self._build_canfd(saved) if saved.frame_kind == "canfd" else self._classic_as_fd_container(saved)
        self._set_reference(channel, CMD_CAN_TTX, cfg)
        self._set_reference(channel, CMD_CAN_TTX_CTL, C.c_uint32(1))
        return {
            "channel": channel,
            "active": len(slots),
            "indices": sorted(slots),
            "backend": "VCI_SetReference(0x16/0x17)",
            "interval_unit": "100us",
            "max_per_table": 8,
        }

    def _classic_as_fd_container(self, frame: CanFrame) -> VCI_CANFD_MSG:
        msg = VCI_CANFD_MSG()
        msg.can_id = int(frame.can_id)
        msg.flags = self._frame_flags(frame, False)
        msg.channel = frame.channel
        msg.length = len(frame.data)
        for index, value in enumerate(frame.data):
            msg.data[index] = value
        return msg

    def configure_hardware_periodic(self, msg: SavedMessage) -> Dict[str, Any]:
        if msg.channel not in self.channels:
            raise DriverError(f"CAN{msg.channel} 未启动")
        if msg.hardware_index is None or msg.period_ms is None:
            raise DriverError("硬件定时发送需要 hardware_index 和 period_ms")
        if msg.hardware_index > 7:
            raise DriverError(
                "当前 Linux VCI ABI 的公开定时发送表仅验证索引 0..7；"
                "不要直接使用网页旧版的 0..99 范围"
            )
        if self.config and self.config.channels[msg.channel].protocol == "can" and msg.frame_kind == "canfd":
            raise DriverError(f"CAN{msg.channel} 配置为 Classic CAN，拒绝配置 CAN FD 硬件周期帧")
        if msg.enabled:
            self.periodic_slots[msg.channel][msg.hardware_index] = msg
        else:
            self.periodic_slots[msg.channel].pop(msg.hardware_index, None)
        result = self._sync_hardware_periodic(msg.channel)
        result.update({"index": msg.hardware_index, "period_ms": msg.period_ms, "enabled": msg.enabled})
        if msg.hardware_start_delay_ms:
            result["warning"] = "Linux VCI_TTX 结构不包含启动延时字段，hardware_start_delay_ms 未下发"
        return result

    def clear_hardware_periodic(self, channel: int) -> Dict[str, Any]:
        if channel not in self.channels:
            raise DriverError(f"CAN{channel} 未启动")
        self.periodic_slots[channel].clear()
        return self._sync_hardware_periodic(channel)

    def _ensure_queue_enabled(self, channel: int) -> None:
        if self.queue_enabled[channel]:
            return
        self._set_reference(channel, CMD_SET_SEND_QUEUE_EN, C.c_uint8(1))
        self.queue_enabled[channel] = True

    def queue_transmit(self, items: List[HardwareQueueFrame]) -> Dict[str, Any]:
        accepted = 0
        for item in items:
            if item.channel not in self.channels:
                raise DriverError(f"CAN{item.channel} 未启动")
            if self.config and self.config.channels[item.channel].protocol == "can" and item.frame_kind == "canfd":
                raise DriverError(f"CAN{item.channel} 配置为 Classic CAN，拒绝发送 CAN FD 队列帧")
            units = int(round(item.delay_ms * 10 if item.precision_100us else item.delay_ms))
            if units < 0 or units > 0xFFFF:
                unit = "0.1 ms" if item.precision_100us else "ms"
                raise DriverError(f"队列延时超出 16 位范围: {units} {unit}")
            self._ensure_queue_enabled(item.channel)
            available = self._queue_uint(item.channel, CMD_GET_SEND_QUEUE_SPACE)
            if available is not None and available < 1:
                raise DriverError(f"CAN{item.channel} 硬件发送队列已满")
            # qsend is meaningful even for zero delay; use 1 as an explicit queue marker only when requested.
            queue_units = units if units > 0 else 1
            if item.frame_kind == "canfd":
                msg = self._build_canfd(item, queue_units, item.precision_100us)
                if units == 0:
                    msg.delay = 0
                ret = int(
                    self.lib.VCI_TransmitFD(
                        self.dev_type, self.dev_index, item.channel, C.byref(msg), 1
                    )
                )
            else:
                msg = self._build_can(item, queue_units, item.precision_100us)
                if units == 0:
                    msg.delay = 0
                ret = int(
                    self.lib.VCI_Transmit(
                        self.dev_type, self.dev_index, item.channel, C.byref(msg), 1
                    )
                )
            accepted += ret
            if ret == 1:
                payload = item.dict(exclude={"delay_ms", "precision_100us"})
                self.on_frame(
                    dict(
                        timestamp_ns=time.time_ns(),
                        direction="tx",
                        source="host_queue",
                        queue_delay_ms=item.delay_ms,
                        **payload,
                    )
                )
        return {
            "requested": len(items),
            "accepted": accepted,
            "delay_encoding": "ZCAN_MSG_HDR.pad uint16",
            "precision": "0.1ms when precision_100us=true; otherwise 1ms",
            "backend": "VCI_SetReference(0x103) + VCI_Transmit/VCI_TransmitFD",
        }

    def clear_tx_queue(self, channel: int) -> Dict[str, Any]:
        if channel not in self.channels:
            raise DriverError(f"CAN{channel} 未启动")
        self._set_reference(channel, CMD_SET_SEND_QUEUE_CLR, C.c_uint8(1))
        return {
            "channel": channel,
            "cleared": True,
            "queue_size": self._queue_uint(channel, CMD_GET_SEND_QUEUE_SIZE),
            "queue_space": self._queue_uint(channel, CMD_GET_SEND_QUEUE_SPACE),
        }

    _REFERENCE_ALIASES = {
        "timed_send_enable": CMD_CAN_TTX_CTL,
        "resistance": CMD_CAN_TRES,
        "receive_merge_set": CMD_SET_CHNL_RECV_MERGE,
        "receive_merge_get": CMD_GET_CHNL_RECV_MERGE,
        "tx_timeout": CMD_CAN_TX_TIMEOUT,
        "tx_queue_size": CMD_GET_SEND_QUEUE_SIZE,
        "tx_queue_space": CMD_GET_SEND_QUEUE_SPACE,
        "tx_queue_clear": CMD_SET_SEND_QUEUE_CLR,
        "tx_queue_enable": CMD_SET_SEND_QUEUE_EN,
    }

    def _parse_reference_path(self, path: str) -> Tuple[int, int]:
        text = path.strip()
        if "/" in text:
            channel_text, command_text = text.split("/", 1)
            channel = int(channel_text, 0)
        else:
            channel = 0
            command_text = text
        if channel not in (0, 1):
            raise DriverError("Reference channel 必须为 0 或 1")
        command_text = command_text.strip().lower()
        command = self._REFERENCE_ALIASES.get(command_text)
        if command is None:
            try:
                command = int(command_text, 0)
            except ValueError as exc:
                raise DriverError(
                    "Reference 路径格式应为 0/0x18、1/0x100 或 0/resistance"
                ) from exc
        return channel, command

    def set_property(self, path: str, value: str) -> Dict[str, Any]:
        channel, command = self._parse_reference_path(path)
        try:
            number = int(value.strip(), 0)
        except ValueError as exc:
            raise DriverError("原始 Reference 当前仅支持整数值，可使用十进制或 0x 十六进制") from exc
        if command in (CMD_CAN_FILTER, CMD_CAN_TTX):
            raise DriverError("该 Reference 需要结构体，请使用硬件过滤或硬件周期专用接口")
        if command in (CMD_CAN_TRES, CMD_SET_SEND_QUEUE_CLR, CMD_SET_SEND_QUEUE_EN):
            obj: Any = C.c_uint8(number)
        else:
            obj = C.c_uint32(number)
        status = self._set_reference(channel, command, obj, False)
        return {
            "path": path,
            "channel": channel,
            "command": hex(command),
            "value": number,
            "status": status,
            "backend": "VCI_SetReference",
        }

    def get_property(self, path: str) -> Dict[str, Any]:
        channel, command = self._parse_reference_path(path)
        value = C.c_uint32(0)
        status = self._get_reference(channel, command, value, False)
        return {
            "path": path,
            "channel": channel,
            "command": hex(command),
            "value": int(value.value),
            "status": status,
            "backend": "VCI_GetReference",
        }

    def lin_transmit(self, frame: LinFrame) -> int:
        if frame.channel not in self.lin_channels:
            raise DriverError(f"LIN{frame.channel} 未启动")
        if not hasattr(self.lib, "VCI_TransmitLIN"):
            raise DriverError("当前动态库未导出 VCI_TransmitLIN")
        msg = VCI_LIN_MSG()
        msg.channel = frame.channel
        msg.dataType = 0
        msg.data.linData.PID = frame.pid
        msg.data.linData.RxData.dataLen = len(frame.data)
        msg.data.linData.RxData.dir = 1 if frame.direction == "publish" else 0
        for index, value in enumerate(frame.data):
            msg.data.linData.RxData.data[index] = value
        return int(
            self.lib.VCI_TransmitLIN(
                self.dev_type, self.dev_index, frame.channel, C.byref(msg), 1
            )
        )

    def lin_subscribe(self, cfg: LinSubscribe) -> Dict[str, Any]:
        if cfg.channel not in self.lin_channels or not hasattr(self.lib, "VCI_SetLINSubscribe"):
            raise DriverError("LIN subscribe 不可用")
        array = (VCI_LIN_SUBSCRIBE_CFG * len(cfg.pids))()
        for index, pid in enumerate(cfg.pids):
            array[index].ID = pid
            array[index].dataLen = 8
            array[index].chkSumMode = 3
        ret = int(
            self.lib.VCI_SetLINSubscribe(
                self.dev_type, self.dev_index, cfg.channel, array, len(array)
            )
        )
        if ret != STATUS_OK:
            raise DriverError(f"VCI_SetLINSubscribe 失败，status={ret}")
        return {"channel": cfg.channel, "count": len(cfg.pids), "status": ret}

    def lin_publish(self, cfg: LinPublish) -> Dict[str, Any]:
        if cfg.channel not in self.lin_channels or not hasattr(self.lib, "VCI_SetLINPublish"):
            raise DriverError("LIN publish 不可用")
        checksum = {"default": 0, "classic": 1, "enhanced": 2}
        array = (VCI_LIN_PUBLISH_CFG * len(cfg.frames))()
        for index, frame in enumerate(cfg.frames):
            array[index].ID = frame.pid
            array[index].dataLen = len(frame.data)
            array[index].chkSumMode = checksum[frame.checksum]
            for data_index, value in enumerate(frame.data):
                array[index].data[data_index] = value
        ret = int(
            self.lib.VCI_SetLINPublish(
                self.dev_type, self.dev_index, cfg.channel, array, len(array)
            )
        )
        if ret != STATUS_OK:
            raise DriverError(f"VCI_SetLINPublish 失败，status={ret}")
        return {"channel": cfg.channel, "count": len(cfg.frames), "status": ret}

    def lin_schedule(self, cfg: LinSchedule) -> Dict[str, Any]:
        raise DriverError(
            "当前 USBCANFD Linux VCI_* 动态库只公开 LIN 初始化、收发、Publish/Subscribe；"
            "未导出 LIN Schedule API。请使用软件调度或 Windows ZCANPRO/ZXDoc。"
        )
