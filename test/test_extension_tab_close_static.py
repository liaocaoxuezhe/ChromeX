# -*- coding: utf-8 -*-

from pathlib import Path


def test_extension_tab_manage_close_accepts_tab_id():
    background = Path("extension/background.js").read_text(encoding="utf-8")
    tab_manage = background.split("async function cmdTabManage", 1)[1].split("// -- scroll --", 1)[0]
    close_branch = tab_manage.split('case "close":', 1)[1].split('case "switch":', 1)[0]

    assert "tabId" in tab_manage.split("{", 1)[1].split(";", 1)[0]
    assert "await chrome.tabs.remove(tabId)" in close_branch
