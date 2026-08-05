from __future__ import annotations
import threading, time, random
from typing import Dict, Any, List
from app.drivers.base import CanDriver, DriverError
from app.models import *

class MockDriver(CanDriver):
    def __init__(self, on_frame):
        super().__init__(on_frame)
        self.config = None
        self.opened = False
        self.stop_evt = threading.Event()
        self.thread = None
        self.filters = {0: [], 1: []}
        self.hw_periodic = {}
        self.props = {}

    def open(self, config: DeviceConfig):
        self.config = config
        self.opened = True
        self.stop_evt.clear()
        self.thread = threading.Thread(target=self._loop, daemon=True, name="mock-can")
        self.thread.start()
        return self.status()

    def close(self):
        self.stop_evt.set(); self.opened = False
        if self.thread and self.thread.is_alive(): self.thread.join(timeout=1)

    def _loop(self):
        seq = 0
        next_hw = {}
        while not self.stop_evt.wait(0.01):
            now = time.monotonic()
            for key, msg in list(self.hw_periodic.items()):
                due = next_hw.get(key, now)
                if msg.enabled and msg.period_ms and now >= due:
                    self.transmit(msg)
                    next_hw[key] = now + msg.period_ms/1000.0
            if seq % 50 == 0:
                data = [(seq//50)&0xFF, random.randrange(256), random.randrange(256)]
                self.on_frame(dict(timestamp_ns=time.time_ns(), direction="rx", channel=(seq//50)%2,
                    frame_kind="canfd" if (seq//50)%3==0 else "can", can_id=0x180+(seq//50)%8,
                    extended=False, remote=False, brs=(seq//50)%3==0, esi=False, data=data, source="mock"))
            seq += 1

    def _need_open(self):
        if not self.opened: raise DriverError("Mock 设备未打开")

    def status(self):
        return {"opened": self.opened, "online": self.opened, "driver":"mock", "device_type":33,
                "device_info":{"hardware":"USBCANFD-200U Mock","serial":"MOCK200U0001","can_channels":2,"lin_channels":2},
                "capabilities":{"can":True,"canfd":True,"lin":True,"hardware_filters":64,"hardware_periodic":8,
                                "tx_queue":True,"internal_resistance":True,"raw_property":True}}

    def transmit(self, frame: CanFrame):
        self._need_open()
        self.on_frame(dict(timestamp_ns=time.time_ns(), direction="tx", source="mock", **frame.dict()))
        if frame.tx_mode in ("self","self_once"):
            obj=dict(timestamp_ns=time.time_ns(), direction="rx", source="mock_echo", **frame.dict()); self.on_frame(obj)
        return 1

    def clear_buffer(self, channel): self._need_open()
    def reset_channel(self, channel): self._need_open()
    def diagnostics(self, channel):
        self._need_open(); return {"channel":channel,"bus_off":False,"error_code":0,"rx_errors":0,"tx_errors":0,"rx_pending":0,"raw":{}}
    def configure_filters(self, channel, filters):
        self.filters[channel]=filters; return {"channel":channel,"count":len(filters),"active":True}
    def configure_hardware_periodic(self, msg):
        if msg.hardware_index is None: raise DriverError("hardware_index 必填")
        self.hw_periodic[(msg.channel,msg.hardware_index)] = msg
        return {"channel":msg.channel,"index":msg.hardware_index,"enabled":msg.enabled,"period_ms":msg.period_ms,"mock":True}
    def clear_hardware_periodic(self, channel):
        self.hw_periodic={k:v for k,v in self.hw_periodic.items() if k[0]!=channel}; return {"channel":channel,"cleared":True}
    def queue_transmit(self, items):
        def worker():
            start=time.monotonic()
            for it in sorted(items,key=lambda x:x.delay_ms):
                wait=start+it.delay_ms/1000-time.monotonic()
                if wait>0: time.sleep(wait)
                self.transmit(it)
        threading.Thread(target=worker,daemon=True).start(); return {"queued":len(items),"mock":True}
    def clear_tx_queue(self, channel): return {"channel":channel,"cleared":True,"mock":True}
    def set_property(self,path,value): self.props[path]=value; return {"path":path,"value":value,"status":1,"mock":True}
    def get_property(self,path): return {"path":path,"value":self.props.get(path),"mock":True}
    def lin_transmit(self, frame):
        self._need_open(); self.on_frame(dict(timestamp_ns=time.time_ns(),direction="tx",frame_kind="lin",source="mock",channel=frame.channel,can_id=frame.pid,data=frame.data,extended=False,remote=False,brs=False,esi=False)); return 1
    def lin_subscribe(self,cfg): return {"channel":cfg.channel,"subscribed":cfg.pids,"mock":True}
    def lin_publish(self,cfg): return {"channel":cfg.channel,"published":len(cfg.frames),"mock":True}
    def lin_schedule(self,cfg): return {"channel":cfg.channel,"schedule_index":cfg.schedule_index,"items":len(cfg.items),"enabled":cfg.enabled,"mock":True}
