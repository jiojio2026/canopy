import pytest
from pydantic import ValidationError
from app.models import CanFrame,DeviceConfig

def test_can_lengths():
    CanFrame(can_id=1,data=list(range(8)))
    with pytest.raises(ValidationError): CanFrame(can_id=1,data=list(range(9)))
    CanFrame(frame_kind="canfd",can_id=1,data=list(range(64)))
    with pytest.raises(ValidationError): CanFrame(frame_kind="canfd",can_id=1,data=list(range(65)))
def test_standard_id_width():
    with pytest.raises(ValidationError): CanFrame(can_id=0x800)
    CanFrame(can_id=0x1fffffff,extended=True)
def test_two_channels(): assert len(DeviceConfig().channels)==2


def test_filter_id_width_and_canfd_dlc():
    from pydantic import ValidationError
    from app.models import FilterItem, CanFrame, HardwareQueueFrame
    try:
        FilterItem(extended=False, start_id=0x800, end_id=0x800)
        assert False, "standard filter ID must be rejected"
    except ValidationError:
        pass
    assert FilterItem(extended=True, start_id=0x800, end_id=0x1FFFFFFF).extended
    try:
        CanFrame(channel=0, frame_kind="canfd", can_id=0x123, data=list(range(9)))
        assert False, "9-byte CAN FD payload must be rejected"
    except ValidationError:
        pass
    assert len(CanFrame(channel=0, frame_kind="canfd", can_id=0x123, data=list(range(12))).data) == 12
    try:
        HardwareQueueFrame(channel=0, frame_kind="can", can_id=0x123, data=[], delay_ms=7000, precision_100us=True)
        assert False, "fine delay exceeding 16-bit encoding must be rejected"
    except ValidationError:
        pass
