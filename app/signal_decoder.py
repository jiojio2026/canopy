"""User-defined CAN/CAN FD signal decoding. No DBC or external dependency required.

Bit numbering follows DBC conventions: start_bit is the LSB-numbered index within
each byte (0..7), and Motorola signals advance from bit 0 to the next byte's bit 7.
"""
from __future__ import annotations

import math
import struct
import threading
import uuid
from collections import defaultdict
from typing import Dict, List, Literal

from pydantic import BaseModel, Field, root_validator, validator


def bit_positions(start_bit: int, length: int, byte_order: str):
    if byte_order == "little_endian":
        return tuple(range(start_bit, start_bit + length))
    result = []
    bit = start_bit
    for _ in range(length):
        result.append(bit)
        bit = bit + 15 if bit % 8 == 0 else bit - 1
    return tuple(result)


class SignalDefinition(BaseModel):
    key: str = Field("", max_length=64)
    name: str = Field(..., min_length=1, max_length=64)
    channel: int = Field(0, ge=0, le=1)
    frame_kind: Literal["can", "canfd"] = "canfd"
    can_id: int = Field(..., ge=0, le=0x1FFFFFFF)
    extended: bool = False
    start_bit: int = Field(0, ge=0, le=511)
    bit_length: int = Field(16, ge=1, le=64)
    byte_order: Literal["little_endian", "big_endian"] = "little_endian"
    value_type: Literal["unsigned", "signed", "float32", "float64"] = "unsigned"
    factor: float = 1.0
    offset: float = 0.0
    unit: str = Field("", max_length=32)
    notes: str = Field("", max_length=256)
    display_mode: Literal["number", "enum", "bitfield"] = "number"
    choices: Dict[str, str] = Field(default_factory=dict)

    @validator("name", "unit", "notes")
    def trim_text(cls, value):
        return value.strip()

    @validator("factor", "offset")
    def finite_value(cls, value):
        if not math.isfinite(value):
            raise ValueError("比例因子和偏移量必须是有限数")
        return value

    @validator("choices")
    def validate_choices(cls, value):
        if len(value) > 64:
            raise ValueError("最多定义 64 个枚举或标志项")
        seen = set()
        for key, label in value.items():
            try:
                parsed = int(key, 16) if key.lower().startswith("0x") else int(key, 10)
            except (TypeError, ValueError):
                raise ValueError("映射值必须是十进制整数或 0x 十六进制整数")
            if parsed < 0 or parsed in seen or not label.strip() or len(label) > 80:
                raise ValueError("映射值不得重复，描述需为 1～80 字符")
            seen.add(parsed)
        return value

    @root_validator(skip_on_failure=True)
    def validate_signal(cls, values):
        if not values.get("extended") and values.get("can_id", 0) > 0x7FF:
            raise ValueError("标准帧 CAN ID 不得超过 0x7FF")
        size = values.get("bit_length", 0)
        kind = values.get("value_type")
        if kind == "float32" and size != 32:
            raise ValueError("float32 必须使用 32 位长度")
        if kind == "float64" and size != 64:
            raise ValueError("float64 必须使用 64 位长度")
        mode = values.get("display_mode", "number")
        choices = values.get("choices", {})
        if mode != "number":
            if kind != "unsigned" or values.get("factor") != 1 or values.get("offset") != 0:
                raise ValueError("Enum 和 Bitfield 要求 Unsigned、Factor=1、Offset=0")
            if not choices:
                raise ValueError("Enum / Bitfield 至少需要一条映射")
            max_code = (1 << size) - 1
            for code in choices:
                bit_or_code = int(code, 16) if code.lower().startswith("0x") else int(code)
                if mode == "enum" and bit_or_code > max_code:
                    raise ValueError("枚举值超出信号位宽")
                if mode == "bitfield" and bit_or_code >= size:
                    raise ValueError("标志位序号超出信号位宽")
        elif choices:
            raise ValueError("数值模式不能配置 Enum/Bitfield 映射")
        positions = bit_positions(values["start_bit"], size, values["byte_order"])
        capacity = 64 if values["frame_kind"] == "canfd" else 8
        if not positions or max(positions) >= capacity * 8:
            raise ValueError("信号位范围超出了报文最大数据长度")
        return values


class SignalImport(BaseModel):
    definitions: List[SignalDefinition] = Field(..., max_items=512)
    conflict: Literal["skip", "overwrite"] = "skip"


def choice_mapping(choices):
    return {int(code, 16) if code.lower().startswith("0x") else int(code, 10): label
            for code, label in choices.items()}


class SignalPreview(BaseModel):
    signal: SignalDefinition
    data: List[int] = Field(..., max_items=64)

    @validator("data", each_item=True)
    def valid_byte(cls, value):
        if value < 0 or value > 255:
            raise ValueError("数据字节必须在 0..255 范围")
        return value


def decode_signal(signal: SignalDefinition, data):
    output = {"key": signal.key, "name": signal.name, "unit": signal.unit,
              "value": None, "raw": None, "raw_hex": None, "error": None}
    positions = bit_positions(signal.start_bit, signal.bit_length, signal.byte_order)
    if any(position >= 8 * len(data) for position in positions):
        output["error"] = "DLC 不足：该信号超出当前数据长度"
        return output
    if signal.byte_order == "little_endian":
        raw_bits = sum(((data[p // 8] >> (p % 8)) & 1) << i
                       for i, p in enumerate(positions))
    else:
        raw_bits = 0
        for position in positions:
            raw_bits = (raw_bits << 1) | ((data[position // 8] >> (position % 8)) & 1)
    output["raw_hex"] = "0x{:X}".format(raw_bits)
    if signal.value_type.startswith("float"):
        width = signal.bit_length // 8
        encoded = raw_bits.to_bytes(width, "little" if signal.byte_order == "little_endian" else "big")
        raw_value = struct.unpack(("<" if signal.byte_order == "little_endian" else ">") +
                                  ("f" if width == 4 else "d"), encoded)[0]
    else:
        raw_value = raw_bits
        if signal.value_type == "signed" and raw_bits & (1 << (signal.bit_length - 1)):
            raw_value -= 1 << signal.bit_length
    output["raw"] = str(raw_value)
    physical = raw_value * signal.factor + signal.offset
    if not math.isfinite(physical):
        output["error"] = "解码值不是有限数"
        return output
    output["value"] = physical
    output["display_mode"] = signal.display_mode
    if signal.display_mode == "enum":
        labels = choice_mapping(signal.choices)
        output["display"] = labels.get(raw_bits, "未知枚举值 " + output["raw_hex"])
    elif signal.display_mode == "bitfield":
        labels = choice_mapping(signal.choices)
        active = [labels.get(bit, "Bit{}（未定义）".format(bit))
                  for bit in range(signal.bit_length) if raw_bits & (1 << bit)]
        output["active_flags"] = active
        output["display"] = "、".join(active) if active else "无活动标志"
    else:
        output["display"] = None
    return output


class SignalRegistry:
    MAX_SIGNALS = 512

    def __init__(self, definitions=()):
        self.lock = threading.RLock()
        self.definitions = {}
        for source in definitions:
            definition = SignalDefinition.parse_obj(source)
            if not definition.key or definition.key in self.definitions:
                raise ValueError("信号文件包含无效或重复的 key")
            self.definitions[definition.key] = definition
        if len(self.definitions) > self.MAX_SIGNALS:
            raise ValueError("信号定义超过 512 个")
        self._reindex()

    def _reindex(self):
        self.index = defaultdict(list)
        for definition in self.definitions.values():
            identity = (definition.channel, definition.frame_kind,
                        definition.can_id, definition.extended)
            self.index[identity].append(definition)
        self.index = {key: tuple(value) for key, value in self.index.items()}

    def list(self):
        with self.lock:
            return [definition.dict() for definition in self.definitions.values()]

    def save(self, definition: SignalDefinition, state=None):
        with self.lock:
            key = definition.key or str(uuid.uuid4())
            if key not in self.definitions and len(self.definitions) >= self.MAX_SIGNALS:
                raise ValueError("最多支持 512 个自定义信号")
            if definition.key and key not in self.definitions:
                raise ValueError("信号 key 不存在，不允许直接指定新 key")
            definition = definition.copy(update={"key": key})
            for existing in self.definitions.values():
                if (existing.key != key and
                    (existing.channel, existing.frame_kind, existing.can_id,
                     existing.extended, existing.name) ==
                    (definition.channel, definition.frame_kind, definition.can_id,
                     definition.extended, definition.name)):
                    raise ValueError("同一报文中已经存在同名信号")
            updated = dict(self.definitions)
            updated[key] = definition
            if state:
                state.save("signals.json", [item.dict() for item in updated.values()])
            self.definitions = updated
            self._reindex()
            return definition.dict()

    def import_many(self, definitions: List[SignalDefinition], conflict="skip", state=None):
        """Atomic merge of a saved library, resolving conflicts by message identity + signal name.

        Keys from external files are ignored so they cannot accidentally overwrite unrelated
        local definitions. All validation and persistence complete before the live index changes.
        """
        if conflict not in ("skip", "overwrite") or len(definitions) > self.MAX_SIGNALS:
            raise ValueError("不支持的导入策略或信号数量超出限制")
        with self.lock:
            updated = dict(self.definitions)
            identity_map = {
                (d.channel, d.frame_kind, d.can_id, d.extended, d.name): key
                for key, d in updated.items()
            }
            seen = set()
            added = overwritten = skipped = 0
            for item in definitions:
                identity = (item.channel, item.frame_kind, item.can_id, item.extended, item.name)
                if identity in seen:
                    raise ValueError("导入文件存在重复信号：" + item.name)
                seen.add(identity)
                existing_key = identity_map.get(identity)
                if existing_key is not None:
                    if conflict == "skip":
                        skipped += 1
                        continue
                    updated[existing_key] = item.copy(update={"key": existing_key})
                    overwritten += 1
                    continue
                if len(updated) >= self.MAX_SIGNALS:
                    raise ValueError("合并后信号数量不得超过 512")
                fresh_key = str(uuid.uuid4())
                updated[fresh_key] = item.copy(update={"key": fresh_key})
                identity_map[identity] = fresh_key
                added += 1
            if state is not None:
                state.save("signals.json", [entry.dict() for entry in updated.values()])
            self.definitions = updated
            self._reindex()
            return {"added": added, "overwritten": overwritten, "skipped": skipped,
                    "total": len(updated)}

    def remove(self, key: str, state=None):
        with self.lock:
            if key not in self.definitions:
                raise KeyError("信号不存在")
            updated = dict(self.definitions)
            del updated[key]
            if state:
                state.save("signals.json", [item.dict() for item in updated.values()])
            self.definitions = updated
            self._reindex()

    def enrich(self, frame):
        identity = (frame.get("channel"), frame.get("frame_kind"),
                    frame.get("can_id"), bool(frame.get("extended", False)))
        with self.lock:
            definitions = self.index.get(identity, ())
        if not definitions:
            return frame
        enriched = dict(frame)
        enriched["decoded_signals"] = [decode_signal(definition, frame.get("data", []))
                                       for definition in definitions]
        return enriched
