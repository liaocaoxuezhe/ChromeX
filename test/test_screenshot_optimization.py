# -*- coding: utf-8 -*-

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import types
from pathlib import Path

from PIL import Image

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


def _png_b64(width: int = 4, height: int = 3) -> str:
    from io import BytesIO

    image = Image.new("RGBA", (width, height), (32, 96, 160, 255))
    buf = BytesIO()
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _json_payload(result):
    return json.loads(result[0].text)


class FakeScreenshotWsManager:
    def __init__(self, image_b64: str):
        self.image_b64 = image_b64
        self.commands = []
        self._lease_token = None

    async def send_command(self, command, args=None, **kwargs):
        self.commands.append((command, args or {}))
        if command == "tab_group_create":
            return {"groupId": 77}
        if command == "screenshot":
            return {"image": self.image_b64, "format": args.get("format", "jpeg")}
        if command == "get_info":
            return {"title": "中文 标题 / screenshot"}
        raise AssertionError(f"Unexpected command: {command}")


def _install_screenshot_session(monkeypatch, fake: FakeScreenshotWsManager, session: str = "screenshot-test") -> str:
    monkeypatch.setattr(main, "ws_manager", fake)
    monkeypatch.setattr(main, "session_manager", main.SessionManager())
    asyncio.run(main.session_manager.ensure_session(session, session, fake))
    fake.commands.clear()
    return session


def test_browser_screenshot_defaults_to_jpeg_quality_70(monkeypatch):
    fake = FakeScreenshotWsManager(_png_b64())
    session = _install_screenshot_session(monkeypatch, fake)

    result = asyncio.run(main.tool_agent_first("browser_screenshot", {"session": session}))
    payload = _json_payload(result)

    assert fake.commands[0] == (
        "screenshot",
        {
            "format": "jpeg",
            "quality": 70,
            "selector": None,
            "fullPage": False,
            "scope": main.session_manager.scope_payload(session),
        },
    )
    assert payload["ok"] is True
    assert payload["format"] == "jpeg"


def test_browser_screenshot_uses_session_tmpdir_and_writes_compressed_jpeg(monkeypatch):
    fake = FakeScreenshotWsManager(_png_b64(width=7, height=5))
    session = _install_screenshot_session(monkeypatch, fake)

    result = asyncio.run(main.tool_agent_first("browser_screenshot", {"session": session}))
    payload = _json_payload(result)
    output_path = Path(payload["path"])

    assert str(output_path).startswith(main._SESSION_TMPDIR)
    assert output_path.suffix == ".jpg"
    assert payload["width"] == 7
    assert payload["height"] == 5
    assert payload["coordinateSpace"] == "screenshot pixels"
    assert output_path.exists()
    with Image.open(output_path) as image:
        assert image.format == "JPEG"
        assert image.size == (7, 5)


def test_browser_screenshot_respects_explicit_path(monkeypatch, tmp_path):
    fake = FakeScreenshotWsManager(_png_b64())
    session = _install_screenshot_session(monkeypatch, fake)
    explicit_path = tmp_path / "显式截图.jpg"

    result = asyncio.run(main.tool_agent_first("browser_screenshot", {"path": str(explicit_path), "session": session}))
    payload = _json_payload(result)

    assert payload["path"] == str(explicit_path)
    assert explicit_path.exists()


def test_browser_screenshot_inline_returns_image_content_without_writing_file(monkeypatch):
    fake = FakeScreenshotWsManager(_png_b64(width=6, height=4))
    session = _install_screenshot_session(monkeypatch, fake)
    before = set(os.listdir(main._SESSION_TMPDIR))

    result = asyncio.run(main.tool_agent_first("browser_screenshot", {"inline": True, "session": session}))
    payload = _json_payload(result)
    after = set(os.listdir(main._SESSION_TMPDIR))

    assert payload == {
        "ok": True,
        "format": "jpeg",
        "width": 6,
        "height": 4,
        "coordinateSpace": "screenshot pixels",
        "sizeBytes": payload["sizeBytes"],
    }
    assert len(result) == 2
    assert result[1].type == "image"
    assert result[1].mimeType == "image/jpeg"
    assert after == before
    decoded = base64.b64decode(result[1].data)
    with Image.open(__import__("io").BytesIO(decoded)) as image:
        assert image.format == "JPEG"
        assert image.size == (6, 4)
