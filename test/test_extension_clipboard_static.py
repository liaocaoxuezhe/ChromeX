# -*- coding: utf-8 -*-

import json
from pathlib import Path


def test_extension_declares_clipboard_permissions():
    manifest = json.loads(Path("extension/manifest.json").read_text(encoding="utf-8"))

    assert "clipboardRead" in manifest["permissions"]
    assert "clipboardWrite" in manifest["permissions"]


def test_extension_handles_clipboard_commands():
    background = Path("extension/background.js").read_text(encoding="utf-8")

    assert 'case "clipboard_read"' in background
    assert 'case "clipboard_write"' in background
    assert "async function cmdClipboardRead" in background
    assert "async function cmdClipboardWrite" in background
    assert "navigator.clipboard.readText" in background
    assert "navigator.clipboard.writeText" in background
