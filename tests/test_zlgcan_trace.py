import pytest

from app.drivers.zlgcan import VCI_CAN_MSG, VCI_CANFD_MSG, ZlgCanDriver
from app.store import TraceStore


@pytest.mark.parametrize("message_type, fd", [(VCI_CAN_MSG, False), (VCI_CANFD_MSG, True)])
@pytest.mark.parametrize("start_ticks", [500, (1 << 32) - 100])
def test_trace_uses_zlg_ticks_for_period_and_host_clock_for_display(
    monkeypatch, message_type, fd, start_ticks
):
    wall_ns = 1_800_000_000_000_000_000
    monkeypatch.setattr("app.drivers.zlgcan.time.time_ns", lambda: wall_ns)
    trace = TraceStore()
    driver = ZlgCanDriver(trace.add)
    msg = message_type()
    msg.can_id = 0x181
    msg.timestamp = start_ticks
    driver._emit_can(msg, fd, 0)
    msg.timestamp = (start_ticks + 200) % (1 << 32)
    driver._emit_can(msg, fd, 0)

    first, second = trace.snapshot("scroll")
    assert first["timestamp_ns"] == wall_ns
    assert second["timestamp_ns"] == wall_ns + 20_000_000
    assert second["device_timestamp_us"] == msg.timestamp * 100
    assert second["period_ms"] == 20
    assert second["frequency_hz"] == 50
    assert trace.snapshot("latest") == [second]
