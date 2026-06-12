# -*- coding: utf-8 -*-
"""
DOM 快照缓存

保存每次 browser_dom_overview 的文本输出和 URL，用于 browser_dom_diff 计算变化。
"""

import difflib
import logging
import time
from typing import Any, Optional

logger = logging.getLogger("link2chrome.dom_cache")


class DomSnapshotCache:
    """缓存每个标签页的 DOM overview 文本快照，支持 diff 计算。"""

    def __init__(self):
        # tab_id (int) → {"text": str, "url": str, "timestamp": float}
        self._cache: dict[int, dict[str, Any]] = {}

    def save_snapshot(self, tab_id: int, url: str, text: str) -> None:
        """保存某个标签页的 DOM overview 快照。"""
        self._cache[tab_id] = {
            "text": text,
            "url": url,
            "timestamp": time.time(),
        }
        logger.info(f"保存 DOM 快照 tab={tab_id} url={url[:80]} chars={len(text)}")

    def get_snapshot(self, tab_id: int) -> Optional[dict[str, Any]]:
        """获取某个标签页的上次快照。"""
        snap = self._cache.get(tab_id)
        if snap is None:
            return None
        return {"text": snap["text"], "url": snap["url"]}

    def compute_diff(self, tab_id: int, current_text: str, current_url: str) -> str:
        """计算当前页面与上次快照的 diff。

        - URL 变化：返回导航提示
        - URL 相同：返回 unified_diff 文本
        - 无快照：返回提示信息
        """
        snap = self._cache.get(tab_id)
        if snap is None:
            return "No previous snapshot. Call browser_dom_overview first."

        old_url = snap["url"]
        old_text = snap["text"]

        if old_url != current_url:
            return f"Navigated: {old_url} → {current_url}"

        # 使用 unified_diff 做文本级 diff
        old_lines = old_text.splitlines(keepends=True)
        new_lines = current_text.splitlines(keepends=True)

        diff = list(
            difflib.unified_diff(
                old_lines,
                new_lines,
                fromfile="previous",
                tofile="current",
                lineterm="",
            )
        )

        if not diff:
            return "No changes detected."

        return "".join(diff)

    def clear(self, tab_id: Optional[int] = None) -> None:
        """清除缓存。tab_id=None 时清除全部。"""
        if tab_id is None:
            self._cache.clear()
        else:
            self._cache.pop(tab_id, None)
