# -*- coding: utf-8 -*-
"""
Python 端 NodeJSRuntimeManager 集成测试

覆盖 NodeJSRuntimeManager 生命周期、IPC 通信、降级路径和异常恢复。

运行方式:
    # 仅运行 mock 测试（不需要 Node.js 环境）
    python -m pytest test/test_playwright_nodejs_runtime.py -v -m "not integration"

    # 运行全部测试（需要 Node.js >=18）
    python -m pytest test/test_playwright_nodejs_runtime.py -v
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import sys
import types
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# 确保项目根目录在 Python 路径中
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from server.playwright_runtime import PlaywrightRuntime

# 尝试导入 NodeJSRuntimeManager；若不存在则整组测试跳过
try:
    from server.nodejs_runtime_manager import NodeJSRuntimeManager
except ImportError as _import_exc:  # pragma: no cover
    NodeJSRuntimeManager = None  # type: ignore

# --------------------------------------------------------------------------- #
# 夹具
# --------------------------------------------------------------------------- #


@pytest.fixture
def project_root() -> str:
    return _project_root


@pytest.fixture
def runtime_entry_path(project_root: str) -> str:
    return os.path.join(project_root, "runtime", "nodejs-playwright-runtime.mjs")


# --------------------------------------------------------------------------- #
# 1. NodeJSRuntimeManager 启动
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_start_success_when_node_and_entry_exist(
    project_root: str, runtime_entry_path: str
):
    """Node.js 和入口文件均存在时，start() 应返回 True 且 is_ready 为 True。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")
    if not os.path.isfile(runtime_entry_path):
        pytest.skip("runtime/nodejs-playwright-runtime.mjs 不存在")

    mgr = NodeJSRuntimeManager(project_root=project_root)
    with patch("shutil.which", return_value="/usr/bin/node"):
        # 不真正启动子进程，模拟子进程 ready 流程
        mock_proc = MagicMock()
        mock_proc.pid = 12345
        mock_proc.returncode = None
        mock_proc.stdin = MagicMock()
        mock_proc.stdin.is_closing.return_value = False
        mock_proc.stdout = MagicMock()
        mock_proc.stderr = MagicMock()

        # 构造一个返回 ready 消息的 stdout readline mock
        ready_line = json.dumps({"type": "ready"}).encode("utf-8") + b"\n"
        # 先返回 ready，再阻塞（模拟持续运行）
        mock_proc.stdout.readline = AsyncMock(side_effect=[ready_line, asyncio.sleep(3600)])
        mock_proc.stderr.readline = AsyncMock(side_effect=[b"", asyncio.sleep(3600)])
        mock_proc.wait = AsyncMock(return_value=0)

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=mock_proc):
            result = await mgr.start()

    assert result is True
    assert mgr.is_ready is True
    assert mgr.startup_error is None
    await mgr.stop()


@pytest.mark.asyncio
async def test_start_fails_when_node_not_found(project_root: str):
    """shutil.which('node') 返回 None 时，start() 返回 False 并设置 startup_error。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")

    mgr = NodeJSRuntimeManager(project_root=project_root)
    with patch("shutil.which", return_value=None):
        result = await mgr.start()

    assert result is False
    assert mgr.is_ready is False
    assert mgr.startup_error is not None
    assert "Node.js" in mgr.startup_error or "node" in mgr.startup_error.lower()


@pytest.mark.asyncio
async def test_start_fails_when_entry_file_missing(project_root: str):
    """入口文件缺失时，start() 返回 False 并设置 startup_error。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")

    mgr = NodeJSRuntimeManager(project_root=project_root)
    with patch("shutil.which", return_value="/usr/bin/node"):
        with patch("os.path.isfile", return_value=False):
            result = await mgr.start()

    assert result is False
    assert mgr.is_ready is False
    assert mgr.startup_error is not None
    assert "入口文件" in mgr.startup_error or "runtime" in mgr.startup_error.lower()


# --------------------------------------------------------------------------- #
# 2. execute() 正确路由与响应解析
# --------------------------------------------------------------------------- #


def _make_manager_with_mock_proc(project_root: str) -> tuple:
    """构造一个已注入 mock 子进程的 NodeJSRuntimeManager，并返回 mgr + mock_proc。"""
    mgr = NodeJSRuntimeManager(project_root=project_root)
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_proc.returncode = None
    mock_proc.stdin = MagicMock()
    mock_proc.stdin.is_closing.return_value = False
    mock_proc.stdout = MagicMock()
    mock_proc.stderr = MagicMock()
    mock_proc.wait = AsyncMock(return_value=0)

    mgr._proc = mock_proc
    mgr._ready = True
    return mgr, mock_proc


@pytest.mark.asyncio
async def test_execute_returns_ok_result(project_root: str):
    """向子进程发送代码，收到正确响应后返回 {ok: True, result: ...}。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")

    mgr, mock_proc = _make_manager_with_mock_proc(project_root)

    async def _fake_readline():
        # 第一次 readline 返回 execute 响应；随后保持运行
        response = json.dumps({"id": list(mgr._pending.keys())[0], "ok": True, "result": 2}).encode("utf-8")
        mock_proc.stdout.readline = AsyncMock(side_effect=[response + b"\n", asyncio.sleep(3600)])
        return response + b"\n"

    # 用任务在后台触发响应
    async def _delayed_response():
        await asyncio.sleep(0.05)
        req_id = list(mgr._pending.keys())[0]
        future = mgr._pending.get(req_id)
        if future and not future.done():
            future.set_result({"ok": True, "result": 2})

    with patch.object(mgr._proc.stdin, "write"):
        with patch.object(mgr._proc.stdin, "drain", new_callable=AsyncMock):
            task = asyncio.create_task(_delayed_response())
            result = await mgr.execute("return 1+1", timeout=5000)
            await task

    assert result == {"ok": True, "result": 2}
    await mgr.stop()


@pytest.mark.asyncio
async def test_execute_returns_error_with_stack(project_root: str):
    """子进程返回错误时，execute() 应包含 error 和 stack。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")

    mgr, _ = _make_manager_with_mock_proc(project_root)

    async def _delayed_error():
        await asyncio.sleep(0.05)
        req_id = list(mgr._pending.keys())[0]
        future = mgr._pending.get(req_id)
        if future and not future.done():
            future.set_result({"ok": False, "error": "test", "stack": "Error: test\n    at <anonymous>"})

    with patch.object(mgr._proc.stdin, "write"):
        with patch.object(mgr._proc.stdin, "drain", new_callable=AsyncMock):
            task = asyncio.create_task(_delayed_error())
            result = await mgr.execute("throw new Error('test')", timeout=5000)
            await task

    assert result["ok"] is False
    assert "test" in result["error"]
    assert result.get("stack") is not None
    await mgr.stop()


def test_execute_restarts_once_when_stdout_closed(project_root: str):
    """stdout 关闭导致等待响应异常时，execute 应重启 runtime 并重试一次。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")

    async def _run():
        mgr, mock_proc = _make_manager_with_mock_proc(project_root)
        writes = []
        restarts = []

        async def _restart():
            restarts.append("restart")
            mgr._ready = True
            mgr._proc = mock_proc
            return True

        mgr.restart = _restart  # type: ignore[method-assign]

        def _write(_data):
            writes.append(_data)
            req_id = list(mgr._pending.keys())[-1]
            future = mgr._pending[req_id]
            if len(writes) == 1:
                future.set_exception(RuntimeError("Node.js 子进程 stdout 已关闭"))
            else:
                future.set_result({"ok": True, "result": {"retried": True}})

        with patch.object(mgr._proc.stdin, "write", side_effect=_write):
            with patch.object(mgr._proc.stdin, "drain", new_callable=AsyncMock):
                result = await mgr.execute("return 'ok'", timeout=5000)

        assert result == {"ok": True, "result": {"retried": True}}
        assert restarts == ["restart"]
        assert len(writes) == 2
        await mgr.stop()

    asyncio.run(_run())


# --------------------------------------------------------------------------- #
# 3. 超时处理
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_execute_timeout_returns_timeout_error(project_root: str):
    """execute 超时时返回包含 'timeout' 字样的错误。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")

    mgr, _ = _make_manager_with_mock_proc(project_root)

    # 不触发任何响应，让请求自然超时
    with patch.object(mgr._proc.stdin, "write"):
        with patch.object(mgr._proc.stdin, "drain", new_callable=AsyncMock):
            result = await mgr.execute("while(true){}", timeout=100)

    assert result["ok"] is False
    assert "timeout" in result["error"].lower() or "超时" in result["error"]
    await mgr.stop()


# --------------------------------------------------------------------------- #
# 4. 降级路径测试（tool_browser_code_run）
# --------------------------------------------------------------------------- #


# 为 main.py 构造最小 mock mcp 模块，避免真实依赖
if "mcp" not in sys.modules:
    _mcp_mod = types.ModuleType("mcp")
    _mcp_server = types.ModuleType("mcp.server")
    _mcp_stdio = types.ModuleType("mcp.server.stdio")
    _mcp_types = types.ModuleType("mcp.types")

    class _FakeServer:
        def __init__(self, name: str):
            self.name = name

        def list_tools(self):
            return lambda fn: fn

        def call_tool(self):
            return lambda fn: fn

    class _FakeContent:
        def __init__(self, **kwargs: Any):
            self.__dict__.update(kwargs)

    _mcp_server.Server = _FakeServer
    _mcp_stdio.stdio_server = object
    _mcp_types.TextContent = _FakeContent
    _mcp_types.ImageContent = _FakeContent
    _mcp_types.Tool = _FakeContent
    sys.modules["mcp"] = _mcp_mod
    sys.modules["mcp.server"] = _mcp_server
    sys.modules["mcp.server.stdio"] = _mcp_stdio
    sys.modules["mcp.types"] = _mcp_types


from server import main as main_module


def _ensure_module_attr(module, name, default):
    """若模块上不存在指定属性，先动态注入默认值，方便 monkeypatch。"""
    if not hasattr(module, name):
        setattr(module, name, default)


def _has_nodejs_fallback_logic() -> bool:
    """检查当前 main.py 是否已包含 Node.js Runtime 降级逻辑（Task 3）。"""
    return hasattr(main_module, "nodejs_runtime") and "nodejs_runtime" in main_module.tool_browser_code_run.__code__.co_names


@pytest.mark.asyncio
async def test_tool_browser_code_run_rejects_fallback_when_nodejs_runtime_fails(monkeypatch, caplog):
    """Node.js Runtime 启动失败时，tool_browser_code_run 返回明确错误，不降级。"""
    if not _has_nodejs_fallback_logic():
        pytest.skip("当前 main.py 尚未包含 Node.js Runtime 降级逻辑（Task 3 未合并）")

    caplog.set_level(logging.WARNING)

    fake_ws = MagicMock()
    fake_ws.send_command = AsyncMock(return_value={"ok": True, "result": {"fallback": True}})
    monkeypatch.setattr(main_module, "ws_manager", fake_ws)

    # mock Node.js Runtime 启动失败
    fake_nodejs_runtime = MagicMock()
    fake_nodejs_runtime.is_ready = False
    fake_nodejs_runtime.start = AsyncMock(return_value=False)
    fake_nodejs_runtime.startup_error = "Node.js 未安装"
    _ensure_module_attr(main_module, "nodejs_runtime", None)
    monkeypatch.setattr(main_module, "nodejs_runtime", fake_nodejs_runtime)

    result = await main_module.tool_browser_code_run({"code": "return 1+1"})
    payload = json.loads(result[0].text)

    assert payload["ok"] is False
    assert "Node.js 未安装" in payload["error"]
    assert "Playwright 高级功能需要 Node.js Runtime" in payload["error"]
    assert fake_ws.send_command.await_count == 0
    assert any("拒绝降级" in rec.message for rec in caplog.records)


@pytest.mark.asyncio
async def test_tool_browser_code_run_rejects_when_nodejs_runtime_is_none(monkeypatch):
    """nodejs_runtime 为 None 时返回明确错误，不走旧 Runtime 降级路径。"""
    if not _has_nodejs_fallback_logic():
        pytest.skip("当前 main.py 尚未包含 Node.js Runtime 降级逻辑（Task 3 未合并）")

    fake_ws = MagicMock()
    fake_ws.send_command = AsyncMock(return_value={"ok": True, "result": {"direct_fallback": True}})
    monkeypatch.setattr(main_module, "ws_manager", fake_ws)
    _ensure_module_attr(main_module, "nodejs_runtime", None)
    monkeypatch.setattr(main_module, "nodejs_runtime", None)

    result = await main_module.tool_browser_code_run({"code": "return 1+1"})
    payload = json.loads(result[0].text)

    assert payload["ok"] is False
    assert "Node.js Playwright Runtime 未配置" in payload["error"]
    assert fake_ws.send_command.await_count == 0


# --------------------------------------------------------------------------- #
# 5. 并发请求
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_concurrent_executes_match_correct_req_id(project_root: str):
    """同时发送多个 execute，各自的 req_id 与响应正确匹配。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")

    mgr, _ = _make_manager_with_mock_proc(project_root)

    req_ids_captured: list = []

    async def _delayed_response(req_id: str, result_value: Any, delay: float):
        await asyncio.sleep(delay)
        future = mgr._pending.get(req_id)
        if future and not future.done():
            future.set_result({"ok": True, "result": result_value})

    with patch.object(mgr._proc.stdin, "write"):
        with patch.object(mgr._proc.stdin, "drain", new_callable=AsyncMock):
            # 发送两个请求
            task1 = asyncio.create_task(mgr.execute("return 1", timeout=5000))
            task2 = asyncio.create_task(mgr.execute("return 2", timeout=5000))

            # 等待 pending 中注册完毕
            await asyncio.sleep(0.02)
            pending_ids = list(mgr._pending.keys())
            assert len(pending_ids) == 2

            # 反向顺序触发响应，验证匹配逻辑
            tasks = [
                asyncio.create_task(_delayed_response(pending_ids[1], "second", 0.03)),
                asyncio.create_task(_delayed_response(pending_ids[0], "first", 0.06)),
            ]

            results = await asyncio.gather(task1, task2)
            await asyncio.gather(*tasks)

    # 无论响应到达顺序如何，结果应与请求顺序一致
    assert results[0] == {"ok": True, "result": "first"}
    assert results[1] == {"ok": True, "result": "second"}
    await mgr.stop()


# --------------------------------------------------------------------------- #
# 6. stop() 清理
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_stop_sets_is_ready_false(project_root: str):
    """stop() 后 is_ready 应为 False。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")

    mgr, mock_proc = _make_manager_with_mock_proc(project_root)
    assert mgr.is_ready is True

    await mgr.stop()
    assert mgr.is_ready is False
    assert mgr._proc is None


@pytest.mark.asyncio
async def test_stop_idempotent(project_root: str):
    """连续调用 stop() 不应抛出异常。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")

    mgr, _ = _make_manager_with_mock_proc(project_root)
    await mgr.stop()
    await mgr.stop()  # 第二次不应崩溃
    assert mgr.is_ready is False


# --------------------------------------------------------------------------- #
# 7. 崩溃恢复信号
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_execute_after_proc_exit_returns_error(project_root: str):
    """模拟子进程退出后，execute() 返回清晰错误。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")

    mgr, mock_proc = _make_manager_with_mock_proc(project_root)
    # 模拟子进程已退出
    mock_proc.returncode = 1

    result = await mgr.execute("return 1")

    assert result["ok"] is False
    assert "未就绪" in result["error"] or "stdin" in result["error"].lower()

    await mgr.stop()


@pytest.mark.asyncio
async def test_read_loop_closes_pending_on_proc_exit(project_root: str):
    """子进程 stdout 关闭时，_read_loop 应取消所有 pending future。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")

    mgr, mock_proc = _make_manager_with_mock_proc(project_root)
    mock_proc.stdout.readline = AsyncMock(return_value=b"")
    mock_proc.stderr.readline = AsyncMock(return_value=b"")

    future: asyncio.Future = asyncio.get_running_loop().create_future()
    mgr._pending["test-req-1"] = future

    # 手动启动 read_loop，模拟子进程 stdout 立即 EOF
    await mgr._read_loop()

    assert future.done()
    with pytest.raises(RuntimeError):
        future.result()

    await mgr.stop()


# --------------------------------------------------------------------------- #
# 8. Integration 测试（需要真实 Node.js 环境）
# --------------------------------------------------------------------------- #


@pytest.mark.integration
@pytest.mark.asyncio
async def test_integration_start_real_nodejs(project_root: str, runtime_entry_path: str):
    """在真实 Node.js 进程中测试启动与执行（需要 node >=18）。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")
    if not shutil.which("node"):
        pytest.skip("系统中未安装 Node.js")
    if not os.path.isfile(runtime_entry_path):
        pytest.skip("runtime/nodejs-playwright-runtime.mjs 不存在")

    mgr = NodeJSRuntimeManager(project_root=project_root)
    try:
        started = await mgr.start()
        if not started:
            pytest.skip(f"Node.js Runtime 启动失败: {mgr.startup_error}")

        assert mgr.is_ready is True

        # 执行简单表达式
        result = await mgr.execute("return 1+1", timeout=5000)
        assert result["ok"] is True
        assert result["result"] == 2
    finally:
        await mgr.stop()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_integration_error_with_stack(project_root: str, runtime_entry_path: str):
    """真实 Node.js 进程中执行抛出异常的代码。"""
    if NodeJSRuntimeManager is None:
        pytest.skip("NodeJSRuntimeManager 未导入")
    if not shutil.which("node"):
        pytest.skip("系统中未安装 Node.js")
    if not os.path.isfile(runtime_entry_path):
        pytest.skip("runtime/nodejs-playwright-runtime.mjs 不存在")

    mgr = NodeJSRuntimeManager(project_root=project_root)
    try:
        started = await mgr.start()
        if not started:
            pytest.skip(f"Node.js Runtime 启动失败: {mgr.startup_error}")

        result = await mgr.execute("throw new Error('integration-test-error')", timeout=5000)
        assert result["ok"] is False
        assert "integration-test-error" in result["error"]
        assert result.get("stack") is not None
    finally:
        await mgr.stop()
