from __future__ import annotations
import os, asyncio, logging, time, uuid
from pathlib import Path
from typing import List
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from app.models import *
from app.store import TraceStore, JsonState
from app.scheduler import SoftwareScheduler
from app.drivers.base import DriverError
from app.drivers.mock import MockDriver
from app.drivers.zlgcan import ZlgCanDriver, probe_runtime_environment

logging.basicConfig(level=os.getenv("LOG_LEVEL","INFO")); log=logging.getLogger(__name__)
ROOT=Path(__file__).resolve().parent; DATA=os.getenv("CAN_WEB_DATA",str(ROOT.parent/"data"))
state=JsonState(DATA); trace=TraceStore(); subscribers=set(); event_loop=None; live_queue=None; broadcaster_task=None; live_dropped=0

def default_config():
    return DeviceConfig(driver="mock" if os.getenv("MOCK_CAN")=="1" else "zlgcan")
try: config=DeviceConfig.parse_obj(state.load("config.json",default_config().dict()))
except Exception: config=default_config()
try: messages=[SavedMessage.parse_obj(x) for x in state.load("messages.json",[])]
except Exception: messages=[]

def frame_callback(frame):
    f=trace.add(frame)
    if event_loop:
        try: event_loop.call_soon_threadsafe(enqueue_live, f)
        except Exception: pass

def enqueue_live(frame):
    global live_dropped
    if live_queue is None: return
    if live_queue.full():
        try: live_queue.get_nowait(); live_dropped += 1
        except asyncio.QueueEmpty: pass
    try: live_queue.put_nowait(frame)
    except asyncio.QueueFull: live_dropped += 1

driver=MockDriver(frame_callback) if config.driver=="mock" or os.getenv("MOCK_CAN")=="1" else ZlgCanDriver(frame_callback)
scheduler=SoftwareScheduler(lambda frame: send_frame(frame) if driver.status().get("opened",False) else 0)
scheduler.sync(messages)
app=FastAPI(title="CANopy",version="0.1.0")
app.mount("/static",StaticFiles(directory=str(ROOT/"static")),name="static")

@app.middleware("http")
async def disable_ui_cache(request, call_next):
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response

@app.on_event("startup")
async def startup():
    global event_loop, live_queue, broadcaster_task
    event_loop=asyncio.get_running_loop()
    live_queue=asyncio.Queue(maxsize=int(os.getenv("CAN_LIVE_QUEUE","5000")))
    broadcaster_task=asyncio.create_task(broadcast_loop(),name="trace-broadcaster")
@app.on_event("shutdown")
async def shutdown():
    driver.close(); scheduler.stop()
    if broadcaster_task:
        broadcaster_task.cancel()
        try: await broadcaster_task
        except asyncio.CancelledError: pass
@app.get("/")
def index(): return FileResponse(ROOT/"static/index.html")
@app.get("/api/version")
def version(): return ok({"version":"0.1.0","sdk":"usbcanfd_libusb_x64_1.0.14_260701"})

def ok(data=None,message=""): return APIResult(ok=True,data=data,message=message).dict()
def fail(e):
    if isinstance(e,HTTPException): raise e
    raise HTTPException(status_code=400,detail=str(e))
def send_frame(frame):
    ret=driver.transmit(frame)
    if ret!=1:
        diag=None
        try: diag=driver.diagnostics(frame.channel)
        except Exception: pass
        suffix=f"；通道诊断={diag}" if diag else ""
        raise DriverError(f"发送失败，驱动返回 {ret}{suffix}")
    return ret

@app.get("/api/config")
def get_config(): return ok(config.dict())
@app.put("/api/config")
def put_config(new:DeviceConfig):
    global config,driver
    try:
        driver.close(); config=new; state.save("config.json",config.dict()); driver=MockDriver(frame_callback) if new.driver=="mock" or os.getenv("MOCK_CAN")=="1" else ZlgCanDriver(frame_callback)
        return ok(config.dict(),"配置已保存；点击打开设备生效")
    except Exception as e: fail(e)
@app.get("/api/device/preflight")
def device_preflight():
    try:
        result = driver.preflight() if hasattr(driver, "preflight") else probe_runtime_environment()
        return ok(result)
    except Exception as e:
        fail(e)

@app.post("/api/device/open")
async def open_device():
    timeout_s=float(os.getenv("CAN_OPEN_TIMEOUT_S","15"))
    try:
        result=await asyncio.wait_for(asyncio.to_thread(driver.open,config),timeout=timeout_s)
        periodic=[]
        for msg in messages:
            if msg.scheduler!="hardware": continue
            try: periodic.append({"key":msg.key,"ok":True,"result":driver.configure_hardware_periodic(msg)})
            except Exception as exc: periodic.append({"key":msg.key,"ok":False,"error":str(exc)})
        result["hardware_periodic_sync"]=periodic
        return ok(result,"设备已打开")
    except asyncio.TimeoutError:
        message=f"打开设备超过 {timeout_s:g} 秒。页面可继续使用；请查看 USB 权限和 usbcanfd.log。"
        if hasattr(driver, "_operation"):
            driver._operation("failed", "打开设备超时", error=message)
        raise HTTPException(504, message)
    except Exception as e:
        fail(e)
@app.post("/api/device/close")
def close_device():
    driver.close()
    if hasattr(driver, "_operation"):
        driver._operation("idle", "设备已关闭")
    return ok(message="设备已关闭")
@app.get("/api/device/status")
def device_status():
    try: return ok(driver.status())
    except Exception as e: return APIResult(ok=False,message=str(e),data={"opened":False}).dict()
@app.get("/api/device/diagnostics/{channel}")
def diagnostics(channel:int):
    try: return ok(driver.diagnostics(channel))
    except Exception as e: fail(e)
@app.post("/api/device/reset/{channel}")
def reset_channel(channel:int):
    try: driver.reset_channel(channel); return ok(message=f"CAN{channel} 已复位并重启")
    except Exception as e: fail(e)
@app.post("/api/device/clear/{channel}")
def clear_channel(channel:int):
    try: driver.clear_buffer(channel); return ok(message=f"CAN{channel} 硬件接收缓冲已清空")
    except Exception as e: fail(e)

@app.post("/api/transmit")
def transmit(frame:CanFrame):
    try: return ok({"sent":send_frame(frame)})
    except Exception as e: fail(e)
@app.post("/api/tx-queue")
def tx_queue(items:List[HardwareQueueFrame]):
    try: return ok(driver.queue_transmit(items))
    except Exception as e: fail(e)
@app.delete("/api/tx-queue/{channel}")
def clear_tx_queue(channel:int):
    try: return ok(driver.clear_tx_queue(channel))
    except Exception as e: fail(e)

@app.get("/api/messages")
def get_messages(): return ok([m.dict() for m in messages])
def disable_hardware_message(msg:SavedMessage):
    if msg.scheduler!="hardware" or msg.hardware_index is None: return None
    return driver.configure_hardware_periodic(msg.copy(update={"enabled":False}))

@app.post("/api/messages")
def add_message(msg:SavedMessage):
    global messages
    if not msg.key: msg.key=str(uuid.uuid4())
    old=next((m for m in messages if m.key==msg.key),None)
    cleanup_error=None
    if old and old.scheduler=="hardware" and (msg.scheduler!="hardware" or old.channel!=msg.channel or old.hardware_index!=msg.hardware_index):
        try: disable_hardware_message(old)
        except Exception as exc: cleanup_error=str(exc)
    messages=[m for m in messages if m.key!=msg.key]+[msg]
    state.save("messages.json",[m.dict() for m in messages]); scheduler.sync(messages)
    payload=msg.dict()
    if msg.scheduler=="hardware":
        try: driver.configure_hardware_periodic(msg)
        except Exception as e:
            detail=f"报文已保存，但硬件定时配置失败: {e}"
            if cleanup_error: detail+=f"；旧槽位停用也失败: {cleanup_error}"
            payload["_hardware_warning"]=detail
            return ok(payload,detail)
    message="报文已保存"
    if cleanup_error:
        message+=f"；旧硬件槽位停用失败: {cleanup_error}"
        payload["_hardware_warning"]=message
    return ok(payload,message)
@app.delete("/api/messages/{key}")
def delete_message(key:str):
    global messages
    old=next((m for m in messages if m.key==key),None)
    if not old: raise HTTPException(404,"报文不存在")
    warning=None
    try: disable_hardware_message(old)
    except Exception as exc: warning=str(exc)
    messages=[m for m in messages if m.key!=key]
    state.save("messages.json",[m.dict() for m in messages]); scheduler.sync(messages)
    return ok({"deleted":key,"warning":warning},"报文已删除"+(f"；硬件槽位停用失败: {warning}" if warning else ""))
@app.post("/api/messages/{key}/send")
def send_saved(key:str):
    m=next((x for x in messages if x.key==key),None)
    if not m: raise HTTPException(404,"报文不存在")
    try: return ok({"sent":send_frame(CanFrame(**m.dict()))})
    except Exception as e: fail(e)
@app.post("/api/hardware-periodic/clear/{channel}")
def clear_hw_periodic(channel:int):
    try: return ok(driver.clear_hardware_periodic(channel))
    except Exception as e: fail(e)
@app.post("/api/nodes/{node}/enable/{enabled}")
def node_enable(node:str,enabled:bool):
    global messages
    messages=[m.copy(update={"enabled":enabled}) if m.node==node else m for m in messages]; state.save("messages.json",[m.dict() for m in messages]); scheduler.sync(messages)
    for m in messages:
        if m.node==node and m.scheduler=="hardware":
            try: driver.configure_hardware_periodic(m)
            except Exception: pass
    return ok()

@app.put("/api/filters")
def filters(cfg:FilterConfig):
    try: return ok(driver.configure_filters(cfg.channel,cfg.filters))
    except Exception as e: fail(e)
@app.post("/api/property/set")
def set_property(p:RawProperty):
    if p.value is None: raise HTTPException(400,"value 必填")
    try: return ok(driver.set_property(p.path,p.value))
    except Exception as e: fail(e)
@app.post("/api/property/get")
def get_property(p:RawProperty):
    try: return ok(driver.get_property(p.path))
    except Exception as e: fail(e)

@app.post("/api/lin/transmit")
def lin_tx(frame:LinFrame):
    try: return ok({"sent":driver.lin_transmit(frame)})
    except Exception as e: fail(e)
@app.put("/api/lin/subscribe")
def lin_sub(cfg:LinSubscribe):
    try: return ok(driver.lin_subscribe(cfg))
    except Exception as e: fail(e)
@app.put("/api/lin/publish")
def lin_pub(cfg:LinPublish):
    try: return ok(driver.lin_publish(cfg))
    except Exception as e: fail(e)
@app.put("/api/lin/schedule")
def lin_sched(cfg:LinSchedule):
    try: return ok(driver.lin_schedule(cfg))
    except Exception as e: fail(e)

@app.get("/api/trace")
def get_trace(mode:str="latest",limit:int=Query(1000,ge=1,le=5000)): return ok(trace.snapshot(mode,limit))
@app.delete("/api/trace")
def clear_trace(): trace.clear(); return ok()
@app.get("/api/trace.csv")
def trace_csv(): return Response(trace.csv_bytes(),media_type="text/csv",headers={"Content-Disposition":"attachment; filename=can_trace.csv"})
@app.get("/api/metrics")
def metrics(): return ok(trace.metrics(config))

async def broadcast_loop():
    while True:
        first=await live_queue.get()
        batch=[first]
        await asyncio.sleep(.02)
        while len(batch)<256:
            try: batch.append(live_queue.get_nowait())
            except asyncio.QueueEmpty: break
        if not subscribers: continue
        payload={"type":"frames","frames":batch,"dropped":live_dropped}
        dead=[]
        for ws in list(subscribers):
            try: await asyncio.wait_for(ws.send_json(payload),timeout=.2)
            except Exception: dead.append(ws)
        for ws in dead: subscribers.discard(ws)
@app.websocket("/ws/trace")
async def ws_trace(ws:WebSocket):
    await ws.accept(); subscribers.add(ws)
    try:
        while True: await ws.receive_text()
    except WebSocketDisconnect: pass
    finally: subscribers.discard(ws)
