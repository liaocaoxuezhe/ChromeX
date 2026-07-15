from __future__ import annotations

import asyncio
import copy
import sys
import types

import pytest

from server.hub_client import HubClient
from server.session_protocol import SessionHandle, SessionProtocolError


def test_session_protocol_defaults_to_v2_with_explicit_v1_rollback():
    from server import browser_hub, hub_client

    assert browser_hub.SESSION_PROTOCOL_MODE == "v2"
    assert hub_client.SESSION_PROTOCOL_MODE == "v2"
    assert HubClient(protocol_mode="v1").protocol_mode == "v1"
    assert HubClient(protocol_mode="shadow").protocol_mode == "shadow"


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
            return lambda function: function

        def call_tool(self):
            return lambda function: function

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

    mcp_module.server = server_module
    server_module.Server = Server
    stdio_module.stdio_server = lambda: None
    types_module.TextContent = TextContent
    types_module.ImageContent = ImageContent
    types_module.Tool = Tool
    sys.modules["mcp"] = mcp_module
    sys.modules["mcp.server"] = server_module
    sys.modules["mcp.server.stdio"] = stdio_module
    sys.modules["mcp.types"] = types_module


def handle(session_id, owner_id, adapter_id, alias, group_id, tab_id):
    return SessionHandle(
        session_id=session_id,
        owner_id=owner_id,
        adapter_id=adapter_id,
        alias=alias,
        group_id=group_id,
        group_title=alias,
        window_id=1,
        target_tab_id=tab_id,
        revision=1,
        state="ACTIVE",
        browser_epoch="epoch-a",
    )


class RecordingHubClient(HubClient):
    def __init__(self):
        super().__init__(
            control_url="ws://unused",
            adapter_id="adapter-default",
            owner_id="owner-default",
            protocol_mode="v2",
        )
        self._started = True
        self.messages = []
        self.release = asyncio.Event()
        self.two_entered = asyncio.Event()
        self.wait_for_release = False

    async def _round_trip(self, message, request_id, timeout):
        self.messages.append(copy.deepcopy(message))
        if len(self.messages) >= 2:
            self.two_entered.set()
        if self.wait_for_release:
            await self.release.wait()
        return {
            "request_id": request_id,
            "success": True,
            "data": {"requestId": request_id, "sessionId": message.get("sessionId")},
        }


@pytest.mark.asyncio
async def test_send_session_command_carries_complete_explicit_envelope():
    client = RecordingHubClient()
    session = handle("session-a", "owner-a", "adapter-a", "research", 11, 101)

    await client.send_session_command(
        session,
        "navigate",
        {"url": "https://example.com"},
        operation_id="operation-a",
        tab_id=101,
    )

    message = client.messages[0]
    assert message == {
        "protocolVersion": 2,
        "requestId": message["requestId"],
        "operationId": "operation-a",
        "adapterId": "adapter-a",
        "ownerId": "owner-a",
        "sessionId": "session-a",
        "sessionAlias": "research",
        "sessionRevision": 1,
        "groupId": 11,
        "tabId": 101,
        "command": "navigate",
        "params": {"url": "https://example.com"},
    }


@pytest.mark.asyncio
async def test_concurrent_session_commands_cannot_cross_shared_client_state():
    client = RecordingHubClient()
    client.wait_for_release = True
    session_a = handle("session-a", "owner-a", "adapter-a", "research", 11, 101)
    session_b = handle("session-b", "owner-b", "adapter-b", "research", 22, 202)

    task_a = asyncio.create_task(
        client.send_session_command(
            session_a, "navigate", {"url": "https://a.test"}, "operation-a", 101
        )
    )
    task_b = asyncio.create_task(
        client.send_session_command(
            session_b, "navigate", {"url": "https://b.test"}, "operation-b", 202
        )
    )

    await asyncio.wait_for(client.two_entered.wait(), timeout=0.5)
    by_session = {message["sessionId"]: message for message in client.messages}
    assert by_session["session-a"]["ownerId"] == "owner-a"
    assert by_session["session-a"]["tabId"] == 101
    assert by_session["session-b"]["ownerId"] == "owner-b"
    assert by_session["session-b"]["tabId"] == 202

    client.release.set()
    await asyncio.gather(task_a, task_b)


@pytest.mark.asyncio
async def test_create_session_uses_client_owner_identity_without_mutable_scope():
    client = RecordingHubClient()

    await client.create_session(
        alias="research",
        group_title="调研",
        operation_id="operation-create",
    )

    message = client.messages[0]
    assert message["command"] == "__session_create__"
    assert message["params"] == {
        "ownerId": "owner-default",
        "adapterId": "adapter-default",
        "alias": "research",
        "groupTitle": "调研",
        "operationId": "operation-create",
    }
    assert client._session_scope is None
    assert client._lease_token is None


@pytest.mark.asyncio
async def test_v2_error_is_raised_with_structured_code_and_details():
    class RejectingClient(RecordingHubClient):
        async def _round_trip(self, message, request_id, timeout):
            return {
                "request_id": request_id,
                "success": False,
                "error": "tab 202 is outside session research",
                "code": "TAB_OUTSIDE_SESSION",
                "details": {"tabId": 202, "sessionId": "session-a"},
            }

    client = RejectingClient()
    session = handle("session-a", "owner-a", "adapter-a", "research", 11, 101)

    with pytest.raises(SessionProtocolError) as exc:
        await client.send_session_command(
            session, "navigate", {}, "operation-a", tab_id=202
        )

    assert exc.value.code == "TAB_OUTSIDE_SESSION"
    assert exc.value.details["tabId"] == 202


@pytest.mark.asyncio
async def test_get_and_list_session_controls_preserve_public_alias():
    client = RecordingHubClient()

    await client.get_session("research")
    await client.list_sessions()

    assert client.messages[0]["command"] == "__session_get__"
    assert client.messages[0]["params"] == {
        "ownerId": "owner-default",
        "adapterId": "adapter-default",
        "alias": "research",
    }
    assert client.messages[1]["command"] == "__session_list__"
    assert client.messages[1]["params"] == {
        "ownerId": "owner-default",
        "adapterId": "adapter-default",
    }


@pytest.mark.asyncio
async def test_open_session_materializes_group_and_create_tab_uses_latest_revision():
    class WorkflowClient(RecordingHubClient):
        async def _round_trip(self, message, request_id, timeout):
            self.messages.append(copy.deepcopy(message))
            command = message["command"]
            if command == "__session_create__":
                data = handle(
                    "session-a", "owner-default", "adapter-default",
                    "research", None, None,
                ).to_payload()
                data.update({"state": "CREATING", "revision": 0})
            elif command == "__session_materialize__":
                data = handle(
                    "session-a", "owner-default", "adapter-default",
                    "research", 11, 101,
                ).to_payload()
            elif command == "__session_create_tab__":
                data = handle(
                    "session-a", "owner-default", "adapter-default",
                    "research", 11, 102,
                ).to_payload()
                data.update({"revision": 2, "tabId": 102})
            else:
                raise AssertionError(command)
            return {"request_id": request_id, "success": True, "data": data}

    client = WorkflowClient()

    active = await client.open_session("research", "调研")
    created = await client.create_session_tab(active, "https://example.com")

    assert active["state"] == "ACTIVE"
    assert active["groupId"] == 11
    assert created["tabId"] == 102
    materialize = client.messages[1]
    create_tab = client.messages[2]
    assert materialize["params"]["expectedRevision"] == 0
    assert materialize["params"]["ownerId"] == "owner-default"
    assert create_tab["params"]["expectedRevision"] == 1
    assert create_tab["params"]["url"] == "https://example.com"


def test_v1_compatibility_scope_remains_available_only_for_legacy_path():
    client = HubClient(protocol_mode="v1")
    client.set_session_scope("写作")

    assert client._session_scope == "写作"
    assert client.protocol_mode == "v1"


@pytest.mark.asyncio
async def test_main_v2_scoped_send_resolves_handle_and_never_reads_local_scope(monkeypatch):
    install_mcp_stubs()
    import server.main as main

    session = handle("session-a", "owner-a", "adapter-a", "research", 11, 101)

    class FakeHub:
        protocol_mode = "v2"

        def __init__(self):
            self.calls = []

        async def get_session(self, alias):
            assert alias == "research"
            return session.to_payload()

        async def send_session_command(
            self, resolved, command, params, operation_id=None, tab_id=None
        ):
            self.calls.append((resolved, command, params, operation_id, tab_id))
            return {"ok": True, "tabId": tab_id}

    class ForbiddenLocalManager:
        def scope_payload(self, alias):
            raise AssertionError("V2 must not build authority from local SessionManager")

        def is_tab_allowed(self, alias, tab_id):
            raise AssertionError("V2 must not authorize tabs from local SessionManager")

    fake_hub = FakeHub()
    monkeypatch.setattr(main, "ws_manager", fake_hub)
    monkeypatch.setattr(main, "session_manager", ForbiddenLocalManager())

    result = await main._scoped_send(
        "navigate",
        {"url": "https://example.com", "active": True, "focusWindow": True},
        "research",
        tab_id=101,
    )

    assert result == {"ok": True, "tabId": 101}
    _, command, params, operation_id, tab_id = fake_hub.calls[0]
    assert command == "navigate"
    assert params == {"url": "https://example.com"}
    assert operation_id
    assert tab_id == 101


@pytest.mark.asyncio
async def test_main_v2_browser_session_create_and_new_tab_use_hub_lifecycle(monkeypatch):
    install_mcp_stubs()
    import server.main as main

    active = handle("session-a", "owner-a", "adapter-a", "research", 11, 101).to_payload()

    class FakeHub:
        protocol_mode = "v2"

        def __init__(self):
            self.calls = []

        async def open_session(self, alias, group_title=None):
            self.calls.append(("open", alias, group_title))
            return dict(active)

        async def get_session(self, alias):
            self.calls.append(("get", alias))
            return dict(active)

        async def create_session_tab(self, session_handle, url):
            self.calls.append(("new_tab", session_handle["sessionId"], url))
            return {**active, "revision": 2, "targetTabId": 102, "tabId": 102}

    class ForbiddenLocalManager:
        async def ensure_session(self, *args, **kwargs):
            raise AssertionError("V2 lifecycle must not create local Session ownership")

    fake_hub = FakeHub()
    monkeypatch.setattr(main, "ws_manager", fake_hub)
    monkeypatch.setattr(main, "session_manager", ForbiddenLocalManager())

    created = await main.tool_agent_first(
        "browser_session",
        {"action": "create", "session": "research", "group_title": "调研"},
    )
    new_tab = await main.tool_agent_first(
        "browser_session",
        {"action": "new_tab", "session": "research", "url": "example.com"},
    )

    created_payload = __import__("json").loads(created[0].text)
    tab_payload = __import__("json").loads(new_tab[0].text)
    assert created_payload["ok"] is True
    assert created_payload["sessionId"] == "session-a"
    assert created_payload["groupId"] == 11
    assert created_payload["protocolVersion"] == 2
    assert tab_payload["tabId"] == 102
    assert tab_payload["url"] == "https://example.com"
    assert fake_hub.calls == [
        ("open", "research", "调研"),
        ("get", "research"),
        ("new_tab", "session-a", "https://example.com"),
    ]


@pytest.mark.asyncio
async def test_main_v2_tool_router_does_not_acquire_legacy_global_operation(monkeypatch):
    install_mcp_stubs()
    import server.main as main

    active = handle("session-a", "owner-a", "adapter-a", "research", 11, 101).to_payload()

    class FakeHub:
        protocol_mode = "v2"

        async def open_session(self, alias, group_title=None):
            return dict(active)

        def operation(self, name):
            raise AssertionError("V2 tool calls must not acquire the legacy global lease")

    monkeypatch.setattr(main, "ws_manager", FakeHub())

    result = await main.call_tool(
        "browser_session",
        {"action": "create", "session": "research"},
    )

    payload = __import__("json").loads(result[0].text)
    assert payload["ok"] is True
    assert payload["sessionId"] == "session-a"


@pytest.mark.asyncio
async def test_main_v2_serializes_whole_tool_calls_per_session(monkeypatch):
    install_mcp_stubs()
    import server.main as main
    from server.session_scheduler import SessionScheduler

    class FakeHub:
        protocol_mode = "v2"
        owner_id = "owner-a"

    entered = []
    first_entered = asyncio.Event()
    release = asyncio.Event()

    async def route(name, arguments):
        entered.append(arguments["label"])
        if arguments["label"] == "first":
            first_entered.set()
            await release.wait()
        return main._json_content({"ok": True})

    monkeypatch.setattr(main, "ws_manager", FakeHub())
    monkeypatch.setattr(main, "_route_tool_call", route)
    monkeypatch.setattr(main, "_tool_session_scheduler", SessionScheduler(max_concurrent_sessions=8))

    first = asyncio.create_task(main.call_tool("test", {"session": "research", "label": "first"}))
    await first_entered.wait()
    second = asyncio.create_task(main.call_tool("test", {"session": "research", "label": "second"}))
    await asyncio.sleep(0)
    assert entered == ["first"]
    release.set()
    await asyncio.gather(first, second)
    assert entered == ["first", "second"]


@pytest.mark.asyncio
async def test_main_v2_allows_whole_tool_calls_for_different_sessions_to_overlap(monkeypatch):
    install_mcp_stubs()
    import server.main as main
    from server.session_scheduler import SessionScheduler

    class FakeHub:
        protocol_mode = "v2"
        owner_id = "owner-a"

    entered = asyncio.Event()
    both_entered = asyncio.Event()
    release = asyncio.Event()
    count = 0

    async def route(name, arguments):
        nonlocal count
        count += 1
        if count == 1:
            entered.set()
        if count == 2:
            both_entered.set()
        await release.wait()
        return main._json_content({"ok": True})

    monkeypatch.setattr(main, "ws_manager", FakeHub())
    monkeypatch.setattr(main, "_route_tool_call", route)
    monkeypatch.setattr(main, "_tool_session_scheduler", SessionScheduler(max_concurrent_sessions=8))

    first = asyncio.create_task(main.call_tool("test", {"session": "research-a"}))
    await entered.wait()
    second = asyncio.create_task(main.call_tool("test", {"session": "research-b"}))
    await asyncio.wait_for(both_entered.wait(), timeout=0.5)
    release.set()
    await asyncio.gather(first, second)
