import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.tool_descriptions import TOOL_DEFINITIONS


def _tool(name):
    return next(tool for tool in TOOL_DEFINITIONS if tool["name"] == name)


def test_browser_navigate_exposes_fast_commit_and_timeout_controls():
    schema = _tool("browser_navigate")["inputSchema"]
    props = schema["properties"]

    assert props["waitUntil"]["enum"] == ["dom-ready", "commit"]
    assert "timeout" in props


def test_browser_navigate_does_not_double_wait_in_python_dispatch():
    main_source = Path("server/main.py").read_text(encoding="utf-8")
    navigate_block = main_source.split('if name == "browser_navigate":', 1)[1]
    navigate_block = navigate_block.split('if name == "browser_screenshot":', 1)[0]

    assert "agent_browser_wait" not in navigate_block
    assert '"waitUntil": args.get("waitUntil", "dom-ready")' in navigate_block
    assert '"timeout": args.get("timeout", 10000)' in navigate_block


def test_extension_navigate_defaults_to_tabs_api():
    extension_source = Path("extension/background.js").read_text(encoding="utf-8")
    navigate_block = extension_source.split("async function cmdNavigate(params)", 1)[1]
    navigate_block = navigate_block.split("// -- get_dom --", 1)[0]

    assert 'method = "tabs"' in navigate_block
    assert 'if (method !== "cdp" || !usesStandardWebProtocol)' in navigate_block
    assert "return navigateWithTabs(url, timeout)" in navigate_block


def test_extension_cdp_commands_have_timeout_guard():
    extension_source = Path("extension/background.js").read_text(encoding="utf-8")
    send_cdp_block = extension_source.split("async function sendCDP(method, params = {})", 1)[1]
    send_cdp_block = send_cdp_block.split("async function sleep", 1)[0]

    assert "withTimeout(ensureDebuggerAttached()" in send_cdp_block
    assert "withTimeout(" in send_cdp_block
    assert "chrome.debugger.sendCommand" in send_cdp_block
