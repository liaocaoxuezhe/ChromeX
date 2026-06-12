# -*- coding: utf-8 -*-
"""
task-5: browser_code_run 强制 Node.js Runtime 优先策略测试

验证 tool_browser_code_run 不再降级到 Extension 端 PlaywrightRuntime，
在 Node.js 不可用时返回明确错误。

运行方式:
    server/venv/bin/python test/test_task5_browser_code_run_policy.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock


# --------------------------------------------------------------------------- #
# 0. 在 import server.main 之前先 mock mcp 模块，避免真实 MCP Server 初始化
# --------------------------------------------------------------------------- #
if "mcp" not in sys.modules:
    mcp_module = types.ModuleType("mcp")
    mcp_server_module = types.ModuleType("mcp.server")
    mcp_stdio_module = types.ModuleType("mcp.server.stdio")
    mcp_types_module = types.ModuleType("mcp.types")

    class FakeServer:
        def __init__(self, name):
            self.name = name

        def list_tools(self):
            return lambda fn: fn

        def call_tool(self):
            return lambda fn: fn

    class FakeContent:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    mcp_server_module.Server = FakeServer
    mcp_stdio_module.stdio_server = object
    mcp_types_module.TextContent = FakeContent
    mcp_types_module.ImageContent = FakeContent
    mcp_types_module.Tool = FakeContent
    sys.modules["mcp"] = mcp_module
    sys.modules["mcp.server"] = mcp_server_module
    sys.modules["mcp.server.stdio"] = mcp_stdio_module
    sys.modules["mcp.types"] = mcp_types_module


from server import main


def _payload(result):
    return json.loads(result[0].text)


# --------------------------------------------------------------------------- #
# 辅助夹具
# --------------------------------------------------------------------------- #

def _make_ready_mock():
    """构造一个 is_ready=True、execute 返回成功的 mock NodeJSRuntimeManager。"""
    mock = MagicMock()
    mock.is_ready = True
    mock.startup_error = None
    mock.start = AsyncMock(return_value=True)
    mock.execute = AsyncMock(return_value={"ok": True, "result": {"foo": "bar"}})
    return mock


def _make_startup_error_mock(error_msg="未检测到 Node.js 运行时。"):
    """构造一个 start() 返回 False 且带有 startup_error 的 mock。"""
    mock = MagicMock()
    mock.is_ready = False
    mock.startup_error = error_msg
    mock.start = AsyncMock(return_value=False)
    mock.execute = AsyncMock()
    return mock


def _make_none():
    """显式返回 None，用于 nodejs_runtime 为 None 的场景。"""
    return None


# --------------------------------------------------------------------------- #
# 测试场景 (a): nodejs_runtime ready → 必须调用 execute，不走旧 Extension 端 runtime.run
# --------------------------------------------------------------------------- #

def test_browser_code_run_uses_nodejs_when_ready(monkeypatch):
    """Node.js Runtime 已就绪时，应直接走 execute，绝不调用旧 Extension 端 runtime.run。"""
    mock_nodejs = _make_ready_mock()
    monkeypatch.setattr(main, "nodejs_runtime", mock_nodejs)

    mock_pw_runtime = MagicMock()
    mock_pw_runtime.run = AsyncMock()
    monkeypatch.setattr(main, "playwright_runtime", mock_pw_runtime)

    result = asyncio.run(main.tool_browser_code_run({"code": "return 1;"}))
    payload = _payload(result)

    assert payload["ok"] is True
    assert payload["result"] == {"foo": "bar"}
    mock_nodejs.execute.assert_awaited_once()
    mock_pw_runtime.run.assert_not_awaited()


# --------------------------------------------------------------------------- #
# 测试场景 (b)-1: nodejs_runtime 存在但未就绪，启动失败 → 返回明确错误，不降级
# --------------------------------------------------------------------------- #

def test_browser_code_run_rejects_fallback_on_startup_error(monkeypatch):
    """Node.js Runtime 启动失败时，应返回明确错误，不再降级到旧 Extension 端 runtime.run。"""
    mock_nodejs = _make_startup_error_mock("未检测到 Node.js 运行时。")
    monkeypatch.setattr(main, "nodejs_runtime", mock_nodejs)

    mock_pw_runtime = MagicMock()
    mock_pw_runtime.run = AsyncMock()
    monkeypatch.setattr(main, "playwright_runtime", mock_pw_runtime)

    result = asyncio.run(main.tool_browser_code_run({"code": "return 1;"}))
    payload = _payload(result)

    assert payload["ok"] is False
    error = payload.get("error", "")
    assert "Node.js" in error
    assert ">=18" in error
    assert "check-node-env.mjs" in error
    mock_nodejs.start.assert_awaited_once()
    mock_pw_runtime.run.assert_not_awaited()


# --------------------------------------------------------------------------- #
# 测试场景 (b)-2: nodejs_runtime 存在，execute 抛出异常 → 返回明确错误，不降级
# --------------------------------------------------------------------------- #

def test_browser_code_run_rejects_fallback_on_execute_exception(monkeypatch):
    """Node.js Runtime execute 异常时，应返回明确错误，不再降级到旧 Extension 端 runtime.run。"""
    mock_nodejs = _make_ready_mock()
    mock_nodejs.execute = AsyncMock(side_effect=RuntimeError("IPC broken"))
    monkeypatch.setattr(main, "nodejs_runtime", mock_nodejs)

    mock_pw_runtime = MagicMock()
    mock_pw_runtime.run = AsyncMock()
    monkeypatch.setattr(main, "playwright_runtime", mock_pw_runtime)

    result = asyncio.run(main.tool_browser_code_run({"code": "return 1;"}))
    payload = _payload(result)

    assert payload["ok"] is False
    error = payload.get("error", "")
    assert "Node.js" in error
    assert ">=18" in error
    mock_pw_runtime.run.assert_not_awaited()


# --------------------------------------------------------------------------- #
# 测试场景 (c): nodejs_runtime 为 None → 返回明确错误
# --------------------------------------------------------------------------- #

def test_browser_code_run_rejects_when_nodejs_is_none(monkeypatch):
    """Node.js Runtime 未配置时，应返回明确错误。"""
    monkeypatch.setattr(main, "nodejs_runtime", None)

    mock_pw_runtime = MagicMock()
    mock_pw_runtime.run = AsyncMock()
    monkeypatch.setattr(main, "playwright_runtime", mock_pw_runtime)

    result = asyncio.run(main.tool_browser_code_run({"code": "return 1;"}))
    payload = _payload(result)

    assert payload["ok"] is False
    error = payload.get("error", "")
    assert "Node.js" in error
    assert ">=18" in error
    assert "check-node-env.mjs" in error
    mock_pw_runtime.run.assert_not_awaited()


# --------------------------------------------------------------------------- #
# 测试场景 (d): nodejs_runtime 未就绪但 start 成功 → 正常执行
# --------------------------------------------------------------------------- #

def test_browser_code_run_starts_nodejs_then_executes(monkeypatch):
    """Node.js Runtime 未就绪但启动成功时，应先 start 再 execute。"""
    mock_nodejs = _make_startup_error_mock()
    mock_nodejs.is_ready = False
    mock_nodejs.start = AsyncMock(return_value=True)
    mock_nodejs.execute = AsyncMock(return_value={"ok": True, "result": 42})
    monkeypatch.setattr(main, "nodejs_runtime", mock_nodejs)

    mock_pw_runtime = MagicMock()
    mock_pw_runtime.run = AsyncMock()
    monkeypatch.setattr(main, "playwright_runtime", mock_pw_runtime)

    result = asyncio.run(main.tool_browser_code_run({"code": "return 42;"}))
    payload = _payload(result)

    assert payload["ok"] is True
    assert payload["result"] == 42
    mock_nodejs.start.assert_awaited_once()
    mock_nodejs.execute.assert_awaited_once()
    mock_pw_runtime.run.assert_not_awaited()


# --------------------------------------------------------------------------- #
# 测试场景 (e): execute 返回 ok=False（用户代码出错）→ 原样透传
# --------------------------------------------------------------------------- #

def test_browser_code_run_passthrough_user_code_error(monkeypatch):
    """Node.js 执行成功但用户代码报错时，应透传错误信息。"""
    mock_nodejs = _make_ready_mock()
    mock_nodejs.execute = AsyncMock(return_value={
        "ok": False,
        "error": "ReferenceError: x is not defined",
        "stack": "at eval (eval at execute)",
    })
    monkeypatch.setattr(main, "nodejs_runtime", mock_nodejs)

    result = asyncio.run(main.tool_browser_code_run({"code": "x;"}))
    payload = _payload(result)

    assert payload["ok"] is False
    assert payload["error"] == "ReferenceError: x is not defined"
    assert payload["stack"] == "at eval (eval at execute)"


# --------------------------------------------------------------------------- #
# 测试场景 (f): 截断逻辑保持不变
# --------------------------------------------------------------------------- #

def test_browser_code_run_truncation_preserved(monkeypatch):
    """结果超长时，应保持截断格式与改造前一致。"""
    long_result = "a" * 30000
    mock_nodejs = _make_ready_mock()
    mock_nodejs.execute = AsyncMock(return_value={"ok": True, "result": long_result})
    monkeypatch.setattr(main, "nodejs_runtime", mock_nodejs)

    result = asyncio.run(main.tool_browser_code_run({
        "code": "return 'a'.repeat(30000);",
        "max_result_chars": 20000,
    }))
    payload = _payload(result)

    assert payload["ok"] is True
    assert payload["truncated"] is True
    assert "...[truncated]" in payload["result"]
    assert payload["charCount"] == 20000 + len("\n...[truncated]")


# --------------------------------------------------------------------------- #
# 主入口（兼容直接 python 文件运行）
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    import pytest

    sys.exit(pytest.main([__file__, "-v"]))
