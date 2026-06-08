# -*- coding: utf-8 -*-
"""Minimal Playwright/CDP plane lifecycle.

The implementation is intentionally lazy so Link2Chrome can still run in
extension-only mode when Playwright is not installed.
"""

from __future__ import annotations

import os
from typing import Optional

from server.browsers.registry import resolve


class PlaywrightPlane:
    def __init__(self):
        self._endpoint: Optional[str] = None
        self._mode: Optional[str] = None
        self._browser: Optional[str] = None

    async def start(self, args: dict) -> dict:
        mode = args.get("mode", "attach")
        browser_name = args.get("browser", "chrome")
        spec = resolve(browser_name)

        if mode == "attach":
            endpoint = args.get("cdpUrl") or os.getenv("PLAYWRIGHT_CDP_URL") or os.getenv(spec.cdp_env_var)
            if not endpoint:
                return {
                    "ok": False,
                    "error": "missing_cdp_endpoint",
                    "message": f"请先用 --remote-debugging-port 启动 {spec.name}，或设置 PLAYWRIGHT_CDP_URL/{spec.cdp_env_var}。",
                    "fallback": "launch",
                }
            self._endpoint = endpoint
            self._mode = mode
            self._browser = spec.name
            return {"ok": True, "mode": mode, "browser": spec.name, "endpoint": endpoint}

        if mode == "launch":
            if not spec.available:
                return {
                    "ok": False,
                    "error": "browser_not_found",
                    "browser": spec.name,
                    "message": f"找不到 {spec.name} 可执行文件，请设置对应 *_EXECUTABLE_PATH。",
                }
            return {
                "ok": False,
                "error": "playwright_not_installed_or_not_launched",
                "browser": spec.name,
                "executablePath": spec.executable_path,
                "message": "launch 模式需要安装 Playwright 并启动持久化 context；当前实现保留接口并优先支持 attach/endpoint。",
            }

        return {"ok": False, "error": "unsupported_mode", "mode": mode}

    async def endpoint(self, args: dict) -> dict:
        if not self._endpoint:
            return {"ok": False, "error": "playwright_not_started"}
        return {"ok": True, "endpoint": self._endpoint, "mode": self._mode, "browser": self._browser}

    async def stop(self, args: dict) -> dict:
        previous = self._endpoint
        self._endpoint = None
        self._mode = None
        self._browser = None
        return {"ok": True, "stopped": bool(previous)}

    async def command_not_available(self, command: str) -> dict:
        return {
            "ok": False,
            "error": "playwright_not_connected",
            "command": command,
            "message": "请先调用 browser.pw.start(mode='attach') 并提供 CDP endpoint；或使用 browser.dom/browser.cua 工具。",
        }
