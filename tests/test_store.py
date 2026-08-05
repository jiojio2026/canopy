from app.store import TraceStore
def test_bounded(monkeypatch):
    monkeypatch.setenv("CAN_FRAME_BUFFER","10"); s=TraceStore()
    for i in range(100): s.add({"channel":0,"direction":"rx","frame_kind":"can","can_id":i,"extended":False,"remote":False,"brs":False,"esi":False,"data":[i&255],"timestamp_ns":i+1})
    assert len(s.frames)==10
    assert len(s.snapshot("scroll",100))==10
