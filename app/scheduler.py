from __future__ import annotations
import threading,time,logging
from typing import Dict
from app.models import SavedMessage, CanFrame
log=logging.getLogger(__name__)
class SoftwareScheduler:
    def __init__(self,send_func):
        self.send_func=send_func; self.items:Dict[str,SavedMessage]={}; self.next_due={}; self.lock=threading.RLock(); self.stop_evt=threading.Event(); self.thread=threading.Thread(target=self._loop,daemon=True,name="can-soft-scheduler"); self.thread.start()
    def sync(self,messages):
        with self.lock:
            self.items={m.key:m for m in messages if m.scheduler=="software"}; now=time.monotonic()
            for k in self.items: self.next_due.setdefault(k,now)
            self.next_due={k:v for k,v in self.next_due.items() if k in self.items}
    def _loop(self):
        while not self.stop_evt.wait(.001):
            now=time.monotonic(); due=[]
            with self.lock:
                for k,m in self.items.items():
                    if m.enabled and m.period_ms and now>=self.next_due.get(k,now):
                        due.append(m); self.next_due[k]=now+m.period_ms/1000
            for m in due:
                try: self.send_func(CanFrame(**m.dict()))
                except Exception: log.exception("周期发送失败: %s",m.key)
    def stop(self): self.stop_evt.set(); self.thread.join(timeout=1)
