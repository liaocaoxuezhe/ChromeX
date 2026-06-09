# -*- coding: utf-8 -*-
"""
Static tests for Link2Chrome MCP tool definitions.

These tests validate the tool definitions in server.tool_descriptions
without requiring a live browser or WebSocket connection.

Run with:
    cd /Users/zhangyu/PycharmProjects/Link2Chrome
    server/venv/bin/python -m pytest test/test_tools.py -v
"""

from __future__ import annotations

import sys
import os

# Ensure project root is on path
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from server.tool_descriptions import TOOL_DEFINITIONS, PUBLIC_TOOL_NAMES


# ==================== 1. Tool count ====================

def test_tool_definitions_has_exactly_26_tools():
    assert len(TOOL_DEFINITIONS) == 26, (
        f"Expected 26 tools in TOOL_DEFINITIONS, got {len(TOOL_DEFINITIONS)}"
    )


def test_public_tool_names_has_exactly_26_entries():
    assert len(PUBLIC_TOOL_NAMES) == 26, (
        f"Expected 26 entries in PUBLIC_TOOL_NAMES, got {len(PUBLIC_TOOL_NAMES)}"
    )


def test_public_tool_names_matches_tool_definitions():
    defined_names = {tool["name"] for tool in TOOL_DEFINITIONS}
    public_names = set(PUBLIC_TOOL_NAMES)
    assert defined_names == public_names, (
        f"Mismatch: defined={defined_names}, public={public_names}"
    )


# ==================== 2. Required tools present ====================

REQUIRED_TOOLS = {
    "browser_navigate",
    "browser_tab",
    "browser_session",
    "browser_tabs_list",
    "browser_dom_overview",
    "browser_dom_query",
    "browser_dom_search",
    "browser_dom_get_text",
    "browser_dom_diff",
    "browser_screenshot",
    "action_click",
    "action_double_click",
    "action_hover",
    "action_scroll",
    "action_drag",
    "action_fill",
    "action_press_key",
    "upload_file",
    "handle_dialog",
    "playwright_run",
    "script_evaluate",
    "save_as_pdf",
    "console_check",
    "network_check",
    "browser_scrape_with_scroll",
    "browser_diagnose",
}


def test_all_required_tools_present():
    defined_names = {tool["name"] for tool in TOOL_DEFINITIONS}
    missing = REQUIRED_TOOLS - defined_names
    assert not missing, f"Missing required tools: {missing}"


# ==================== 3. Tool structure validation ====================

def test_each_tool_has_name():
    for tool in TOOL_DEFINITIONS:
        assert isinstance(tool.get("name"), str), f"Tool missing valid name: {tool}"
        assert tool["name"].strip(), f"Tool name is empty: {tool}"


def test_each_tool_has_description():
    for tool in TOOL_DEFINITIONS:
        desc = tool.get("description")
        assert isinstance(desc, str), f"Tool {tool['name']} missing description"
        assert desc.strip(), f"Tool {tool['name']} has empty description"


def test_each_tool_has_input_schema():
    for tool in TOOL_DEFINITIONS:
        schema = tool.get("inputSchema")
        assert isinstance(schema, dict), f"Tool {tool['name']} missing inputSchema"
        assert schema.get("type") == "object", (
            f"Tool {tool['name']} inputSchema must have type='object'"
        )


# ==================== 4. Specific schema validations ====================

def _get_tool(name: str) -> dict:
    for tool in TOOL_DEFINITIONS:
        if tool["name"] == name:
            return tool
    raise AssertionError(f"Tool {name} not found")


def test_browser_navigate_schema():
    tool = _get_tool("browser_navigate")
    props = tool["inputSchema"].get("properties", {})
    assert "action" in props, "browser_navigate must have 'action' property"
    enum = props["action"].get("enum", [])
    assert set(enum) >= {"goto", "back", "forward", "reload"}, (
        f"browser_navigate action enum missing values: {enum}"
    )


def test_browser_tab_schema():
    tool = _get_tool("browser_tab")
    props = tool["inputSchema"].get("properties", {})
    assert "action" in props, "browser_tab must have 'action' property"
    enum = props["action"].get("enum", [])
    assert set(enum) >= {"new", "switch", "close"}, (
        f"browser_tab action enum missing values: {enum}"
    )


def test_action_fill_schema():
    tool = _get_tool("action_fill")
    required = tool["inputSchema"].get("required", [])
    assert "target" in required, "action_fill must require 'target'"
    assert "value" in required, "action_fill must require 'value'"


def test_console_check_schema():
    tool = _get_tool("console_check")
    props = tool["inputSchema"].get("properties", {})
    assert "action" in props, "console_check must have 'action' property"


def test_network_check_schema():
    tool = _get_tool("network_check")
    props = tool["inputSchema"].get("properties", {})
    assert "action" in props, "network_check must have 'action' property"


def test_browser_session_schema():
    tool = _get_tool("browser_session")
    props = tool["inputSchema"].get("properties", {})
    assert "action" in props, "browser_session must have 'action' property"
    enum = props["action"].get("enum", [])
    assert set(enum) >= {"create", "add", "close", "list"}, (
        f"browser_session action enum missing values: {enum}"
    )
    assert "session" in props, "browser_session must have 'session' property"
    assert "group_title" in props, "browser_session must have 'group_title' property"
    assert "tabId" in props, "browser_session must have 'tabId' property"


# ==================== 5. Old tools must NOT be present ====================

FORBIDDEN_TOOLS = {
    "browser.set_mode",
    "browser.get_mode",
    "console_capture",
    "network_capture",
    "dom_overview",
    "action_type",
}


def test_no_old_tool_names_present():
    defined_names = {tool["name"] for tool in TOOL_DEFINITIONS}
    found_forbidden = defined_names & FORBIDDEN_TOOLS
    assert not found_forbidden, f"Found forbidden old tools: {found_forbidden}"


# ==================== 6. Additional consistency checks ====================

def test_no_duplicate_tool_names():
    names = [tool["name"] for tool in TOOL_DEFINITIONS]
    assert len(names) == len(set(names)), f"Duplicate tool names found: {names}"


def test_tool_names_are_strings():
    for tool in TOOL_DEFINITIONS:
        name = tool["name"]
        assert isinstance(name, str), f"Tool name must be string, got {type(name)}"
        assert name.strip(), "Tool name must not be empty"
