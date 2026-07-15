from __future__ import annotations

import asyncio

import pytest

from server.nodejs_runtime_manager import NodeRuntimeSupervisor


class FakeWorker:
    next_pid = 100

    def __init__(self, project_root):
        self.project_root = project_root
        self.is_ready = False
        self.startup_error = None
        self.values = {}
        self.lock = asyncio.Lock()
        self.stopped = False
        self.pid = FakeWorker.next_pid
        FakeWorker.next_pid += 1
        self._proc = type("Proc", (), {"pid": self.pid, "returncode": None})()

    async def start(self):
        self.is_ready = True
        return True

    async def execute(self, code, timeout=30000, **kwargs):
        async with self.lock:
            if code.startswith("set:"):
                self.values["value"] = code.split(":", 1)[1]
                return {"ok": True, "result": self.values["value"]}
            if code == "get":
                return {"ok": True, "result": self.values.get("value")}
            if code == "timeout":
                return {"ok": False, "error": "Timeout after 1ms"}
            await asyncio.sleep(0.02)
            return {"ok": True, "result": code}

    async def stop(self):
        self.stopped = True
        self.is_ready = False


@pytest.mark.asyncio
async def test_different_sessions_get_independent_workers_and_globals():
    supervisor = NodeRuntimeSupervisor("/tmp", worker_factory=FakeWorker)
    a = {"sessionId": "a", "session": "same-alias"}
    b = {"sessionId": "b", "session": "same-alias"}
    await supervisor.execute(a, "set:A")
    await supervisor.execute(b, "set:B")
    assert (await supervisor.execute(a, "get"))["result"] == "A"
    assert (await supervisor.execute(b, "get"))["result"] == "B"
    snapshot = supervisor.snapshot()
    assert snapshot["workers"]["a"]["pid"] != snapshot["workers"]["b"]["pid"]


@pytest.mark.asyncio
async def test_different_sessions_parallel_and_same_session_serial():
    supervisor = NodeRuntimeSupervisor("/tmp", worker_factory=FakeWorker)
    a = {"sessionId": "a", "session": "a"}
    b = {"sessionId": "b", "session": "b"}
    start = asyncio.get_running_loop().time()
    await asyncio.gather(supervisor.execute(a, "one"), supervisor.execute(b, "two"))
    parallel_elapsed = asyncio.get_running_loop().time() - start
    start = asyncio.get_running_loop().time()
    await asyncio.gather(supervisor.execute(a, "three"), supervisor.execute(a, "four"))
    serial_elapsed = asyncio.get_running_loop().time() - start
    assert parallel_elapsed < 0.035
    assert serial_elapsed >= 0.035


@pytest.mark.asyncio
async def test_timeout_and_close_remove_only_one_worker():
    supervisor = NodeRuntimeSupervisor("/tmp", worker_factory=FakeWorker)
    a = {"sessionId": "a", "session": "a"}
    b = {"sessionId": "b", "session": "b"}
    await supervisor.execute(a, "set:A")
    await supervisor.execute(b, "set:B")
    result = await supervisor.execute(a, "timeout", timeout=1)
    assert result["ok"] is False
    assert "a" not in supervisor.snapshot()["workers"]
    assert "b" in supervisor.snapshot()["workers"]
    await supervisor.close_session("b")
    assert supervisor.snapshot()["workers"] == {}

