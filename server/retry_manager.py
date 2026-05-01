"""
重试和降级策略管理器
处理 Vision API 超时、网络错误等情况
"""

import asyncio
import functools
import os
from typing import Any, Callable, Optional

from server.logger import get_logger

logger = get_logger("retry")


class VisionTimeoutError(Exception):
    """Vision API 超时异常"""
    def __init__(self, instruction: str):
        self.instruction = instruction
        super().__init__(f"Vision API 超时: {instruction}")


class RetryManager:
    """重试管理器"""

    def __init__(
        self,
        max_retries: int = 3,
        base_delay: float = 1.0,
        exponential_backoff: bool = True
    ):
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.exponential_backoff = exponential_backoff

    async def with_retry(
        self,
        func: Callable,
        *args,
        retry_on: tuple = (ConnectionError, TimeoutError),
        **kwargs
    ) -> Any:
        """
        使用指数退避重试执行函数

        Args:
            func: 要执行的异步函数
            *args: 函数参数
            retry_on: 需要重试的异常类型
            **kwargs: 函数关键字参数

        Returns:
            函数执行结果

        Raises:
            最后一次重试的异常
        """
        last_exception = None

        for attempt in range(self.max_retries):
            try:
                return await func(*args, **kwargs)
            except retry_on as e:
                last_exception = e
                if attempt < self.max_retries - 1:
                    delay = self._calculate_delay(attempt)
                    logger.warning(
                        f"第 {attempt + 1}/{self.max_retries} 次尝试失败: {e}, "
                        f"{delay}秒后重试"
                    )
                    await asyncio.sleep(delay)
                else:
                    logger.error(
                        f"所有 {self.max_retries} 次重试均失败: {e}"
                    )

        raise last_exception

    def _calculate_delay(self, attempt: int) -> float:
        """计算重试延迟"""
        if self.exponential_backoff:
            return self.base_delay * (2 ** attempt)
        return self.base_delay


class VisionFallbackHandler:
    """Vision API 降级处理器"""

    def __init__(self, ws_manager):
        self.ws_manager = ws_manager
        # CSS 选择器推断映射表
        self.selector_inference_map = {
            # 搜索相关
            "搜索框": ["input[type='search']", "input[placeholder*='搜索']", ".search-input", "#search"],
            "搜索按钮": ["button[type='submit']", ".search-btn", "button:has-text('搜索')"],

            # 登录相关
            "用户名": ["input[name='username']", "input[type='email']", "#username", "#email"],
            "密码": ["input[type='password']", "#password"],
            "登录按钮": ["button[type='submit']", "button:has-text('登录')"],

            # 常见操作
            "确定": ["button:has-text('确定')", "button:has-text('确认')", ".confirm-btn"],
            "取消": ["button:has-text('取消')", ".cancel-btn"],
            "关闭": ["button:has-text('关闭')", ".close", ".modal-close"],

            # 小红书特定
            "笔记卡片": [".note-item", "[class*='note-item']", "[class*='feed-card']"],
            "点赞按钮": ["[class*='like']", ".interaction-like"],
        }

        # 是否启用降级(从环境变量读取)
        self.fallback_enabled = os.getenv("VISION_FALLBACK_ENABLED", "true").lower() == "true"

    async def handle_vision_timeout(
        self,
        instruction: str,
        error: Exception
    ) -> dict:
        """
        处理 Vision API 超时,尝试降级策略

        Args:
            instruction: 原始指令
            error: 超时异常

        Returns:
            降级操作结果
        """
        if not self.fallback_enabled:
            logger.info("Vision 降级已禁用,直接抛出异常")
            raise error

        logger.warning(f"Vision API 超时,尝试降级策略: {instruction}")

        # 尝试推断 CSS 选择器
        selector = self._infer_selector(instruction)

        if selector:
            logger.info(f"推断出选择器: {selector}")
            try:
                # 使用 browser_click 降级
                result = await self.ws_manager.send_command(
                    "click",
                    {"selector": selector}
                )
                logger.info(f"降级操作成功: {result}")
                return {
                    "success": True,
                    "fallback_used": True,
                    "method": "css_selector",
                    "selector": selector,
                    "result": result
                }
            except Exception as e:
                logger.error(f"降级操作失败: {e}")
                raise VisionTimeoutError(instruction) from e
        else:
            logger.error(f"无法推断选择器: {instruction}")
            raise VisionTimeoutError(instruction) from error

    def _infer_selector(self, instruction: str) -> Optional[str]:
        """
        从指令中推断 CSS 选择器

        Args:
            instruction: 用户指令

        Returns:
            推断出的 CSS 选择器,如果无法推断则返回 None
        """
        # 简单关键词匹配
        instruction_lower = instruction.lower()

        for keyword, selectors in self.selector_inference_map.items():
            if keyword in instruction_lower or keyword in instruction:
                # 返回第一个推断的选择器
                logger.debug(f"匹配关键词: {keyword} -> 选择器: {selectors[0]}")
                return selectors[0]

        # 尝试从指令中提取引号内的文本作为按钮文本
        import re
        quoted_text = re.findall(r'["\']([^"\']+)["\']', instruction)
        if quoted_text:
            text = quoted_text[0]
            logger.debug(f"提取文本: {text}")
            return f"button:has-text('{text}')"

        # 尝试提取"点击XXX"模式
        click_match = re.search(r'点击(.+?)(?:按钮|链接|元素|$)', instruction)
        if click_match:
            target = click_match.group(1).strip()
            logger.debug(f"提取点击目标: {target}")
            return f"button:has-text('{target}'), a:has-text('{target}')"

        return None

    def add_selector_mapping(self, keyword: str, selectors: list):
        """
        添加新的选择器推断映射

        Args:
            keyword: 关键词
            selectors: CSS 选择器列表
        """
        self.selector_inference_map[keyword] = selectors
        logger.info(f"添加选择器映射: {keyword} -> {selectors}")


# 装饰器:用于自动重试
def with_retry(
    max_retries: int = 3,
    retry_on: tuple = (ConnectionError, TimeoutError),
    base_delay: float = 1.0
):
    """
    装饰器:自动重试异步函数

    Args:
        max_retries: 最大重试次数
        retry_on: 需要重试的异常类型
        base_delay: 基础延迟(秒)
    """
    def decorator(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            retry_manager = RetryManager(
                max_retries=max_retries,
                base_delay=base_delay
            )
            return await retry_manager.with_retry(
                func, *args, retry_on=retry_on, **kwargs
            )
        return wrapper
    return decorator
