# -*- coding: utf-8 -*-

from pathlib import Path


def _background() -> str:
    return Path("extension/background.js").read_text(encoding="utf-8")


def test_tab_switch_only_focuses_window_when_requested():
    background = _background()
    switch_body = background.split("async function cmdAgentBrowserTabSwitch", 1)[1].split(
        "async function cmdAgentBrowserTabNew", 1
    )[0]

    assert "params.focusWindow === true" in switch_body
    assert "await chrome.windows.update(tab.windowId, { focused: true });" in switch_body
    assert switch_body.index("params.focusWindow === true") < switch_body.index(
        "await chrome.windows.update(tab.windowId, { focused: true });"
    )


def test_action_click_tab_change_focus_is_opt_in():
    background = _background()
    detector_body = background.split("async function detectActionTabChange", 1)[1].split(
        "// -- type --", 1
    )[0]
    action_click_body = background.split("async function cmdActionClick", 1)[1].split(
        "async function resolveActionPoint", 1
    )[0]

    assert "const focusWindow = options.focusWindow === true" in detector_body
    assert "if (focusWindow === true && openedTab.windowId != null)" in detector_body
    assert "detectActionTabChange(beforeTabs, { focusWindow: params.focusWindow === true })" in action_click_body


def test_session_new_tab_and_runtime_tabs_new_preserve_focus_options():
    server_main = Path("server/main.py").read_text(encoding="utf-8")
    runtime = Path("runtime/link2chrome-client.mjs").read_text(encoding="utf-8")
    background = _background()

    session_new_tab = server_main.split('if action == "new_tab":', 1)[1].split('if action == "add":', 1)[0]
    tabs_new = runtime.split("async new(urlOrOptions, options = {})", 1)[1].split("async finalize", 1)[0]
    tab_new = background.split("async function cmdAgentBrowserTabNew", 1)[1].split(
        "async function cmdAgentBrowserTabClose", 1
    )[0]

    assert '"active": args.get("active", False)' in session_new_tab
    assert '"focusWindow": args.get("focusWindow", False)' in session_new_tab
    assert "active: args.active === true" in tabs_new
    assert "focusWindow: args.focusWindow === true" in tabs_new
    assert "if (params.focusWindow === true && tab.windowId != null)" in tab_new
