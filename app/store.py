from __future__ import annotations
import os, json, csv, io, threading, time
from collections import deque, OrderedDict, defaultdict
from pathlib import Path
from typing import Dict, Any, List

class TraceStore:
    def __init__(self):
        self.max_frames=int(os.getenv("CAN_FRAME_BUFFER","5000")); self.max_latest=int(os.getenv("CAN_LATEST_BUFFER","4096"))
        self.frames=deque(maxlen=self.max_frames); self.latest=OrderedDict(); self.lock=threading.RLock(); self.seq=0
        self.sec_bins={0:deque(maxlen=120),1:deque(maxlen=120)}; self.current_bins={0:[int(time.time()),0,0],1:[int(time.time()),0,0]}
    def add(self,frame):
        with self.lock:
            self.seq+=1; f=dict(frame); f["seq"]=self.seq; f.setdefault("timestamp_ns",time.time_ns()); f.setdefault("data",[])
            f["data_hex"]=" ".join(f"{x:02X}" for x in f["data"]); self.frames.append(f)
            key=(f.get("frame_kind"),f.get("channel"),f.get("direction"),f.get("can_id"),f.get("extended"),f.get("remote"),f.get("brs"))
            old=self.latest.get(key); now=f["timestamp_ns"]
            if old:
                f["count"]=old.get("count",0)+1; f["period_ms"]=(now-old["timestamp_ns"])/1e6; f["frequency_hz"]=1000/f["period_ms"] if f["period_ms"]>0 else None
            else: f.update(count=1,period_ms=None,frequency_hz=None)
            self.latest[key]=f; self.latest.move_to_end(key)
            while len(self.latest)>self.max_latest: self.latest.popitem(last=False)
            ch=f.get("channel")
            if ch in (0,1): self._metric(ch,f)
            return f
    def _metric(self,ch,f):
        sec=int(time.time()); cur=self.current_bins[ch]
        if cur[0]!=sec:
            self.sec_bins[ch].append(tuple(cur)); self.current_bins[ch]=[sec,0,0]; cur=self.current_bins[ch]
        cur[1]+=1; cur[2]+=estimate_wire_bits(f)
    def snapshot(self,mode="latest",limit=1000):
        with self.lock:
            src=list(self.latest.values()) if mode=="latest" else list(self.frames)
            return src[-limit:]
    def metrics(self,config=None):
        with self.lock:
            out={}
            for ch in (0,1):
                bins=list(self.sec_bins[ch])+[tuple(self.current_bins[ch])]; recent=bins[-1] if bins else (0,0,0); last10=bins[-10:]
                abit=500000; dbit=2000000
                if config and len(config.channels)>ch: abit=config.channels[ch].arbitration_bitrate; dbit=config.channels[ch].data_bitrate
                # Conservative observed load using arbitration bitrate for all bits; FD data-phase split is reported separately in UI.
                out[str(ch)]={"frames_1s":recent[1],"wire_bits_1s":recent[2],"load_1s_pct":round(100*recent[2]/max(abit,1),3),
                              "load_10s_avg_pct":round(100*sum(x[2] for x in last10)/max(len(last10)*abit,1),3),"arbitration_bitrate":abit,"data_bitrate":dbit}
            return out
    def clear(self):
        with self.lock: self.frames.clear(); self.latest.clear()
    def csv_bytes(self):
        with self.lock: rows=list(self.frames)
        s=io.StringIO(); cols=["seq","timestamp_ns","device_timestamp_us","direction","channel","frame_kind","can_id","extended","remote","brs","esi","data_hex","source"]
        w=csv.DictWriter(s,fieldnames=cols,extrasaction="ignore"); w.writeheader(); w.writerows(rows); return s.getvalue().encode("utf-8-sig")

def estimate_wire_bits(f):
    kind=f.get("frame_kind"); n=len(f.get("data",[])); ext=f.get("extended",False)
    if kind=="lin": return 34+10*n
    if kind=="canfd":
        arb=41 if ext else 22; crc=21 if n<=16 else 25; raw=arb+10+8*n+crc+13; return int(raw*1.2)
    raw=(67 if ext else 47)+8*n; return int(raw*1.25)

class JsonState:
    def __init__(self,data_dir):
        self.dir=Path(data_dir); self.dir.mkdir(parents=True,exist_ok=True); self.lock=threading.RLock()
    def load(self,name,default):
        p=self.dir/name
        try: return json.loads(p.read_text("utf-8"))
        except Exception: return default
    def save(self,name,data):
        p=self.dir/name; tmp=p.with_suffix(p.suffix+".tmp")
        with self.lock: tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2),"utf-8"); tmp.replace(p)
