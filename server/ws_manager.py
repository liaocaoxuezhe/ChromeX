"""
WebSocket Server + 连接管理 + 心跳
管理与 Chrome Extension 的单一活跃连接
"""

from __future__ import annotations

import asyncio
import json
import socket
import uuid
from typing import Any, Optional

import websockets
from websockets.asyncio.server import ServerConnection

from server.logger import get_logger, get_operation_logger

logger = get_logger("ws")
op_logger = get_operation_logger()

# 连接超时时间(秒)，超过该时间未收到心跳则断开
HEARTBEAT_TIMEOUT = 60
# 请求超时时间(秒)
REQUEST_TIMEOUT = 30
# 未连接时等待 Extension 的最长时间(秒)
CONNECTION_WAIT_TIMEOUT = 10
READONLY_RETRY_COMMANDS = {
    "ping_version",
    "get_info",
    "get_all_tabs",
    "extract_content",
    "screenshot",
    "agent_browser_tab_info",
    "dom_overview",
    "dom_query",
    "dom_search",
    "dom_element_detail",
    "network_list",
    "network_query",
    "console_list",
    "console_get",
}


class WSManager:
    """WebSocket 服务端管理器，维护与 Chrome Extension 的单一连接"""

    def __init__(self, host: str = "localhost", port: int = 8765):
        self.host = host
        self.port = port
        self._connection: Optional[ServerConnection] = None
        self._pending_requests: dict[str, asyncio.Future] = {}
        self._server = None
        self._connected_event = asyncio.Event()
        self._startup_error: str | None = None
        self._duplicate_connection_count = 0

    @property
    def is_connected(self) -> bool:
        return self._connection is not None

    @property
    def startup_error(self) -> str | None:
        return self._startup_error

    async def start(self):
        """启动 WebSocket 服务器（非阻塞，在后台运行）"""
        self._startup_error = None

        # 先检查端口是否可用。不要在 MCP 启动时强杀端口占用者：
        # 多个 MCP 宿主可能会同时尝试启动 Link2Chrome，如果互相 kill -9，
        # 会造成启动/重连风暴，让 CPU 和风扇压力飙升。
        if self._is_port_in_use(self.host, self.port):
            owner = self._describe_process_on_port(self.port)
            self._startup_error = (
                f"无法监听 ws://{self.host}:{self.port}: 端口已被占用。"
                f"{owner}请只保留一个 Link2Chrome MCP 实例，或先停止占用该端口的进程。"
            )
            logger.error(self._startup_error)
            op_logger.log_connection_event("SERVER_START_FAILED", self._startup_error)
            return

        try:
            self._server = await websockets.serve(
                self._handle_connection,
                self.host,
                self.port,
                ping_interval=30,
                ping_timeout=HEARTBEAT_TIMEOUT,
            )
            logger.info(f"WebSocket Server 已启动: ws://{self.host}:{self.port}")
            op_logger.log_connection_event("SERVER_START", f"ws://{self.host}:{self.port}")
        except OSError as e:
            self._server = None
            self._startup_error = (
                f"无法监听 ws://{self.host}:{self.port}: {e}. "
                "当前运行环境可能禁止本地端口监听，请在非沙箱环境运行 Link2Chrome MCP。"
            )
            logger.error(self._startup_error)
            op_logger.log_connection_event("SERVER_START_FAILED", self._startup_error)

    def _is_port_in_use(self, host: str, port: int) -> bool:
        """检查端口是否被占用"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind((host, port))
            return False
        except OSError:
            return True

    def _describe_process_on_port(self, port: int) -> str:
        """返回占用指定端口的进程摘要，用于诊断。"""
        try:
            import subprocess
            result = subprocess.run(
                ["lsof", "-nP", "-iTCP", f":{port}", "-sTCP:LISTEN"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                lines = result.stdout.strip().splitlines()
                if len(lines) > 1:
                    return f"占用进程: {lines[1]}. "
        except Exception as e:
            logger.warning(f"检查端口占用失败: {e}")
        return ""

    async def stop(self):
        """关闭 WebSocket 服务器"""
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            logger.info("WebSocket Server 已关闭")
            op_logger.log_connection_event("SERVER_STOP")

    async def wait_for_connection(self, timeout: float = 10.0) -> bool:
        """等待 Extension 连接"""
        try:
            # 分段等待，每 5 秒输出一次进度
            remaining = timeout
            while remaining > 0 and not self._connection:
                wait_time = min(5.0, remaining)
                try:
                    await asyncio.wait_for(self._connected_event.wait(), timeout=wait_time)
                    return True
                except asyncio.TimeoutError:
                    remaining -= wait_time
                    if remaining > 0:
                        logger.info(f"仍在等待 Chrome Extension 连接... 剩余 {int(remaining)} 秒")
            return False
        except asyncio.TimeoutError:
            return False

    async def send_command(self, command: str, params: dict = None) -> dict[str, Any]:
        """
        向 Chrome Extension 发送指令并等待响应。

        Args:
            command: 指令名称 (screenshot, click, type, scroll, navigate, get_dom, get_info, tab_manage)
            params: 指令参数

        Returns:
            Extension 返回的响应数据

        Raises:
            ConnectionError: 未连接到 Extension
            TimeoutError: 等待响应超时
        """
        retry_on_disconnect = command in READONLY_RETRY_COMMANDS
        attempts = 2 if retry_on_disconnect else 1
        last_error: Exception | None = None

        for attempt in range(attempts):
            try:
                return await self._send_command_once(command, params)
            except ConnectionError as exc:
                last_error = exc
                if not retry_on_disconnect or attempt + 1 >= attempts:
                    raise
                logger.warning(f"只读指令 {command} 遇到连接切换，等待 Extension 重连后重试一次")
                connected = await self.wait_for_connection(timeout=CONNECTION_WAIT_TIMEOUT)
                if not connected:
                    raise

        if last_error:
            raise last_error
        raise ConnectionError("Chrome Extension 未连接。请确保扩展已加载并启用。")

    async def _send_command_once(self, command: str, params: dict = None) -> dict[str, Any]:
        # 如果未连接，自动等待 Extension 连接（最多等待 10 秒）
        if not self._connection:
            if self._startup_error:
                raise ConnectionError(self._startup_error)
            logger.info("等待 Chrome Extension 连接...")
            connected = await self.wait_for_connection(timeout=CONNECTION_WAIT_TIMEOUT)
            if not connected:
                raise ConnectionError("Chrome Extension 未连接。请确保扩展已加载并启用。")
            logger.info("Chrome Extension 已连接，继续执行指令")

        request_id = str(uuid.uuid4())[:8]
        message = {
            "request_id": request_id,
            "command": command,
            "params": params or {},
        }

        # 创建 Future 用于等待响应
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending_requests[request_id] = future

        try:
            await self._connection.send(json.dumps(message))
            logger.debug(f"已发送指令: {command} (id={request_id})")

            # 等待响应
            result = await asyncio.wait_for(future, timeout=REQUEST_TIMEOUT)

            if not result.get("success"):
                raise RuntimeError(
                    f"Extension 执行失败: {result.get('error', '未知错误')}"
                )

            return result.get("data", {})

        except asyncio.TimeoutError:
            raise TimeoutError(
                f"等待 Extension 响应超时 ({REQUEST_TIMEOUT}s): {command}"
            )
        except websockets.exceptions.ConnectionClosed as exc:
            if self._connection is not None and getattr(self._connection, "closed", False):
                self._connection = None
                self._connected_event.clear()
            raise ConnectionError("Extension 连接已断开") from exc
        finally:
            self._pending_requests.pop(request_id, None)

    async def _handle_connection(self, websocket: ServerConnection):
        """处理新的 WebSocket 连接"""
        # 只保留一个活跃连接。多个 Chrome profile / 旧扩展实例同时连接时，
        # 如果新连接踢旧连接，会触发双方立即重连并形成连接风暴。
        if self._connection is not None:
            self._duplicate_connection_count += 1
            if self._duplicate_connection_count <= 3 or self._duplicate_connection_count % 50 == 0:
                logger.warning(
                    f"拒绝重复 Extension 连接: {websocket.remote_address}; "
                    f"当前连接: {self._connection.remote_address}; "
                    f"重复次数: {self._duplicate_connection_count}"
                )
            op_logger.log_connection_event("CONNECTION_DUPLICATE", f"重复连接: {websocket.remote_address}")
            try:
                await websocket.close(code=1008, reason="duplicate Link2Chrome extension connection")
            except Exception:
                pass
            return

        self._connection = websocket
        self._connected_event.set()
        self._duplicate_connection_count = 0
        client_addr = websocket.remote_address
        logger.info(f"Chrome Extension 已连接: {client_addr}")
        op_logger.log_connection_event("CONNECT", f"地址: {client_addr}")

        try:
            async for raw_message in websocket:
                try:
                    message = json.loads(raw_message)
                except json.JSONDecodeError:
                    logger.warning(f"收到无效 JSON: {raw_message[:100]}")
                    continue

                # 处理心跳
                if message.get("type") == "ping":
                    await websocket.send(json.dumps({"type": "pong"}))
                    continue

                # 匹配请求响应
                request_id = message.get("request_id")
                if request_id and request_id in self._pending_requests:
                    future = self._pending_requests[request_id]
                    if not future.done():
                        future.set_result(message)
                else:
                    logger.debug(f"收到未匹配的消息: {str(message)[:200]}")

        except websockets.exceptions.ConnectionClosed as e:
            logger.info(f"Extension 连接已关闭: {e}")
            op_logger.log_connection_event("DISCONNECT", f"原因: {e}")
        except Exception as e:
            logger.error(f"连接处理异常: {e}")
            op_logger.log_connection_event("ERROR", f"异常: {e}")
        finally:
            if self._connection == websocket:
                self._connection = None
                self._connected_event.clear()
                # 取消所有待处理的请求
                pending_count = len(self._pending_requests)
                for rid, future in self._pending_requests.items():
                    if not future.done():
                        future.set_exception(
                            ConnectionError("Extension 连接已断开")
                        )
                self._pending_requests.clear()
                logger.info(f"Extension 连接已清理，取消了 {pending_count} 个待处理请求")
                if pending_count > 0:
                    op_logger.log_connection_event("CLEANUP", f"取消 {pending_count} 个待处理请求")
