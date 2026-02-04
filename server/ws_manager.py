"""
WebSocket Server + 连接管理 + 心跳
管理与 Chrome Extension 的单一活跃连接
"""

import asyncio
import json
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


class WSManager:
    """WebSocket 服务端管理器，维护与 Chrome Extension 的单一连接"""

    def __init__(self, host: str = "localhost", port: int = 8765):
        self.host = host
        self.port = port
        self._connection: Optional[ServerConnection] = None
        self._pending_requests: dict[str, asyncio.Future] = {}
        self._server = None
        self._connected_event = asyncio.Event()

    @property
    def is_connected(self) -> bool:
        return self._connection is not None

    async def start(self):
        """启动 WebSocket 服务器（非阻塞，在后台运行）"""
        self._server = await websockets.serve(
            self._handle_connection,
            self.host,
            self.port,
            ping_interval=30,
            ping_timeout=HEARTBEAT_TIMEOUT,
        )
        logger.info(f"WebSocket Server 已启动: ws://{self.host}:{self.port}")
        op_logger.log_connection_event("SERVER_START", f"ws://{self.host}:{self.port}")

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
            await asyncio.wait_for(self._connected_event.wait(), timeout=timeout)
            return True
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
        if not self._connection:
            raise ConnectionError("Chrome Extension 未连接。请确保扩展已加载并启用。")

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
        finally:
            self._pending_requests.pop(request_id, None)

    async def _handle_connection(self, websocket: ServerConnection):
        """处理新的 WebSocket 连接"""
        # 只保留一个活跃连接
        if self._connection is not None:
            logger.warning("新连接到来，断开旧连接")
            op_logger.log_connection_event("CONNECTION_REPLACE", f"旧连接: {self._connection.remote_address}")
            try:
                await self._connection.close()
            except Exception:
                pass

        self._connection = websocket
        self._connected_event.set()
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
