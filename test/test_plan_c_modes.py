# -*- coding: utf-8 -*-

import asyncio
import json
import os
from pathlib import Path

import pytest

from server.tool_descriptions import TOOL_DEFINITIONS


def tool_names():
    return {tool["name"] for tool in TOOL_DEFINITIONS}


def test_plan_c_public_tool_names_are_exposed():
    names = tool_names()

    assert "browser_dom_overview" in names
    assert "browser_screenshot" in names
    assert "action_click" in names
    assert "action_drag" in names
    assert "browser_code_run" in names
    assert "playwright_run" not in names


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


