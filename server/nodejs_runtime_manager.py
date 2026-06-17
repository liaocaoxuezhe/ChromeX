# -*- coding: utf-8 -*-
"""
Node.js Playwright Runtime Manager

负责管理 Node.js 子进程的完整生命周期和 IPC 通信：
- 检测 Node.js 和入口文件可用性
- 启动/停止 Node.js 子进程
- 通过 stdio (每行 JSON) 进行请求/响应式 IPC
- 支持并发请求（req_id + Future 映射）
- stderr 捕获和日志记录

架构：
    Python MCP Server  →  Node.js 子进程 (stdio IPC)
                              ↓
                         link2chrome-client.mjs  →  WebSocket → Browser Hub
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import uuid
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class NodeJSRuntimeManager:
    """管理 Node.js Playwright Runtime 子进程。

    通过 stdio 与 Node.js 子进程进行 JSON Lines 通信：
    - 发送: {"id": "<uuid>", "type": "execute", "code": "...", "timeout": 30000}
    - 接收: {"type": "ready"} 或 {"id": "<uuid>", "ok": true, "result": ...}
    """

    READY_TIMEOUT = 10.0  # 等待子进程 ready 信号的最大秒数
    STOP_GRACE_PERIOD = 5.0  # 发送 shutdown 后等待的秒数
    EXECUTE_BUFFER = 5.0  # execute 超时之外的缓冲秒数

    def __init__(self, project_root: str) -> None:
        """初始化 Runtime Manager。

        Args:
            project_root: 项目根目录绝对路径，用于定位 runtime 入口文件。
        """
        self.project_root = project_root
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._pending: Dict[str, asyncio.Future] = {}
        self._ready = False
        self.startup_error: Optional[str] = None
        self._read_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._shutdown_future: Optional[asyncio.Future] = None

    # ------------------------------------------------------------------ #
    # 生命周期管理
    # ------------------------------------------------------------------ #

    async def start(self) -> bool:
        """启动 Node.js 子进程并等待 ready 信号。

        Returns:
            True 如果子进程成功启动并发出 ready 信号；
            False 如果 Node.js 未安装、入口文件缺失或启动超时。
        """
        self.startup_error = None

        # 1. 检测 Node.js 可用性
        node_path = shutil.which("node")
        if not node_path:
            self.startup_error = (
                "未检测到 Node.js 运行时。"
                "请先安装 Node.js (>=18) 并确保 `node` 命令在 PATH 中。"
            )
            logger.error(self.startup_error)
            return False

        # 2. 检测入口文件
        runtime_entry = os.path.join(
            self.project_root, "runtime", "nodejs-playwright-runtime.mjs"
        )
        if not os.path.isfile(runtime_entry):
            self.startup_error = (
                f"Node.js Runtime 入口文件不存在: {runtime_entry}\n"
                f"请确保 runtime/nodejs-playwright-runtime.mjs 已正确放置。"
            )
            logger.error(self.startup_error)
            return False

        # 3. 启动子进程
        try:
            self._proc = await asyncio.create_subprocess_exec(
                node_path,
                runtime_entry,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.project_root,
            )
        except Exception as exc:
            self.startup_error = f"启动 Node.js 子进程失败: {exc}"
            logger.exception(self.startup_error)
            return False

        logger.info(f"Node.js 子进程已启动 (PID={self._proc.pid})")

        # 4. 启动后台读取循环
        self._read_task = asyncio.create_task(
            self._read_loop(), name="nodejs-read-loop"
        )
        self._stderr_task = asyncio.create_task(
            self._stderr_loop(), name="nodejs-stderr-loop"
        )

        # 5. 等待 ready 信号（通过 _read_loop 解析 stdout 触发）
        ready_future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._shutdown_future = ready_future

        try:
            await asyncio.wait_for(ready_future, timeout=self.READY_TIMEOUT)
        except asyncio.TimeoutError:
            self.startup_error = (
                f"Node.js 子进程在 {self.READY_TIMEOUT}s 内未发送 ready 信号，"
                f"可能启动失败或入口文件异常。"
            )
            logger.error(self.startup_error)
            await self.stop()
            return False
        except Exception as exc:
            self.startup_error = f"等待 Node.js ready 时发生异常: {exc}"
            logger.exception(self.startup_error)
            await self.stop()
            return False

        self._ready = True
        self.startup_error = None
        logger.info("Node.js Playwright Runtime 已就绪")
        return True

    async def stop(self) -> None:
        """优雅停止 Node.js 子进程。

        流程：
        1. 发送 shutdown 命令到子进程 stdin
        2. 等待 STOP_GRACE_PERIOD 秒让子进程自行退出
        3. 若仍在运行则强制 kill
        4. 取消并清理后台 Task
        """
        if self._proc is None:
            self._ready = False
            return

        # 1. 尝试发送 shutdown
        if self._proc.stdin is not None and not self._proc.stdin.is_closing():
            try:
                shutdown_msg = json.dumps({"type": "shutdown"}) + "\n"
                self._proc.stdin.write(shutdown_msg.encode("utf-8"))
                await self._proc.stdin.drain()
                logger.debug("已向 Node.js 子进程发送 shutdown 命令")
            except Exception as exc:
                logger.warning(f"发送 shutdown 命令失败: {exc}")

        # 2. 等待子进程自行退出
        try:
            await asyncio.wait_for(self._proc.wait(), timeout=self.STOP_GRACE_PERIOD)
        except asyncio.TimeoutError:
            # 3. 强制终止
            logger.warning(
                f"Node.js 子进程 (PID={self._proc.pid}) 未在 "
                f"{self.STOP_GRACE_PERIOD}s 内退出，执行强制 kill"
            )
            self._proc.kill()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                logger.error(f"Node.js 子进程 (PID={self._proc.pid}) 强制终止超时")

        # 4. 取消后台 Task
        for task in (self._read_task, self._stderr_task):
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        # 清理待处理请求
        for req_id, future in list(self._pending.items()):
            if not future.done():
                future.set_exception(
                    RuntimeError("Node.js 子进程已停止，请求被取消")
                )
        self._pending.clear()

        self._proc = None
        self._read_task = None
        self._stderr_task = None
        self._ready = False
        logger.info("Node.js Playwright Runtime 已停止")

    async def restart(self) -> bool:
        """重启 Node.js 子进程。

        先调用 stop() 再调用 start()，用于崩溃恢复或配置热重载。

        Returns:
            start() 的返回值。
        """
        await self.stop()
        return await self.start()

    @property
    def is_ready(self) -> bool:
        """返回当前子进程是否已就绪。"""
        return self._ready and self._proc is not None and self._proc.returncode is None

    # ------------------------------------------------------------------ #
    # 请求执行
    # ------------------------------------------------------------------ #

    async def execute(
        self,
        code: str,
        timeout: int = 30000,
        *,
        lease_token: str | None = None,
        restart_on_closed_stdout: bool = True,
    ) -> dict[str, Any]:
        """向 Node.js 子进程发送 Playwright 代码并等待执行结果。

        Args:
            code: 需要执行的 Playwright JavaScript 代码字符串。
            timeout: 代码执行的最大超时（毫秒）。
            lease_token: Hub 操作锁 token，传递给 Node.js 运行时以避免死锁。

        Returns:
            {"ok": True, "result": ...} 或
            {"ok": False, "error": "...", "stack": "..."}
        """
        if not self.is_ready:
            return {
                "ok": False,
                "error": "Node.js Playwright Runtime 未就绪，" "请先调用 start() 或检查启动错误。",
            }

        if self._proc is None or self._proc.stdin is None:
            return {
                "ok": False,
                "error": "Node.js 子进程 stdin 不可用",
            }

        req_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[req_id] = future

        message = {
            "id": req_id,
            "type": "execute",
            "code": code,
            "timeout": timeout,
        }
        if lease_token:
            message["lease_token"] = lease_token

        try:
            data = json.dumps(message, ensure_ascii=False) + "\n"
            self._proc.stdin.write(data.encode("utf-8"))
            await self._proc.stdin.drain()
            logger.debug(f"已发送执行请求 (req_id={req_id})")
        except Exception as exc:
            self._pending.pop(req_id, None)
            return {
                "ok": False,
                "error": f"向 Node.js 子进程发送请求失败: {exc}",
            }

        # 等待响应，总等待时间 = timeout + buffer（转换为秒）
        total_timeout = timeout / 1000.0 + self.EXECUTE_BUFFER
        try:
            result = await asyncio.wait_for(future, timeout=total_timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            return {
                "ok": False,
                "error": (
                    f"请求超时（总等待时间 {total_timeout}s，"
                    f"代码执行限制 {timeout}ms）"
                ),
            }
        except Exception as exc:
            self._pending.pop(req_id, None)
            if (
                restart_on_closed_stdout
                and self._is_closed_stdout_error(exc)
                and await self.restart()
            ):
                return await self.execute(
                    code,
                    timeout,
                    lease_token=lease_token,
                    restart_on_closed_stdout=False,
                )
            return {
                "ok": False,
                "error": f"等待响应时发生异常: {exc}",
            }

        return result

    @staticmethod
    def _is_closed_stdout_error(exc: BaseException) -> bool:
        """判断异常是否来自 Node.js stdout 关闭。"""
        text = str(exc)
        return "stdout 已关闭" in text or "stdout closed" in text.lower()

    # ------------------------------------------------------------------ #
    # 内部循环
    # ------------------------------------------------------------------ #

    async def _read_loop(self) -> None:
        """持续读取子进程 stdout，解析 JSON 并分发。"""
        if self._proc is None or self._proc.stdout is None:
            return

        try:
            while True:
                line = await self._proc.stdout.readline()
                if not line:
                    logger.debug("Node.js stdout 已关闭，读取循环结束")
                    break

                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue

                try:
                    msg = json.loads(text)
                except json.JSONDecodeError as exc:
                    logger.warning(
                        f"无法解析 Node.js stdout 输出为 JSON: {exc} (raw: {text[:200]})"
                    )
                    continue

                await self._dispatch_message(msg)
        except asyncio.CancelledError:
            logger.debug("Node.js stdout 读取循环被取消")
            raise
        except Exception as exc:
            logger.exception(f"Node.js stdout 读取循环异常: {exc}")
        finally:
            # 子进程 stdout 关闭时，清理所有待处理请求
            for req_id, future in list(self._pending.items()):
                if not future.done():
                    future.set_exception(
                        RuntimeError("Node.js 子进程 stdout 已关闭")
                    )
            self._pending.clear()
            self._ready = False

    async def _dispatch_message(self, msg: dict[str, Any]) -> None:
        """根据消息类型分发到对应处理器。"""
        msg_type = msg.get("type")

        # ready 信号
        if msg_type == "ready":
            self._ready = True
            if self._shutdown_future is not None and not self._shutdown_future.done():
                self._shutdown_future.set_result(True)
            logger.info("收到 Node.js 子进程 ready 信号")
            return

        # log 类型：透传到 Python logger
        if msg_type == "log":
            level = msg.get("level", "info")
            text = msg.get("message", "")
            if level == "error":
                logger.error(f"[Node.js] {text}")
            elif level == "warn":
                logger.warning(f"[Node.js] {text}")
            else:
                logger.info(f"[Node.js] {text}")
            return

        # 有 id 的响应消息
        req_id = msg.get("id")
        if req_id is not None:
            future = self._pending.pop(req_id, None)
            if future is not None and not future.done():
                # 包装为统一格式
                if msg.get("ok"):
                    future.set_result({
                        "ok": True,
                        "result": msg.get("result"),
                        "meta": msg.get("meta"),
                    })
                else:
                    future.set_result({
                        "ok": False,
                        "error": msg.get("error", "未知错误"),
                        "errorType": msg.get("errorType"),
                        "hint": msg.get("hint"),
                        "stack": msg.get("stack"),
                        "meta": msg.get("meta"),
                    })
            else:
                logger.warning(f"收到未知或已过期请求的响应 (req_id={req_id})")
            return

        # 无法识别的消息
        logger.debug(f"收到未识别的 Node.js 消息: {msg}")

    async def _stderr_loop(self) -> None:
        """持续读取子进程 stderr，记录到 Python logger（WARNING 级别）。"""
        if self._proc is None or self._proc.stderr is None:
            return

        try:
            while True:
                line = await self._proc.stderr.readline()
                if not line:
                    logger.debug("Node.js stderr 已关闭")
                    break

                text = line.decode("utf-8", errors="replace").rstrip("\n")
                if text:
                    logger.warning(f"[Node.js stderr] {text}")
        except asyncio.CancelledError:
            logger.debug("Node.js stderr 读取循环被取消")
            raise
        except Exception as exc:
            logger.exception(f"Node.js stderr 读取循环异常: {exc}")
