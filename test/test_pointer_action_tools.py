import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.tool_descriptions import TOOL_DEFINITIONS


def _tool(name):
    return next(tool for tool in TOOL_DEFINITIONS if tool["name"] == name)


def test_action_drag_is_public_with_coordinate_schema():
    tool_names = {tool["name"] for tool in TOOL_DEFINITIONS}

    assert "action_drag" in tool_names

    schema = _tool("action_drag")["inputSchema"]
    props = schema["properties"]
    assert schema["required"] == ["target"]
    assert "target" in props
    assert "to" in props
    assert "by" in props
    assert "duration" in props


def test_action_click_documents_pixel_targets():
    description = _tool("action_click")["inputSchema"]["properties"]["target"]["description"]

    assert "x" in description
    assert "y" in description
