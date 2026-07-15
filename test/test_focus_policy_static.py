# -*- coding: utf-8 -*-

from pathlib import Path


def _background() -> str:
    return Path("extension/background.js").read_text(encoding="utf-8")


def test_tab_switch_never_changes_browser_focus():
    background = _background()
    switch_body = background.split("async function cmdAgentBrowserTabSwitch", 1)[1].split(
        "async function cmdAgentBrowserTabNew", 1
    )[0]

    assert "chrome.tabs.update(tabId, { active: true })" not in switch_body
    assert "chrome.windows.update(tab.windowId, { focused: true })" not in switch_body
    assert "targetTabId = tabId" in switch_body


def test_action_click_tab_change_never_changes_browser_focus():
    background = _background()
    detector_body = background.split("async function detectActionTabChange", 1)[1].split(
        "// -- type --", 1
    )[0]
    assert "chrome.tabs.update(openedTabId, { active: true })" not in detector_body
    assert "chrome.windows.update(openedTab.windowId, { focused: true })" not in detector_body
    assert "targetTabId = openedTabId" in detector_body


def test_focus_compatibility_fields_are_noops():
    server_main = Path("server/main.py").read_text(encoding="utf-8")
    runtime = Path("runtime/link2chrome-client.mjs").read_text(encoding="utf-8")
    descriptions = Path("server/tool_descriptions.py").read_text(encoding="utf-8")
    background = _background()

    tabs_new = runtime.split("async new(urlOrOptions, options = {})", 1)[1].split("async finalize", 1)[0]
    tab_new = background.split("async function cmdAgentBrowserTabNew", 1)[1].split(
        "async function cmdAgentBrowserTabClose", 1
    )[0]

    assert '"active": args.get(' not in server_main
    assert '"focusWindow": args.get(' not in server_main
    assert "active: args.active" not in runtime
    assert "focusWindow: args.focusWindow" not in runtime
    assert "active:" not in tabs_new
    assert "focusWindow:" not in tabs_new
    assert descriptions.count("compatibility no-op") >= 3
    assert "params.focusWindow" not in tab_new
    assert "focused: true" not in tab_new
