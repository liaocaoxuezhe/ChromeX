# -*- coding: utf-8 -*-

import json
from pathlib import Path


def test_extension_declares_tab_groups_permission_for_finalize():
    manifest = json.loads(Path("extension/manifest.json").read_text(encoding="utf-8"))

    assert "tabGroups" in manifest["permissions"]


def test_extension_handles_agent_browser_tabs_finalize_command():
    background = Path("extension/background.js").read_text(encoding="utf-8")

    assert 'case "agent_browser_tabs_finalize"' in background
    assert "async function cmdAgentBrowserTabsFinalize" in background
    assert "chrome.tabs.group" in background
    assert "chrome.tabGroups.update" in background
