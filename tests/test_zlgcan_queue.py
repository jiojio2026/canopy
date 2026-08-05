import ctypes as C

import pytest
from pydantic import ValidationError

from app.drivers.base import DriverError
from app.drivers.zlgcan import (
    CMD_GET_SEND_QUEUE_SPACE,
    FLAG_BRS,
    FLAG_CANFD,
    FLAG_QSEND,
    FLAG_QSEND_100US,
    STATUS_OK,
    VCI_CANFD_MSG,
    VCI_CAN_MSG,
    ZlgCanDriver,
)
from app.models import HardwareQueueFrame


class FakeLib:
    def __init__(self):
        self.classic = []
        self.fd = []
        self.references = []

    def VCI_SetReference(self, dev_type, dev_index, channel, command, ptr):
        self.references.append((int(dev_type), int(dev_index), int(channel), int(command)))
        return STATUS_OK

    def VCI_GetReference(self, dev_type, dev_index, channel, command, ptr):
        value = C.cast(ptr, C.POINTER(C.c_uint32))
        value.contents.value = 1000 if int(command) == CMD_GET_SEND_QUEUE_SPACE else 1024
        return STATUS_OK

    def VCI_Transmit(self, dev_type, dev_index, channel, ptr, count):
        obj = C.cast(ptr, C.POINTER(VCI_CAN_MSG)).contents
        self.classic.append({
            "count": int(count), "delay": int(obj.delay), "flags": int(obj.flags),
            "id": int(obj.can_id), "channel": int(obj.channel),
        })
        return 1

    def VCI_TransmitFD(self, dev_type, dev_index, channel, ptr, count):
        obj = C.cast(ptr, C.POINTER(VCI_CANFD_MSG)).contents
        self.fd.append({
            "count": int(count), "delay": int(obj.delay), "flags": int(obj.flags),
            "id": int(obj.can_id), "channel": int(obj.channel),
        })
        return 1


def make_driver():
    seen = []
    drv = ZlgCanDriver(seen.append)
    drv.lib = FakeLib()
    drv.channels = {0: True}
    drv.opened = True
    return drv, seen


def test_classic_queue_delay_encoding():
    drv, seen = make_driver()
    result = drv.queue_transmit([
        HardwareQueueFrame(channel=0, frame_kind="can", can_id=0x123, data=[1, 2], delay_ms=25)
    ])
    encoded = drv.lib.classic[0]
    assert result["accepted"] == 1
    assert encoded["delay"] == 25
    assert encoded["flags"] & FLAG_QSEND
    assert not encoded["flags"] & FLAG_QSEND_100US
    assert seen[0]["source"] == "host_queue"


def test_canfd_queue_100us_encoding_and_brs():
    drv, _ = make_driver()
    drv.queue_transmit([
        HardwareQueueFrame(
            channel=0, frame_kind="canfd", can_id=0x456, data=[1] * 12,
            brs=True, delay_ms=1.2, precision_100us=True,
        )
    ])
    encoded = drv.lib.fd[0]
    assert encoded["delay"] == 12
    assert encoded["flags"] & FLAG_CANFD
    assert encoded["flags"] & FLAG_BRS
    assert encoded["flags"] & FLAG_QSEND
    assert encoded["flags"] & FLAG_QSEND_100US


def test_queue_delay_rejects_16bit_overflow():
    drv, _ = make_driver()
    with pytest.raises((DriverError, ValidationError)):
        drv.queue_transmit([
            HardwareQueueFrame(channel=0, frame_kind="can", can_id=1, delay_ms=70000)
        ])
