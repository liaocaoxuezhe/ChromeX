# -*- coding: utf-8 -*-
import json
import os
import sys
import types

import pytest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)


def install_mcp_stubs():
    if "mcp.server" in sys.modules:
        return

    server_module = types.ModuleType("mcp.server")
    stdio_module = types.ModuleType("mcp.server.stdio")
    types_module = types.ModuleType("mcp.types")

    class Server:
        def __init__(self, name):
            self.name = name

        def list_tools(self):
            return lambda fn: fn

        def call_tool(self):
            return lambda fn: fn

        def create_initialization_options(self):
            return {}

    class TextContent:
        def __init__(self, type, text):
            self.type = type
            self.text = text

    class ImageContent:
        def __init__(self, type, data, mimeType):
            self.type = type
            self.data = data
            self.mimeType = mimeType

    class Tool:
        def __init__(self, name, description, inputSchema):
            self.name = name
            self.description = description
            self.inputSchema = inputSchema

    server_module.Server = Server
    stdio_module.stdio_server = lambda: None
    types_module.TextContent = TextContent
    types_module.ImageContent = ImageContent
    types_module.Tool = Tool
    sys.modules["mcp.server"] = server_module
    sys.modules["mcp.server.stdio"] = stdio_module
    sys.modules["mcp.types"] = types_module


@pytest.mark.asyncio
async def test_agent_cannot_switch_to_tab_outside_session(monkeypatch):
    install_mcp_stubs()
    import server.main as main

    class FakeWS:
        async def send_command(self, command, params=None):
            if command == "tab_group_create":
                return {"groupId": 77, "tabId": 10}
            if command == "agent_browser_tab_switch":
                raise AssertionError("switch must not reach extension for out-of-session tab")
            return {"ok": True}

    monkeypatch.setattr(main, "ws_manager", FakeWS())
    monkeypatch.setattr(main, "session_manager", main.SessionManager())

    await main.tool_agent_first("browser_session", {
        "action": "create",
        "session": "安全任务",
        "group_title": "安全任务",
    })
    result = await main.tool_agent_first("browser_tab", {
        "action": "switch",
        "session": "安全任务",
        "tabId": 999,
    })

    payload = json.loads(result[0].text)
    assert "outside session" in payload["error"]
