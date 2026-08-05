from __future__ import annotations
from typing import List, Optional, Literal, Dict, Any
from pydantic import BaseModel, Field, validator, root_validator

FrameKind = Literal["can", "canfd", "lin"]
TxMode = Literal["normal", "once", "self", "self_once"]

class ChannelConfig(BaseModel):
    enabled: bool = True
    protocol: Literal["can", "canfd"] = "canfd"
    arbitration_bitrate: int = Field(500000, ge=40000, le=1000000)
    data_bitrate: int = Field(2000000, ge=1000000, le=5000000)
    canfd_standard: Literal["iso", "non_iso"] = "iso"
    mode: Literal["normal", "listen_only"] = "normal"
    resistance_120ohm: bool = False
    tx_timeout_ms: int = Field(100, ge=0, le=10000)
    receive_merge: bool = False  # 保留配置兼容；当前逐通道接收后端会拒绝启用，避免 ABI 混用

    @root_validator(skip_on_failure=True)
    def protocol_consistency(cls, values):
        if values.get("protocol")=="can" and values.get("canfd_standard")!="iso":
            values["canfd_standard"]="iso"
        return values

class LinChannelConfig(BaseModel):
    enabled: bool = False
    mode: Literal["slave", "master"] = "master"
    checksum: Literal["classic", "enhanced", "auto"] = "auto"
    baudrate: int = Field(19200, ge=2400, le=20000)
    max_length: int = Field(8, ge=8, le=8)

class DeviceConfig(BaseModel):
    driver: Literal["zlgcan", "mock"] = "zlgcan"
    device_type: int = 33
    device_index: int = 0
    channels: List[ChannelConfig] = Field(default_factory=lambda: [ChannelConfig(), ChannelConfig()])
    lin_channels: List[LinChannelConfig] = Field(default_factory=lambda: [LinChannelConfig(), LinChannelConfig()])

    @validator("channels")
    def two_can_channels(cls, value):
        if len(value) != 2:
            raise ValueError("USBCANFD-200U 必须配置两个 CAN 通道")
        return value

class CanFrame(BaseModel):
    channel: int = Field(0, ge=0, le=1)
    frame_kind: Literal["can", "canfd"] = "can"
    extended: bool = False
    can_id: int = Field(..., ge=0, le=0x1FFFFFFF)
    remote: bool = False
    brs: bool = False
    esi: bool = False
    tx_mode: TxMode = "normal"
    data: List[int] = Field(default_factory=list)

    @validator("data", each_item=True)
    def byte_range(cls, value):
        if value < 0 or value > 255:
            raise ValueError("data 字节必须为 0..255")
        return value

    @validator("data")
    def data_length(cls, value, values):
        kind = values.get("frame_kind", "can")
        if kind == "canfd":
            valid={0,1,2,3,4,5,6,7,8,12,16,20,24,32,48,64}
            if len(value) not in valid:
                raise ValueError("CAN FD 数据长度必须为 0..8、12、16、20、24、32、48 或 64 字节")
        elif len(value)>8:
            raise ValueError("Classic CAN 数据长度不能超过 8 字节")
        return value

    @validator("can_id")
    def id_width(cls, value, values):
        if not values.get("extended", False) and value > 0x7FF:
            raise ValueError("标准帧 ID 不能超过 0x7FF")
        return value

    @root_validator(skip_on_failure=True)
    def protocol_flags(cls, values):
        kind=values.get("frame_kind", "can")
        if kind=="canfd" and values.get("remote"):
            raise ValueError("CAN FD 不支持远程帧")
        if kind=="can" and (values.get("brs") or values.get("esi")):
            raise ValueError("BRS/ESI 仅适用于 CAN FD")
        return values

class SavedMessage(CanFrame):
    key: str = ""
    name: str = ""
    node: str = "默认节点"
    enabled: bool = False
    period_ms: Optional[float] = Field(None, ge=0.1, le=86400000)
    scheduler: Literal["software", "hardware"] = "software"
    hardware_index: Optional[int] = Field(None, ge=0, le=99)
    hardware_start_delay_ms: int = Field(0, ge=0, le=86400000)

    @root_validator(skip_on_failure=True)
    def scheduler_fields(cls, values):
        if values.get("enabled") and values.get("period_ms") is None:
            raise ValueError("启用周期发送时 period_ms 必填")
        if values.get("scheduler")=="hardware" and values.get("hardware_index") is None:
            raise ValueError("硬件周期发送需要 hardware_index（0..99；Linux VCI 后端当前运行时仅接受 0..7）")
        return values

class FilterItem(BaseModel):
    extended: bool = False
    start_id: int = Field(..., ge=0, le=0x1FFFFFFF)
    end_id: int = Field(..., ge=0, le=0x1FFFFFFF)

    @root_validator(skip_on_failure=True)
    def validate_range(cls, values):
        start, end = values.get("start_id"), values.get("end_id")
        if start is not None and end is not None and end < start:
            raise ValueError("end_id 必须不小于 start_id")
        if not values.get("extended", False) and any(x is not None and x > 0x7FF for x in (start,end)):
            raise ValueError("标准帧过滤 ID 不能超过 0x7FF")
        return values

class FilterConfig(BaseModel):
    channel: int = Field(..., ge=0, le=1)
    filters: List[FilterItem] = Field(default_factory=list, max_items=64)

class RawProperty(BaseModel):
    path: str = Field(..., min_length=1, max_length=256)
    value: Optional[str] = Field(None, max_length=4096)

class HardwareQueueFrame(CanFrame):
    delay_ms: float = Field(0, ge=0, le=65535)
    precision_100us: bool = False

    @root_validator(skip_on_failure=True)
    def queue_delay_width(cls, values):
        delay=float(values.get("delay_ms",0)); fine=bool(values.get("precision_100us"))
        units=round(delay*10 if fine else delay)
        if units>0xFFFF:
            raise ValueError("发送队列延时编码超过 16 位：0.1 ms 精度最多 6553.5 ms，1 ms 精度最多 65535 ms")
        return values

class LinFrame(BaseModel):
    channel: int = Field(0, ge=0, le=1)
    pid: int = Field(..., ge=0, le=0x3F)
    data: List[int] = Field(default_factory=list, max_items=8)
    checksum: Literal["default", "classic", "enhanced"] = "default"
    direction: Literal["publish", "request"] = "publish"

    @validator("data", each_item=True)
    def lin_byte_range(cls, value):
        if value < 0 or value > 255:
            raise ValueError("data 字节必须为 0..255")
        return value

class LinSubscribe(BaseModel):
    channel: int = Field(0, ge=0, le=1)
    pids: List[int] = Field(default_factory=list, max_items=64)

class LinPublish(BaseModel):
    channel: int = Field(0, ge=0, le=1)
    frames: List[LinFrame] = Field(default_factory=list, max_items=64)

class LinScheduleItem(BaseModel):
    schedule_type: Literal["unconditional", "event", "sporadic", "master_request", "slave_response"] = "unconditional"
    pid: int = Field(0, ge=0, le=0x3F)
    delay_ms: int = Field(10, ge=1, le=60000)

class LinSchedule(BaseModel):
    channel: int = Field(0, ge=0, le=1)
    schedule_index: int = Field(0, ge=0, le=255)
    items: List[LinScheduleItem] = Field(..., min_items=1, max_items=256)
    enabled: bool = True
    repeat: bool = True

class TraceFilter(BaseModel):
    channel: Optional[int] = None
    direction: Optional[Literal["rx", "tx"]] = None
    frame_kind: Optional[FrameKind] = None
    id_min: Optional[int] = None
    id_max: Optional[int] = None
    text: Optional[str] = None

class APIResult(BaseModel):
    ok: bool = True
    message: str = ""
    data: Optional[Any] = None
