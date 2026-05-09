import ast
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.tool_descriptions import TOOL_DEFINITIONS


REMOVED_TOOL_NAMES = {"file_write", "file_read", "file_list"}


def test_removed_file_tools_are_not_public():
    public_names = {tool["name"] for tool in TOOL_DEFINITIONS}

    assert public_names.isdisjoint(REMOVED_TOOL_NAMES)


def test_removed_file_tools_have_no_main_handlers():
    main_source = Path("server/main.py").read_text(encoding="utf-8")
    tree = ast.parse(main_source)

    function_names = {
        node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
    }
    constants = {
        node.value for node in ast.walk(tree) if isinstance(node, ast.Constant)
    }

    assert not function_names.intersection(
        {"tool_file_write", "tool_file_read_json", "tool_file_list"}
    )
    assert constants.isdisjoint(REMOVED_TOOL_NAMES)
