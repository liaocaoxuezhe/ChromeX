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

    def operation(self, name):
        return _AsyncOperation()

    async def send_command(self, command, args=None, **kwargs):
        args = args or {}
        self.commands.append((command, args))
        if command == "navigate":
            return {"url": args["url"], "status": "complete", "method": "tabs"}
        if command == "get_info":
            return {"tabId": 7, "url": "http://example.test", "title": "中文标题"}
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


def test_playwright_run_dispatch_reaches_runtime(monkeypatch):
    fake = FakeWsManager()
    monkeypatch.setattr(main, "ws_manager", fake)

    result = asyncio.run(main.call_tool("playwright_run", {"code": "return { ran: true };"}))

    assert _payload(result)["ok"] is True
    assert fake.commands[0][0] == "playwright_batch"


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
