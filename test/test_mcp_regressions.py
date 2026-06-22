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


async def _ensure_test_session(name: str, ws_manager=None):
    await main.session_manager.ensure_session(name, name, ws_manager or main.ws_manager)


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
    monkeypatch.setattr(main, "session_manager", main.SessionManager())
    asyncio.run(_ensure_test_session("data-url", fake))

    url = "data:text/html;charset=utf-8,%E4%B8%AD%E6%96%87"
    expected_scope = main.session_manager.scope_payload("data-url")
    result = asyncio.run(main.tool_agent_first("browser_navigate", {"url": url, "session": "data-url"}))

    assert _payload(result)["finalUrl"] == url
    assert next(command for command in fake.commands if command[0] == "navigate") == (
        "navigate",
        {
            "url": url,
            "waitUntil": "dom-ready",
            "timeout": 10000,
            "scope": expected_scope,
        },
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

    monkeypatch.setattr(main, "session_manager", main.SessionManager())
    asyncio.run(_ensure_test_session("runtime-dispatch"))

    result = asyncio.run(
        main.call_tool(
            "browser_code_run",
            {"code": "return { ran: true };", "session": "runtime-dispatch"},
        )
    )

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


def test_session_manager_tracks_seed_tab_created_for_group(monkeypatch):
    """创建 session 时，标签组种子 tab 应纳入 session 生命周期。"""
    fake = FakeWsManager()
    monkeypatch.setattr(main, "ws_manager", fake)
    monkeypatch.setattr(main, "session_manager", main.SessionManager())

    async def send_command(command, args=None, **kwargs):
        fake.commands.append((command, args or {}))
        if command == "tab_group_create":
            return {"groupId": 55, "tabId": 99}
        raise AssertionError(f"unexpected command: {command}")

    fake.send_command = send_command

    result = asyncio.run(
        main.call_tool(
            "browser_session",
            {"action": "create", "session": "seeded", "group_title": "种子组"},
        )
    )

    assert _payload(result)["ok"] is True
    sessions = main.session_manager.list_sessions()
    assert sessions == [
        {
            "session": "seeded",
            "groupTitle": "种子组",
            "tabCount": 1,
            "groupId": 55,
            "closed": False,
        }
    ]


def test_extension_tab_group_create_uses_agent_seed_tab_not_user_active_tab():
    """tab_group_create 不应把用户当前页或陈旧 targetTabId 当建组种子。"""
    source = Path("extension/background.js").read_text(encoding="utf-8")
    start = source.index("async function cmdTabGroupCreate")
    end = source.index("async function cmdTabGroupAdd", start)
    body = source[start:end]

    assert "chrome.tabs.create" in body
    assert "chrome.tabs.query({ active: true, lastFocusedWindow: true })" not in body
    assert "let tabId = targetTabId" not in body
    assert "return { groupId, title, tabId }" in body


def test_extension_navigation_prefers_tracked_target_over_user_active_tab():
    """已有 session 种子 tab 时，导航应优先复用 targetTabId 而不是用户当前页。"""
    source = Path("extension/background.js").read_text(encoding="utf-8")
    start = source.index("async function navigateWithTabs")
    end = source.index("async function cmdNavigate", start)
    body = source[start:end]

    target_lookup = body.find("if (targetTabId)")
    active_lookup = body.find("chrome.tabs.query({ active: true, lastFocusedWindow: true })")
    assert target_lookup != -1
    assert active_lookup != -1
    assert target_lookup < active_lookup


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

    async def _execute(code, timeout=30000, *, lease_token=None, session=None, scope=None):
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
                "session": "smoke-browser-code",
                "code": (
                    "const tabs = await browser.user.openTabs();\n"
                    "const target = tabs.find(t => (t.raw?.url || '').includes('example.com'));\n"
                    "globalThis.tab = target ? await browser.user.claimTab(target) : await browser.tabs.new({ url: 'https://example.com/form', active: false });\n"
                    "const livePersistedValue = 'persisted-ok';\n"
                    "return { bound: true };"
                )
            },
        )
    )
    assert _payload(first)["meta"]["startupSummary"]["boundTab"]["id"] == 101

    second = asyncio.run(
        main.call_tool(
            "browser_code_run",
            {"code": "return livePersistedValue;", "session": "smoke-browser-code"},
        )
    )
    assert _payload(second)["result"] == "persisted-ok"

    finalized = asyncio.run(
        main.call_tool(
            "browser_code_run",
            {
                "code": "await browser.tabs.finalize({ keep: [{ tab: globalThis.tab, status: 'handoff' }] }); return { finalized: true };",
                "session": "smoke-browser-code",
            },
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
    monkeypatch.setattr(main, "session_manager", main.SessionManager())
    asyncio.run(_ensure_test_session("dom-text", fake))

    result = asyncio.run(
        main.tool_agent_first(
            "browser_dom_get_text",
            {"selector": "#status", "include_meta": True, "session": "dom-text"},
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
