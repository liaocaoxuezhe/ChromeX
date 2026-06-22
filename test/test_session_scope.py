# -*- coding: utf-8 -*-
import json
import os
import sys
import types

import pytest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from server.session_manager import SessionManager


def install_mcp_stubs():
    if "mcp.server" in sys.modules:
        return

    mcp_module = types.ModuleType("mcp")
    server_module = types.ModuleType("mcp.server")
    stdio_module = types.ModuleType("mcp.server.stdio")
    types_module = types.ModuleType("mcp.types")

    class Server:
        def __init__(self, name):
            self.name = name

        def list_tools(self):
            def decorator(fn):
                return fn
            return decorator

        def call_tool(self):
            def decorator(fn):
                return fn
            return decorator

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

    async def stdio_server():
        raise RuntimeError("stdio_server stub is not used in tests")

    server_module.Server = Server
    stdio_module.stdio_server = stdio_server
    types_module.TextContent = TextContent
    types_module.ImageContent = ImageContent
    types_module.Tool = Tool
    sys.modules["mcp"] = mcp_module
    sys.modules["mcp.server"] = server_module
    sys.modules["mcp.server.stdio"] = stdio_module
    sys.modules["mcp.types"] = types_module


class FakeWS:
    def __init__(self):
        self.commands = []

    async def send_command(self, command, params=None):
        self.commands.append((command, params or {}))
        if command == "tab_group_create":
            return {"groupId": 7, "tabId": 100, "title": params["title"]}
        if command == "tab_group_add":
            return {"ok": True}
        if command == "tab_group_close":
            return {"ok": True, "closedCount": 1}
        if command == "tab_manage":
            return {"ok": True}
        if command == "get_all_tabs":
            return {
                "windows": {
                    "1": [
                        {"id": 100, "windowId": 1, "active": True, "url": "https://a.test", "title": "A", "groupId": 7},
                        {"id": 9, "windowId": 1, "active": False, "url": "https://user.test", "title": "User", "groupId": -1},
                        {"id": 999, "windowId": 1, "active": False, "url": "https://outside.test", "title": "Outside", "groupId": -1},
                    ]
                }
            }
        return {}


@pytest.mark.asyncio
async def test_session_tracks_agent_and_claimed_tabs():
    manager = SessionManager()
    ws = FakeWS()

    await manager.ensure_session("调研", "手机调研", ws)
    await manager.add_tab_to_session("调研", 101, ws, agent_created=True)
    manager.claim_tab("调研", 9)

    assert manager.is_tab_allowed("调研", 100) is True
    assert manager.is_tab_allowed("调研", 101) is True
    assert manager.is_tab_allowed("调研", 9) is True
    assert manager.is_tab_allowed("调研", 999) is False

    scope = manager.scope_payload("调研")
    assert scope["session"] == "调研"
    assert scope["groupId"] == 7
    assert sorted(scope["allowedTabIds"]) == [9, 100, 101]
    assert scope["mode"] == "session"


@pytest.mark.asyncio
async def test_finalize_closes_unkept_agent_tabs_and_releases_claimed_tabs():
    manager = SessionManager()
    ws = FakeWS()

    await manager.ensure_session("写报告", "写报告", ws)
    await manager.add_tab_to_session("写报告", 101, ws, agent_created=True)
    await manager.add_tab_to_session("写报告", 102, ws, agent_created=True)
    manager.claim_tab("写报告", 9)

    result = await manager.finalize_session(
        "写报告",
        keep=[{"tabId": 102, "status": "handoff"}],
        ws_manager=ws,
    )

    assert result["ok"] is True
    assert result["closedTabIds"] == [101]
    assert result["releasedTabIds"] == [9, 102]
    assert ("tab_manage", {"action": "close", "tabId": 101}) in ws.commands


def test_write_tools_require_session_in_schema():
    from server.tool_descriptions import TOOL_DEFINITIONS

    by_name = {tool["name"]: tool for tool in TOOL_DEFINITIONS}
    for name in ["browser_navigate", "browser_tab", "browser_dom_overview", "action_click", "browser_screenshot"]:
        schema = by_name[name]["inputSchema"]
        assert "session" in schema["properties"], name


def test_browser_session_schema_has_claim_and_finalize():
    from server.tool_descriptions import TOOL_DEFINITIONS

    tool = next(item for item in TOOL_DEFINITIONS if item["name"] == "browser_session")
    actions = tool["inputSchema"]["properties"]["action"]["enum"]
    assert "claim" in actions
    assert "finalize" in actions
    assert "keep" in tool["inputSchema"]["properties"]


def test_hub_client_attaches_session_scope_to_messages():
    from server.hub_client import HubClient

    client = HubClient()
    client.set_session_scope("写作")
    assert client._session_scope == "写作"


@pytest.mark.asyncio
async def test_browser_tabs_list_requires_session(monkeypatch):
    install_mcp_stubs()
    import server.main as main

    monkeypatch.setattr(main, "ws_manager", FakeWS())
    monkeypatch.setattr(main, "session_manager", SessionManager())

    result = await main.tool_agent_first("browser_tabs_list", {})
    payload = json.loads(result[0].text)
    assert payload["ok"] is False
    assert "session is required" in payload["error"]


@pytest.mark.asyncio
async def test_claim_requires_matching_claim_token(monkeypatch):
    install_mcp_stubs()
    import server.main as main

    ws = FakeWS()
    monkeypatch.setattr(main, "ws_manager", ws)
    monkeypatch.setattr(main, "session_manager", SessionManager())
    main._claim_tokens.clear()

    await main.tool_agent_first("browser_session", {"action": "create", "session": "接管"})
    denied = await main.tool_agent_first("browser_session", {"action": "claim", "session": "接管", "tabId": 9})
    assert "claimToken is required" in json.loads(denied[0].text)["error"]

    main._claim_tokens["token-9"] = 9
    accepted = await main.tool_agent_first(
        "browser_session",
        {"action": "claim", "session": "接管", "tabId": 9, "claimToken": "token-9"},
    )
    assert json.loads(accepted[0].text)["ok"] is True
