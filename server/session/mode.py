# -*- coding: utf-8 -*-
"""Session-level browser mode state."""

from __future__ import annotations

SUPPORTED_MODES = {"dom", "cua", "pw"}


class ModeError(ValueError):
    pass


class ModeSession:
    def __init__(self, default_mode: str = "dom"):
        self._mode = _normalize_mode(default_mode)

    def get_mode(self) -> str:
        return self._mode

    def set_mode(self, mode: str) -> dict:
        next_mode = _normalize_mode(mode)
        previous = self._mode
        self._mode = next_mode
        return {"mode": next_mode, "previousMode": previous}


def _normalize_mode(mode: str) -> str:
    normalized = (mode or "").strip().lower()
    if normalized not in SUPPORTED_MODES:
        raise ModeError(f"unsupported mode: {mode}. expected one of: dom, cua, pw")
    return normalized
