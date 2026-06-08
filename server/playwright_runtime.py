# -*- coding: utf-8 -*-
"""
Link2Chrome Playwright Runtime

为 playwright_run 工具提供 Python 端编排：
- 将用户代码发送到 Extension 的 playwright_batch 命令
- 处理超时和错误
- 截断过大的返回结果
"""

from __future__ import annotations

import asyncio
import json
from typing import Any


class PlaywrightRuntime:
    """Python 侧 Playwright 运行时编排器。

    采用 Extension-side page shim 架构：
    - Server 收到 playwright_run(code=...) 后，把 code 原样发送给 Extension
    - Extension 在 cmdPlaywrightBatch 中构建 page 对象并执行用户代码
    - Server 只负责超时控制、结果截断和错误包装
    """

    DEFAULT_TIMEOUT = 30000
    DEFAULT_MAX_RESULT_CHARS = 20000

    async def run(
        self,
        code: str,
        ws_manager,
        timeout: int = DEFAULT_TIMEOUT,
        max_result_chars: int = DEFAULT_MAX_RESULT_CHARS,
    ) -> dict[str, Any]:
        """发送 playwright_batch 命令到 Extension 并返回处理后的结果。

        Args:
            code: 用户编写的 Playwright 风格 JS 代码。
            ws_manager: HubClient 实例，用于发送命令到 Extension。
            timeout: 最大执行时间（毫秒）。
            max_result_chars: 返回结果的最大字符数，超过则截断。

        Returns:
            {"ok": True, "result": ...} 或 {"ok": False, "error": ...}
        """
        if not code or not isinstance(code, str):
            return {"ok": False, "error": "code must be a non-empty string"}

        try:
            result = await asyncio.wait_for(
                ws_manager.send_command("playwright_batch", {"code": code, "timeout": timeout}),
                timeout=timeout / 1000.0 + 5.0,  # 给通信留一点余量
            )
        except asyncio.TimeoutError:
            return {"ok": False, "error": f"playwright_run timed out after {timeout}ms"}
        except Exception as e:
            return {"ok": False, "error": f"playwright_run failed: {e}"}

        # Extension 返回的 payload 在 result 字段下
        if isinstance(result, dict):
            payload = result
        else:
            return {"ok": False, "error": f"unexpected response type: {type(result).__name__}"}

        if not payload.get("ok"):
            return {
                "ok": False,
                "error": payload.get("error") or payload.get("message") or "unknown error from extension",
            }

        raw_result = payload.get("result")
        truncated = False

        # 对结果进行截断处理
        serialized = self._serialize_result(raw_result)
        if len(serialized) > max_result_chars:
            serialized = serialized[:max_result_chars] + "\n...[truncated]"
            truncated = True

        return {
            "ok": True,
            "result": serialized if truncated else raw_result,
            "truncated": truncated,
            "charCount": len(serialized),
        }

    @staticmethod
    def _serialize_result(value: Any) -> str:
        """把任意结果序列化为字符串，用于长度判断。"""
        if isinstance(value, str):
            return value
        try:
            return json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            return str(value)


# 全局单例
playwright_runtime = PlaywrightRuntime()
