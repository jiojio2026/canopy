import json
import math
import struct

import pytest
from pydantic import ValidationError

from app.signal_decoder import SignalDefinition, SignalRegistry, decode_signal


def signal(**kw):
    settings = {"name": "test", "channel": 1, "frame_kind": "canfd",
                "can_id": 0x706, "extended": False}
    settings.update(kw)
    return SignalDefinition(**settings)


def test_intel_unaligned_and_scaled():
    definition = signal(start_bit=4, bit_length=12, factor=0.1, offset=-1)
    out = decode_signal(definition, [0x10, 0x32])
    assert out["raw"] == str(0x321)
    assert out["value"] == pytest.approx(79.1)


def test_motorola_dbc_sawtooth_crossing_bytes():
    definition = signal(start_bit=7, bit_length=16, byte_order="big_endian")
    out = decode_signal(definition, [0x12, 0x34])
    assert out["raw"] == str(0x1234)
    assert out["value"] == 0x1234


def test_signed_and_64bit_unsigned_are_lossless_in_raw_field():
    assert decode_signal(signal(bit_length=8, value_type="signed"), [0xFE])["value"] == -2
    d = signal(bit_length=64)
    out = decode_signal(d, [0xFF] * 8)
    assert out["raw"] == "18446744073709551615"
    assert out["raw_hex"] == "0xFFFFFFFFFFFFFFFF"


@pytest.mark.parametrize("order,value_type,size,fmt", [
    ("little_endian", "float32", 32, "<f"),
    ("big_endian", "float32", 32, ">f"),
    ("little_endian", "float64", 64, "<d"),
    ("big_endian", "float64", 64, ">d"),
])
def test_ieee754(order, value_type, size, fmt):
    definition = signal(start_bit=7 if order == "big_endian" else 0,
                        bit_length=size, byte_order=order, value_type=value_type)
    out = decode_signal(definition, list(struct.pack(fmt, 1.25)))
    assert out["value"] == pytest.approx(1.25)


def test_short_frame_shows_error_instead_of_uninitialized_data():
    out = decode_signal(signal(start_bit=56, bit_length=16), [1, 2, 3])
    assert out["value"] is None
    assert "DLC" in out["error"]


@pytest.mark.parametrize("kw", [
    {"frame_kind": "can", "start_bit": 63, "bit_length": 2},
    {"frame_kind": "canfd", "start_bit": 510, "bit_length": 4},
    {"frame_kind": "canfd", "start_bit": 504, "bit_length": 16, "byte_order": "big_endian"},
    {"value_type": "float32", "bit_length": 16},
    {"can_id": 0x1800, "extended": False},
    {"factor": float("nan")},
])
def test_reject_invalid_definitions(kw):
    with pytest.raises(ValidationError):
        signal(**kw)


def test_definition_update_persist_and_decode(tmp_path):
    from app.store import JsonState
    state = JsonState(tmp_path)
    registry = SignalRegistry()
    first = registry.save(signal(name="position", start_bit=0, bit_length=16,
                                 factor=0.01, unit="deg"), state)
    assert first["key"]
    assert len(json.loads((tmp_path / "signals.json").read_text())) == 1
    registry = SignalRegistry(state.load("signals.json", []))
    frame = {"channel": 1, "frame_kind": "canfd", "can_id": 0x706,
             "extended": False, "data": [0xF4, 0x01]}
    assert registry.enrich(frame)["decoded_signals"][0]["value"] == 5
    assert "decoded_signals" not in frame
    updated = SignalDefinition.parse_obj({**first, "factor": 0.02})
    registry.save(updated, state)
    assert registry.enrich(frame)["decoded_signals"][0]["value"] == 10
    with pytest.raises(ValueError):
        registry.save(signal(name="position"), state)
    registry.remove(first["key"], state)
    assert registry.enrich(frame) is frame
    assert state.load("signals.json", []) == []


def test_scope_separation_and_invalid_short_frame():
    registry = SignalRegistry()
    registry.save(signal(name="canfd", can_id=0x706))
    registry.save(signal(name="other_channel", can_id=0x706, channel=0))
    registry.save(signal(name="classic", can_id=0x706, frame_kind="can", bit_length=8))
    f = {"channel": 1, "frame_kind": "canfd", "can_id": 0x706,
         "extended": False, "data": [0]}
    enriched = registry.enrich(f)
    assert len(enriched["decoded_signals"]) == 1
    assert enriched["decoded_signals"][0]["error"] is not None
    assert registry.enrich({**f, "frame_kind": "lin"}) == {**f, "frame_kind": "lin"}


def test_nonfinite_float_displays_error():
    definition = signal(value_type="float32", bit_length=32)
    result = decode_signal(definition, list(struct.pack("<f", math.inf)))
    assert result["value"] is None
    assert result["error"]
