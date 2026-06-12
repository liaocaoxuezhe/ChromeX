# -*- coding: utf-8 -*-

from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path


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


class _AsyncOperation:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class FakeWsManager:
    def __init__(self):
        self.commands = []
        self._tab_id = 100
        self._lease_token = None

    def operation(self, name):
        return _AsyncOperation()

    async def send_command(self, command, args=None, **kwargs):
        args = args or {}
        self.commands.append((command, args))
        if command == "navigate":
            return {"url": args["url"], "status": "complete", "method": "tabs"}
        if command == "tab_group_create":
            return {"groupId": 55}
        if command == "tab_group_add":
            return {"ok": True}
        if command == "agent_browser_tab_new":
            self._tab_id += 1
            return {"tabId": self._tab_id, "url": args.get("url")}
        if command == "get_info":
            return {"tabId": self._tab_id, "url": "http://example.test", "title": "中文标题"}
        if command == "playwright_batch":
            return {"ok": True, "result": {"ran": True}}
        if command == "script_evaluate":
            return {
                "ok": True,
                "result": {
                    "text": "已生效",
                    "charCount": 3,
                    "meta": {"tag": "p", "visible": True},
                },
            }
        if command == "dom_get_text":
            raise RuntimeError("未知指令: dom_get_text")
        raise AssertionError(f"unexpected command: {command}")


def test_browser_navigate_preserves_data_url(monkeypatch):
    fake = FakeWsManager()
    monkeypatch.setattr(main, "ws_manager", fake)

    url = "data:text/html;charset=utf-8,%E4%B8%AD%E6%96%87"
    result = asyncio.run(main.tool_agent_first("browser_navigate", {"url": url}))

    assert _payload(result)["finalUrl"] == url
    assert fake.commands[0] == (
        "navigate",
        {"url": url, "waitUntil": "dom-ready", "timeout": 10000},
    )


def test_browser_code_run_dispatch_reaches_runtime(monkeypatch):
    """browser_code_run 是主工具名，mock ready 后应走 nodejs_runtime.execute。"""
    from unittest.mock import AsyncMock, MagicMock

    mock_nodejs = MagicMock()
    mock_nodejs.is_ready = True
    mock_nodejs.startup_error = None
    mock_nodejs.start = AsyncMock(return_value=True)
    mock_nodejs.execute = AsyncMock(return_value={"ok": True, "result": {"ran": True}})
    monkeypatch.setattr(main, "nodejs_runtime", mock_nodejs)

    result = asyncio.run(main.call_tool("browser_code_run", {"code": "return { ran: true };"}))

    assert _payload(result)["ok"] is True
    assert _payload(result)["result"] == {"ran": True}
    mock_nodejs.execute.assert_awaited_once()


def test_playwright_run_is_no_longer_callable(monkeypatch):
    """playwright_run 已移除公开兼容入口，避免模型继续选择旧工具名。"""
    from unittest.mock import AsyncMock, MagicMock

    mock_nodejs = MagicMock()
    mock_nodejs.is_ready = True
    mock_nodejs.startup_error = None
    mock_nodejs.start = AsyncMock(return_value=True)
    mock_nodejs.execute = AsyncMock(return_value={"ok": True, "result": {"alias": True}})
    monkeypatch.setattr(main, "nodejs_runtime", mock_nodejs)

    result = asyncio.run(main.call_tool("playwright_run", {"code": "return { alias: true };"}))

    assert _payload(result)["ok"] is False
    assert "未知工具" in _payload(result)["error"]
    mock_nodejs.execute.assert_not_awaited()


def test_browser_code_run_smoke_sequence_covers_session_reuse_persistence_and_finalize(monkeypatch):
    """稳定冒烟：建标签组、打开目标页、复用 tab、跨调用变量持久化、保存后 finalize。"""
    from unittest.mock import AsyncMock, MagicMock

    fake_ws = FakeWsManager()
    monkeypatch.setattr(main, "ws_manager", fake_ws)
    monkeypatch.setattr(main, "session_manager", main.SessionManager())

    calls = []
    mock_nodejs = MagicMock()
    mock_nodejs.is_ready = True
    mock_nodejs.startup_error = None
    mock_nodejs.start = AsyncMock(return_value=True)

    async def _execute(code, timeout=30000, *, lease_token=None):
        calls.append(code)
        if "livePersistedValue" in code and "return livePersistedValue" in code:
            return {"ok": True, "result": "persisted-ok", "meta": {"startupSummary": {"boundTab": {"id": 101}}}}
        if "browser.tabs.finalize" in code:
            return {"ok": True, "result": {"finalized": True}, "meta": {"startupSummary": {"boundTab": {"id": 101}}}}
        return {"ok": True, "result": {"bound": True}, "meta": {"startupSummary": {"boundTab": {"id": 101}}}}

    mock_nodejs.execute = AsyncMock(side_effect=_execute)
    monkeypatch.setattr(main, "nodejs_runtime", mock_nodejs)

    opened = asyncio.run(
        main.call_tool(
            "browser_session",
            {
                "action": "new_tab",
                "session": "smoke-browser-code",
                "group_title": "冒烟测试",
                "url": "https://example.com/form",
            },
        )
    )
    assert _payload(opened)["ok"] is True

    first = asyncio.run(
        main.call_tool(
            "browser_code_run",
            {
                "code": (
                    "const tabs = await browser.user.openTabs();\n"
                    "const target = tabs.find(t => (t.raw?.url || '').includes('example.com'));\n"
                    "globalThis.tab = target ? await browser.user.claimTab(target) : await browser.tabs.new('https://example.com/form');\n"
                    "const livePersistedValue = 'persisted-ok';\n"
                    "return { bound: true };"
                )
            },
        )
    )
    assert _payload(first)["meta"]["startupSummary"]["boundTab"]["id"] == 101

    second = asyncio.run(main.call_tool("browser_code_run", {"code": "return livePersistedValue;"}))
    assert _payload(second)["result"] == "persisted-ok"

    finalized = asyncio.run(
        main.call_tool(
            "browser_code_run",
            {"code": "await browser.tabs.finalize({ keep: [{ tab: globalThis.tab, status: 'handoff' }] }); return { finalized: true };"},
        )
    )
    assert _payload(finalized)["result"] == {"finalized": True}

    assert ("tab_group_create", {"title": "冒烟测试"}) in fake_ws.commands
    assert any(command == "agent_browser_tab_new" for command, _ in fake_ws.commands)
    assert any(command == "tab_group_add" for command, _ in fake_ws.commands)
    assert len(calls) == 3


def test_dom_get_text_selector_falls_back_when_extension_command_is_missing(monkeypatch):
    fake = FakeWsManager()
    monkeypatch.setattr(main, "ws_manager", fake)

    result = asyncio.run(
        main.tool_agent_first(
            "browser_dom_get_text",
            {"selector": "#status", "include_meta": True},
        )
    )

    payload = _payload(result)
    assert payload["ok"] is True
    assert payload["text"] == "已生效"
    assert payload["meta"]["tag"] == "p"


def test_extension_reenables_console_domains_after_attach():
    source = Path("extension/background.js").read_text(encoding="utf-8")

    assert "async function enableCaptureDomainsForAttachedTab" in source
    assert "consoleCaptureState.enabled" in source
    assert 'await enableCaptureDomainsForAttachedTab(tabId)' in source


def test_extension_recovers_from_stale_debugger_attachment():
    source = Path("extension/background.js").read_text(encoding="utf-8")

    assert "isDebuggerAlreadyAttachedError" in source
    assert "await detachDebuggerTab(tabId)" in source
    assert "failedIds.delete(tabId)" in source
    assert "continue" in source.split("isDebuggerAlreadyAttachedError", 1)[1]


def test_tabs_navigation_detaches_before_reusing_tab():
    source = Path("extension/background.js").read_text(encoding="utf-8")
    navigate_block = source.split("async function navigateWithTabs", 1)[1].split(
        "async function cmdNavigate", 1
    )[0]
    update_index = navigate_block.index("await chrome.tabs.update(tabId, { url });")
    detach_index = navigate_block.index("await detachDebuggerTab(tabId);")

    assert detach_index < update_index
    assert "attachedTabId = null;" in navigate_block[detach_index:update_index]
