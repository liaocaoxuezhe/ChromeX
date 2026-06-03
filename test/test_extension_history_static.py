# -*- coding: utf-8 -*-

import json
from pathlib import Path


def test_extension_declares_history_permission():
    manifest = json.loads(Path("extension/manifest.json").read_text(encoding="utf-8"))

    assert "history" in manifest["permissions"]


def test_extension_handles_agent_browser_history_command():
    background = Path("extension/background.js").read_text(encoding="utf-8")

    assert 'case "agent_browser_history"' in background
    assert "async function cmdAgentBrowserHistory" in background
    assert "chrome.history.search" in background
