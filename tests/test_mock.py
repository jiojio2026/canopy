import time
from app.drivers.mock import MockDriver
from app.models import DeviceConfig,CanFrame

def test_mock_tx():
    out=[]; d=MockDriver(out.append); d.open(DeviceConfig(driver="mock")); assert d.transmit(CanFrame(can_id=0x123,data=[1,2]))==1; d.close(); assert any(x["direction"]=="tx" for x in out)
