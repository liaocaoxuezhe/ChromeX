import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.tool_descriptions import TOOL_DEFINITIONS


def _tool(name):
    return next(tool for tool in TOOL_DEFINITIONS if tool["name"] == name)


def test_network_tools_are_public_with_expected_controls():
    public_names = {tool["name"] for tool in TOOL_DEFINITIONS}

    expected = {
        "network_capture",
        "network_list",
        "network_query",
        "network_fetch",
        "network_replay",
    }
    assert expected.issubset(public_names)

    capture_schema = _tool("network_capture")["inputSchema"]
    assert capture_schema["properties"]["action"]["enum"] == ["start", "stop", "status", "clear"]

    fetch_schema = _tool("network_fetch")["inputSchema"]
    assert {"url", "method", "headers", "body"}.issubset(fetch_schema["properties"])


def test_console_tools_are_public_and_filterable():
    public_names = {tool["name"] for tool in TOOL_DEFINITIONS}

    assert {"console_capture", "console_list", "console_get", "console_clear"}.issubset(public_names)
    assert "types" in _tool("console_list")["inputSchema"]["properties"]
    assert _tool("console_get")["inputSchema"]["required"] == ["id"]


def test_hover_upload_and_dialog_are_public_actions():
    public_names = {tool["name"] for tool in TOOL_DEFINITIONS}

    assert {"action_hover", "upload_file", "handle_dialog"}.issubset(public_names)
    assert _tool("upload_file")["inputSchema"]["required"] == ["selector", "paths"]
    assert _tool("handle_dialog")["inputSchema"]["properties"]["action"]["enum"] == ["accept", "dismiss"]


def test_main_dispatches_new_agent_first_tools():
    main_source = Path("server/main.py").read_text(encoding="utf-8")

    for tool_name in [
        "network_capture",
        "network_list",
        "network_query",
        "network_fetch",
        "network_replay",
        "console_capture",
        "console_list",
        "console_get",
        "console_clear",
        "upload_file",
        "handle_dialog",
    ]:
        assert f'"{tool_name}"' in main_source


def test_extension_registers_cdp_event_capture_and_handlers():
    extension_source = Path("extension/background.js").read_text(encoding="utf-8")

    assert "chrome.debugger.onEvent.addListener(handleDebuggerEvent)" in extension_source
    for handler in [
        "cmdNetworkCapture",
        "cmdNetworkList",
        "cmdNetworkQuery",
        "cmdNetworkFetch",
        "cmdNetworkReplay",
        "cmdConsoleCapture",
        "cmdConsoleList",
        "cmdConsoleGet",
        "cmdConsoleClear",
        "cmdUploadFile",
        "cmdHandleDialog",
    ]:
        assert f"async function {handler}" in extension_source
