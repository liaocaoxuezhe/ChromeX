"""
Singleton Browser Hub.

The hub owns the Chrome Extension WebSocket port and exposes a separate local
control WebSocket for many MCP stdio adapter processes. Browser operations are
serialized through an asyncio lock so multiple agents can connect without
trampling each other's in-flight commands.
"""

import asyncio
import json
import os
import sys
import time
import uuid
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection

from server.logger import setup_logging, get_logger, get_operation_logger
from server.ws_manager import WSManager

_current_file = os.path.abspath(__file__)
_project_root = os.path.dirname(os.path.dirname(_current_file))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

log_level = os.getenv("LOG_LEVEL", "INFO")
console_enabled = os.getenv("LOG_CONSOLE", "false").lower() in ("true", "1", "yes", "on")
setup_logging(log_level=log_level, console_enabled=console_enabled)

logger = get_logger("browser_hub")
op_logger = get_operation_logger()

HUB_HOST = os.getenv("LINK2CHROME_HUB_HOST", "localhost")
HUB_CONTROL_PORT = int(os.getenv("LINK2CHROME_HUB_CONTROL_PORT", "8766"))
LEASE_TIMEOUT = float(os.getenv("LINK2CHROME_HUB_LEASE_TIMEOUT", "300"))


class BrowserHub:
    def __init__(self):
        self.extension_ws = WSManager()
        self._control_server = None
        self._operation_lock = asyncio.Lock()
        self._lease_token: str | None = None
        self._lease_name: str | None = None
        self._lease_started_at: float | None = None
        self._adapter_connections: set[ServerConnection] = set()
        self._hub_id = str(uuid.uuid4())[:8]

    async def start(self):
        await self.extension_ws.start()
        self._control_server = await websockets.serve(
            self._handle_adapter,
            HUB_HOST,
            HUB_CONTROL_PORT,
            ping_interval=30,
            ping_timeout=60,
        )
        logger.info(
            f"Browser Hub 已启动: control=ws://{HUB_HOST}:{HUB_CONTROL_PORT}, "
            f"extension=ws://{self.extension_ws.host}:{self.extension_ws.port}, hub_id={self._hub_id}"
        )
        op_logger.log_connection_event(
            "HUB_START",
            f"control=ws://{HUB_HOST}:{HUB_CONTROL_PORT}, hub_id={self._hub_id}",
        )

    async def run_forever(self):
        await self.start()
        await asyncio.Future()

    async def _handle_adapter(self, websocket: ServerConnection):
        self._adapter_connections.add(websocket)
        logger.debug(f"MCP adapter 已连接: {websocket.remote_address}")
        try:
            async for raw_message in websocket:
                response = await self._handle_adapter_message(raw_message)
                await websocket.send(json.dumps(response, ensure_ascii=False))
        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception as exc:
            logger.exception(f"MCP adapter 连接异常: {exc}")
        finally:
            self._adapter_connections.discard(websocket)

    async def _handle_adapter_message(self, raw_message: str) -> dict[str, Any]:
        request_id = None
        try:
            message = json.loads(raw_message)
            request_id = message.get("request_id")
            command = message["command"]
            params = message.get("params") or {}
            self._release_expired_lease()

            if command == "__hub_status__":
                return self._ok(request_id, self._status())
            if command == "__hub_acquire__":
                await self._operation_lock.acquire()
                self._lease_token = str(uuid.uuid4())
                self._lease_name = params.get("name", "tool_call")
                self._lease_started_at = time.monotonic()
                return self._ok(
                    request_id,
                    {
                        "lease_token": self._lease_token,
                        "lease_name": self._lease_name,
                    },
                )
            if command == "__hub_release__":
                token = params.get("lease_token")
                if token != self._lease_token:
                    raise RuntimeError("Browser Hub 操作锁 token 不匹配")
                self._release_current_lease()
                return self._ok(request_id, {"released": True})

            # One real browser, one visible UI: serialize operations from all
            # adapters. This is deliberately conservative for the first pass.
            if message.get("lease_token") == self._lease_token:
                data = await self.extension_ws.send_command(command, params)
            else:
                async with self._operation_lock:
                    data = await self.extension_ws.send_command(command, params)
            return self._ok(request_id, data)
        except Exception as exc:
            logger.error(f"Hub 请求失败: {exc}")
            return {
                "request_id": request_id,
                "success": False,
                "error": str(exc),
            }

    def _status(self) -> dict[str, Any]:
        return {
            "hub_id": self._hub_id,
            "adapter_connections": len(self._adapter_connections),
            "extension_connected": self.extension_ws.is_connected,
            "extension_startup_error": self.extension_ws.startup_error,
            "queue_locked": self._operation_lock.locked(),
            "lease_name": self._lease_name,
        }

    def _release_current_lease(self):
        self._lease_token = None
        self._lease_name = None
        self._lease_started_at = None
        if self._operation_lock.locked():
            self._operation_lock.release()

    def _release_expired_lease(self):
        if not self._lease_started_at:
            return
        if time.monotonic() - self._lease_started_at <= LEASE_TIMEOUT:
            return
        logger.warning(f"Browser Hub 操作锁超时释放: {self._lease_name}")
        self._release_current_lease()

    @staticmethod
    def _ok(request_id: str | None, data: dict[str, Any]) -> dict[str, Any]:
        return {
            "request_id": request_id,
            "success": True,
            "data": data,
        }


def main():
    asyncio.run(BrowserHub().run_forever())


if __name__ == "__main__":
    main()
