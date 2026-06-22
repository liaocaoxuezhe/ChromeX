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
        # session_name → session metadata, including scope membership.
        self._sessions: dict[str, dict[str, Any]] = {}
        self._active_session: Optional[str] = None

    @property
    def active_session(self) -> Optional[str]:
        return self._active_session

    def set_active(self, session: str) -> None:
        self._active_session = session

    def clear_active(self, session: Optional[str] = None) -> None:
        if session is None or self._active_session == session:
            self._active_session = None

    def _new_record(
        self,
        session: str,
        group_id,
        group_title: str,
        seed_tab_id=None,
        seed_agent_created: bool = True,
    ) -> dict[str, Any]:
        tab_ids = {seed_tab_id} if seed_tab_id is not None else set()
        return {
            "session": session,
            "group_id": group_id,
            "group_title": group_title,
            "tab_ids": set(tab_ids),
            "agent_created_tab_ids": set(tab_ids) if seed_agent_created else set(),
            "claimed_tab_ids": set(),
            "handoff_tab_ids": set(),
            "deliverable_tab_ids": set(),
            "seed_tab_id": seed_tab_id,
            "seed_consumed": seed_tab_id is None,
            "closed": False,
        }

    def _require_session(self, session: str) -> dict[str, Any]:
        info = self._sessions.get(session)
        if info is None:
            raise KeyError(f"Session '{session}' 不存在")
        return info

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
                self._sessions[session] = self._new_record(session, None, title)
                return self._sessions[session]

            seed_tab_id = result.get("tabId")
            self._sessions[session] = self._new_record(
                session,
                group_id,
                title,
                seed_tab_id,
                seed_agent_created=False,
            )
            logger.info(f"创建 session '{session}' → group {group_id} (title='{title}')")
            self.set_active(session)
            return self._sessions[session]
        except Exception as e:
            logger.warning(f"创建标签组异常，降级处理: {e}")
            self._sessions[session] = self._new_record(session, None, title)
            return self._sessions[session]

    async def add_tab_to_session(
        self,
        session: str,
        tab_id: int,
        ws_manager,
        agent_created: bool = True,
    ) -> None:
        """将标签页加入 session 的标签组。"""
        if not session:
            return

        info = self._sessions.get(session)
        if info is None:
            logger.warning(f"Session '{session}' 不存在，跳过 add_tab")
            return

        info["tab_ids"].add(tab_id)
        if agent_created:
            info["agent_created_tab_ids"].add(tab_id)
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
        self.clear_active(session)

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

    def record_agent_tab(self, session: str, tab_id: int) -> None:
        info = self._require_session(session)
        info["tab_ids"].add(tab_id)
        info["agent_created_tab_ids"].add(tab_id)

    def claim_tab(self, session: str, tab_id: int) -> None:
        info = self._require_session(session)
        info["tab_ids"].add(tab_id)
        info["claimed_tab_ids"].add(tab_id)

    def release_tab(self, session: str, tab_id: int) -> None:
        info = self._require_session(session)
        info["claimed_tab_ids"].discard(tab_id)
        info["handoff_tab_ids"].discard(tab_id)
        info["deliverable_tab_ids"].discard(tab_id)

    def is_tab_allowed(self, session: str, tab_id: int) -> bool:
        info = self._sessions.get(session)
        if info is None or info.get("closed"):
            return False
        return tab_id in info["tab_ids"] or tab_id in info["claimed_tab_ids"]

    def scope_payload(self, session: str) -> dict[str, Any]:
        info = self._require_session(session)
        allowed = set(info["tab_ids"]) | set(info["claimed_tab_ids"])
        return {
            "session": session,
            "groupId": info.get("group_id"),
            "groupTitle": info.get("group_title"),
            "allowedTabIds": sorted(allowed),
            "claimedTabIds": sorted(info["claimed_tab_ids"]),
            "seedTabId": info.get("seed_tab_id"),
            "seedConsumed": bool(info.get("seed_consumed")),
            "mode": "session",
        }

    def claim_seed_tab_for_navigation(self, session: str) -> Optional[int]:
        info = self._require_session(session)
        seed_tab_id = info.get("seed_tab_id")
        if info.get("seed_consumed") or seed_tab_id is None:
            return None
        info["seed_consumed"] = True
        info["agent_created_tab_ids"].add(seed_tab_id)
        info["tab_ids"].add(seed_tab_id)
        return seed_tab_id

    async def finalize_session(
        self,
        session: str,
        keep: list[dict[str, Any]],
        ws_manager,
    ) -> dict[str, Any]:
        """结束 session：关闭未保留的 agent tabs，释放 claimed/user tabs。"""
        info = self._require_session(session)
        keep_by_id = {
            item["tabId"]: item.get("status", "handoff")
            for item in keep
            if item.get("tabId") is not None
        }
        closed_tab_ids = []
        released_tab_ids = []

        for tab_id in sorted(info["agent_created_tab_ids"]):
            status = keep_by_id.get(tab_id)
            if status in ("handoff", "deliverable"):
                info[f"{status}_tab_ids"].add(tab_id)
                released_tab_ids.append(tab_id)
                continue
            await ws_manager.send_command("tab_manage", {"action": "close", "tabId": tab_id})
            closed_tab_ids.append(tab_id)

        for tab_id in sorted(info["claimed_tab_ids"]):
            released_tab_ids.append(tab_id)

        info["closed"] = True
        self.clear_active(session)
        return {
            "ok": True,
            "session": session,
            "closedTabIds": closed_tab_ids,
            "releasedTabIds": sorted(set(released_tab_ids)),
        }

    def list_sessions(self) -> list[dict[str, Any]]:
        """列出所有活跃 session。"""
        return [
            {
                "session": name,
                "groupTitle": info["group_title"],
                "tabCount": len(info["tab_ids"]),
                "groupId": info.get("group_id"),
                "closed": info.get("closed", False),
            }
            for name, info in self._sessions.items()
            if not info.get("closed")
        ]

    async def auto_add_tab(self, tab_id: int, ws_manager) -> Optional[str]:
        """如果有活跃 session，自动将 tab 加入。返回 session 名或 None。"""
        if self._active_session and self._active_session in self._sessions:
            await self.add_tab_to_session(self._active_session, tab_id, ws_manager)
            return self._active_session
        return None

    def get_session_info(self, session: str) -> Optional[dict[str, Any]]:
        """获取单个 session 的信息。"""
        return self._sessions.get(session)
