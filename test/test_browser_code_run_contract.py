# -*- coding: utf-8 -*-
"""Contract tests for the browser_code_run rename and local-browser SOP."""

from __future__ import annotations

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _read(path: str) -> str:
    return (PROJECT_ROOT / path).read_text(encoding="utf-8")


def test_local_browser_skill_prefers_open_tabs_and_claim_tab_for_complex_tasks():
    skill = _read("skills/link2chrome-browser-mcp/SKILL.md")

    required_flow = (
        "browser_diagnose -> browser_tabs_list -> browser_session(action='create' 或 'new_tab') "
        "-> assert current URL -> globalThis.tab = target tab"
    )
    assert required_flow in skill
    assert "browser.user.openTabs()" in skill
    assert "browser.user.claimTab" in skill
    assert "复杂任务不要默认从 browser.tabs.selected() 开始" in skill


def test_runtime_exposes_browser_code_run_startup_summary_contract():
    runtime = _read("runtime/nodejs-playwright-runtime.mjs")

    assert "async function collectStartupSummary" in runtime
    assert "startupSummary" in runtime
    assert "debuggable" in runtime
    assert "session" in runtime
    assert "group" in runtime


def test_link2chrome_client_has_open_tabs_claim_tab_and_wait_fallback():
    client = _read("runtime/link2chrome-client.mjs")

    assert "async openTabs()" in client
    assert "async claimTab" in client
    assert "browser.user.openTabs" in client
    assert "browser.user.claimTab" in client
    assert "waitForLoadState" in client
    assert "script_evaluate" in client


def test_readme_and_skill_use_browser_code_run_as_primary_name():
    readme = _read("README.md")
    skill = _read("skills/link2chrome-browser-mcp/SKILL.md")

    assert "**browser_code_run**" in readme
    assert "`browser_code_run` 是 local-browser MCP" in skill
    assert "`playwright_run`" not in readme
    assert "`playwright_run`" not in skill
