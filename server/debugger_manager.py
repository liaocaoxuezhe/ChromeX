"""
Debugger 生命周期管理器
解决 "Another debugger is already attached" 问题
"""

import asyncio
from typing import Optional

from server.logger import get_logger

logger = get_logger("debugger")


class DebuggerManager:
    """管理 Chrome Debugger 的 attach/detach 生命周期"""

    def __init__(self, ws_manager=None):
        self.ws_manager = ws_manager
        self.attached_tab_id: Optional[int] = None
        self.detach_delay_ms: int = 300  # detach 后的延迟时间(毫秒)
        self._lock = asyncio.Lock()

    async def ensure_clean_attach(self, target_tab_id: Optional[int] = None) -> int:
        """
        确保干净的 debugger attach 状态。
        如果已经 attach 到其他 tab,先 detach 并等待延迟,再 attach 到新 tab。

        Args:
            target_tab_id: 目标 tab ID,如果为 None 则使用当前 attached tab

        Returns:
            attached 的 tab ID
        """
        async with self._lock:
            # 如果没有指定目标且已经有 attach 的 tab,直接返回
            if target_tab_id is None and self.attached_tab_id is not None:
                logger.debug(f"已 attach 到 tab {self.attached_tab_id}")
                return self.attached_tab_id

            # 如果需要切换到新 tab 或当前没有 attach
            if target_tab_id is not None and target_tab_id != self.attached_tab_id:
                # 先 detach 旧的
                if self.attached_tab_id is not None:
                    await self._detach_with_delay(self.attached_tab_id)

                # attach 到新 tab
                self.attached_tab_id = target_tab_id
                logger.info(f"切换 debugger 到 tab {target_tab_id}")
                return target_tab_id

            return self.attached_tab_id

    async def detach_debugger(self, tab_id: Optional[int] = None) -> bool:
        """
        主动 detach debugger

        Args:
            tab_id: 要 detach 的 tab ID,如果为 None 则使用当前 attached tab

        Returns:
            是否成功 detach
        """
        async with self._lock:
            target_id = tab_id if tab_id is not None else self.attached_tab_id

            if target_id is None:
                logger.warning("没有 attached tab,无需 detach")
                return False

            success = await self._detach_with_delay(target_id)

            if success and target_id == self.attached_tab_id:
                self.attached_tab_id = None

            return success

    async def _detach_with_delay(self, tab_id: int) -> bool:
        """
        执行 detach 操作并等待延迟

        Args:
            tab_id: 要 detach 的 tab ID

        Returns:
            是否成功 detach
        """
        if self.ws_manager is None:
            logger.error("ws_manager 未设置,无法 detach")
            return False

        try:
            # 发送 detach 命令
            result = await self.ws_manager.send_command(
                "detach_debugger",
                {"tab_id": tab_id}
            )

            success = result.get("success", False)
            if success:
                logger.info(f"已 detach debugger from tab {tab_id}")
                # 等待延迟,确保浏览器完成清理
                await asyncio.sleep(self.detach_delay_ms / 1000.0)
                return True
            else:
                logger.warning(f"Detach 失败: {result.get('error', 'unknown')}")
                return False

        except Exception as e:
            logger.error(f"Detach 异常: {e}")
            return False

    def track_attached_tab(self, tab_id: Optional[int]):
        """
        更新当前 attached 的 tab ID

        Args:
            tab_id: 新的 attached tab ID,None 表示没有 attach
        """
        self.attached_tab_id = tab_id
        if tab_id is not None:
            logger.debug(f"追踪 attached tab: {tab_id}")

    def get_attached_tab(self) -> Optional[int]:
        """获取当前 attached 的 tab ID"""
        return self.attached_tab_id
