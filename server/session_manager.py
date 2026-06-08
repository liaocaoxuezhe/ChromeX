# -*- coding: utf-8 -*-
"""
Session 管理器

维护 session_name → Chrome 标签组的映射，实现任务级标签页生命周期管理。
一个任务 = 一个 session = 一个 Chrome 标签组。
"""

import logging
from typing import Any, Optional

logger = logging.getLogger("link2chrome.session")


class SessionManager:
    """管理浏览器 session 与 Chrome 标签组的映射。"""

    def __init__(self):
        # session_name → {group_id, tab_ids: set, group_title}
        self._sessions: dict[str, dict[str, Any]] = {}

    async def ensure_session(
        self,
        session: str,
        group_title: Optional[str],
        ws_manager,
    ) -> dict[str, Any]:
        """确保 session 存在，如不存在则创建标签组。"""
        if session in self._sessions:
            return self._sessions[session]

        title = group_title or session
        try:
            result = await ws_manager.send_command(
                "tab_group_create", {"title": title}
            )
            group_id = result.get("groupId")
            if group_id is None:
                logger.warning(f"创建标签组失败，Extension 未返回 groupId: {result}")
                # 降级：不使用标签组，但保留 session 记录
                self._sessions[session] = {
                    "group_id": None,
                    "tab_ids": set(),
                    "group_title": title,
                }
                return self._sessions[session]

            self._sessions[session] = {
                "group_id": group_id,
                "tab_ids": set(),
                "group_title": title,
            }
            logger.info(f"创建 session '{session}' → group {group_id} (title='{title}')")
            return self._sessions[session]
        except Exception as e:
            logger.warning(f"创建标签组异常，降级处理: {e}")
            self._sessions[session] = {
                "group_id": None,
                "tab_ids": set(),
                "group_title": title,
            }
            return self._sessions[session]

    async def add_tab_to_session(
        self,
        session: str,
        tab_id: int,
        ws_manager,
    ) -> None:
        """将标签页加入 session 的标签组。"""
        if not session:
            return

        info = self._sessions.get(session)
        if info is None:
            logger.warning(f"Session '{session}' 不存在，跳过 add_tab")
            return

        info["tab_ids"].add(tab_id)
        group_id = info.get("group_id")
        if group_id is not None:
            try:
                await ws_manager.send_command(
                    "tab_group_add",
                    {"tabId": tab_id, "groupId": group_id},
                )
                logger.info(f"Tab {tab_id} 加入 session '{session}' group {group_id}")
            except Exception as e:
                logger.warning(f"将 tab {tab_id} 加入标签组失败: {e}")
        else:
            logger.info(f"Tab {tab_id} 加入 session '{session}' (无标签组)")

    async def close_session(self, session: str, ws_manager) -> dict[str, Any]:
        """关闭 session，移除标签组内所有标签页。"""
        info = self._sessions.pop(session, None)
        if info is None:
            return {"ok": False, "error": f"Session '{session}' 不存在"}

        group_id = info.get("group_id")
        closed_count = 0
        if group_id is not None:
            try:
                result = await ws_manager.send_command(
                    "tab_group_close", {"groupId": group_id}
                )
                closed_count = result.get("closedCount", 0)
                logger.info(f"关闭 session '{session}' group {group_id}，关闭 {closed_count} 个标签")
            except Exception as e:
                logger.warning(f"关闭标签组失败: {e}")
                # 回退：逐个关闭记录的 tab
                for tab_id in list(info.get("tab_ids", [])):
                    try:
                        await ws_manager.send_command("tab_manage", {"action": "close", "tabId": tab_id})
                        closed_count += 1
                    except Exception:
                        pass
        else:
            # 无标签组，逐个关闭
            for tab_id in list(info.get("tab_ids", [])):
                try:
                    await ws_manager.send_command("tab_manage", {"action": "close", "tabId": tab_id})
                    closed_count += 1
                except Exception:
                    pass

        return {
            "ok": True,
            "session": session,
            "closedCount": closed_count,
        }

    def list_sessions(self) -> list[dict[str, Any]]:
        """列出所有活跃 session。"""
        return [
            {
                "session": name,
                "groupTitle": info["group_title"],
                "tabCount": len(info["tab_ids"]),
                "groupId": info.get("group_id"),
            }
            for name, info in self._sessions.items()
        ]

    def get_session_info(self, session: str) -> Optional[dict[str, Any]]:
        """获取单个 session 的信息。"""
        return self._sessions.get(session)
