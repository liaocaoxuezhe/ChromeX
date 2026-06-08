# -*- coding: utf-8 -*-

import asyncio
import json
import os
from pathlib import Path

import pytest

from server.tool_descriptions import TOOL_DEFINITIONS


def tool_names():
    return {tool["name"] for tool in TOOL_DEFINITIONS}


def test_legacy_external_vision_tool_is_not_public():
    names = tool_names()

    assert "browser_action_vision" not in names
    assert "tool_action_vision" not in names
    assert not Path("server/vision.py").exists()


def test_doubao_configuration_has_been_removed_from_setup_docs():
    docs = "\n".join(
        Path(path).read_text(encoding="utf-8")
        for path in ["README.md", "setup.sh"]
    )

    assert "DOUBAO_" not in docs
    assert "doubao" not in docs.lower()


def test_requirements_do_not_force_python39_to_install_incompatible_mcp():
    requirements = Path("server/requirements.txt").read_text(encoding="utf-8")

    assert "\nmcp>=1.0.0\n" not in f"\n{requirements}"
    assert 'python_version >= "3.10"' in requirements


def test_browser_registry_prefers_env_path(monkeypatch, tmp_path):
    from server.browsers.registry import resolve

    executable = tmp_path / "Tabbit"
    executable.write_text("#!/bin/sh\n", encoding="utf-8")
    executable.chmod(0o755)
    monkeypatch.setenv("TABBIT_EXECUTABLE_PATH", str(executable))

    spec = resolve("tabbit")

    assert spec.name == "tabbit"
    assert spec.executable_path == str(executable)
    assert "Tabbit" in spec.default_user_data_dir


def test_cua_click_converts_screenshot_pixels_to_css_pixels():
    from server.modes.cua import CuaController

    class FakeWs:
        def __init__(self):
            self.commands = []

        async def send_command(self, command, params=None):
            self.commands.append((command, params or {}))
            if command == "get_info":
                return {
                    "viewport": {
                        "innerWidth": 800,
                        "innerHeight": 600,
                        "devicePixelRatio": 2,
                    }
                }
            return {"ok": True}

    fake = FakeWs()
    result = asyncio.run(CuaController(fake).click({"x": 320, "y": 240}))

    assert fake.commands[-1] == ("click", {"x": 160, "y": 120, "button": "left", "clickCount": 1})
    assert result["coordinateSpace"] == "screenshot"
    assert result["css"] == {"x": 160, "y": 120}


def test_playwright_endpoint_reports_not_started():
    from server.modes.playwright_plane import PlaywrightPlane

    result = asyncio.run(PlaywrightPlane().endpoint({}))

    assert result["ok"] is False
    assert result["error"] == "playwright_not_started"
