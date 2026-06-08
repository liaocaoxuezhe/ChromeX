# -*- coding: utf-8 -*-
"""Browser executable and profile registry for the Playwright/CDP plane."""

from __future__ import annotations

import glob
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class BrowserSpec:
    name: str
    executable_path: Optional[str]
    default_user_data_dir: str
    cdp_env_var: str

    @property
    def available(self) -> bool:
        return bool(self.executable_path and Path(self.executable_path).exists())


def resolve(browser: str | None = None) -> BrowserSpec:
    name = (browser or os.getenv("LINK2CHROME_BROWSER") or "chrome").strip().lower()
    if name in {"google-chrome", "chromium"}:
        name = "chrome"
    if name not in {"chrome", "tabbit"}:
        raise ValueError(f"unsupported browser: {browser}")

    if name == "tabbit":
        return BrowserSpec(
            name="tabbit",
            executable_path=_first_existing(
                os.getenv("TABBIT_EXECUTABLE_PATH"),
                *_tabbit_candidates(),
            ),
            default_user_data_dir=str(
                Path.home() / "Library" / "Application Support" / "Tabbit Browser"
            ),
            cdp_env_var="TABBIT_CDP_URL",
        )

    return BrowserSpec(
        name="chrome",
        executable_path=_first_existing(
            os.getenv("CHROME_EXECUTABLE_PATH"),
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ),
        default_user_data_dir=str(Path.home() / "Library" / "Application Support" / "Google" / "Chrome"),
        cdp_env_var="CHROME_CDP_URL",
    )


def _tabbit_candidates() -> list[str]:
    patterns = [
        "/Applications/Tabbit*.app/Contents/MacOS/*",
        str(Path.home() / "Applications" / "Tabbit*.app" / "Contents" / "MacOS" / "*"),
    ]
    candidates: list[str] = []
    for pattern in patterns:
        candidates.extend(glob.glob(pattern))
    return candidates


def _first_existing(*paths: Optional[str]) -> Optional[str]:
    for path in paths:
        if path and Path(path).exists():
            return str(Path(path).expanduser())
    return None
