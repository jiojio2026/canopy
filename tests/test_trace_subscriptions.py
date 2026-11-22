import asyncio

from fastapi import WebSocketDisconnect

from app import main


class FakeSocket:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def receive_text(self):
        item = await self.messages.get()
        if isinstance(item, Exception):
            raise item
        return item


def test_websocket_only_subscribed_while_trace_is_visible():
    async def exercise():
        main.subscribers.clear()
        socket = FakeSocket()
        task = asyncio.create_task(main.ws_trace(socket))
        await asyncio.sleep(0)
        assert socket.accepted
        assert socket not in main.subscribers

        await socket.messages.put("subscribe")
        await asyncio.sleep(0)
        assert socket in main.subscribers

        await socket.messages.put("unsubscribe")
        await asyncio.sleep(0)
        assert socket not in main.subscribers

        await socket.messages.put("subscribe")
        await asyncio.sleep(0)
        assert socket in main.subscribers

        await socket.messages.put(WebSocketDisconnect())
        await asyncio.wait_for(task, timeout=1)
        assert socket not in main.subscribers

    asyncio.run(exercise())


def test_no_live_enqueue_when_no_browser_is_subscribed(monkeypatch):
    class Loop:
        def __init__(self):
            self.scheduled = []

        def call_soon_threadsafe(self, callback, frame):
            self.scheduled.append((callback, frame))

    class Store:
        def add(self, frame):
            return frame

    loop = Loop()
    monkeypatch.setattr(main, "event_loop", loop)
    monkeypatch.setattr(main, "trace", Store())
    main.subscribers.clear()
    frame = {"can_id": 0x123}
    try:
        main.frame_callback(frame)
        assert loop.scheduled == []
        listener = object()
        main.subscribers.add(listener)
        main.frame_callback(frame)
        assert len(loop.scheduled) == 1
        assert loop.scheduled[0][1] is frame
    finally:
        main.subscribers.clear()
