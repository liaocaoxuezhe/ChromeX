"""
Client used by MCP stdio adapters to talk to the shared Browser Hub.

Each agent may start its own MCP server process. Those processes should not
listen on the Chrome extension WebSocket port directly; they use this client to
forward browser commands to the singleton hub process instead.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import websockets

from server.logger import get_logger

logger = get_logger("hub_client")

HUB_HOST = os.getenv("LINK2CHROME_HUB_HOST", "localhost")
HUB_CONTROL_PORT = int(os.getenv("LINK2CHROME_HUB_CONTROL_PORT", "8766"))
HUB_CONTROL_URL = f"ws://{HUB_HOST}:{HUB_CONTROL_PORT}"
HUB_STARTUP_TIMEOUT = float(os.getenv("LINK2CHROME_HUB_STARTUP_TIMEOUT", "10"))
REQUEST_TIMEOUT = float(os.getenv("LINK2CHROME_REQUEST_TIMEOUT", "35"))


class HubClient:
    """Thin transport facade matching the old WSManager API."""

    def __init__(self, control_url: str = HUB_CONTROL_URL):
        self.control_url = control_url
        self._startup_error: str | None = None
        self._started = False
        self._lease_token: str | None = None

    @property
    def is_connected(self) -> bool:
        # This is a synchronous compatibility hook for diagnose output. Tool
        # calls use real async round-trips and will report precise failures.
        return self._started and self._startup_error is None

    @property
    def startup_error(self) -> str | None:
        return self._startup_error

    async def start(self):
        """Ensure the singleton hub is reachable, spawning it if necessary."""
        self._startup_error = None
        if await self._can_connect(timeout=0.5):
            self._started = True
            return

        self._spawn_hub()
        deadline = time.monotonic() + HUB_STARTUP_TIMEOUT
        while time.monotonic() < deadline:
            if await self._can_connect(timeout=0.5):
                self._started = True
                logger.info(f"Browser Hub 已就绪: {self.control_url}")
                return
            await asyncio.sleep(0.2)

        self._startup_error = f"Browser Hub 启动超时，无法连接 {self.control_url}"
        logger.error(self._startup_error)

    async def stop(self):
        """Adapters do not own the hub lifecycle."""
        return None

    async def wait_for_connection(self, timeout: float = 10.0) -> bool:
        """Wait until the hub reports that Chrome Extension is connected."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                status = await self.send_command("__hub_status__", {}, timeout=2.0)
                if status.get("extension_connected"):
                    return True
            except Exception:
                pass
            await asyncio.sleep(0.5)
        return False

    async def send_command(
        self,
        command: str,
        params: dict | None = None,
        timeout: float = REQUEST_TIMEOUT,
    ) -> dict[str, Any]:
        if not self._started:
            await self.start()
        if self._startup_error:
            raise ConnectionError(self._startup_error)

        request_id = str(uuid.uuid4())[:8]
        message = {
            "request_id": request_id,
            "command": command,
            "params": params or {},
        }
        if self._lease_token:
            message["lease_token"] = self._lease_token

        try:
            async with websockets.connect(self.control_url, proxy=None) as websocket:
                await websocket.send(json.dumps(message, ensure_ascii=False))
                raw = await asyncio.wait_for(websocket.recv(), timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise TimeoutError(f"等待 Browser Hub 响应超时 ({timeout}s): {command}") from exc
        except ImportError as exc:
            self._started = False
            raise ConnectionError(
                f"连接 Browser Hub 失败 ({self.control_url}): {exc}. "
                "本地 Hub 连接已禁用代理；如果仍看到此错误，请检查 websockets 版本。"
            ) from exc
        except OSError as exc:
            self._started = False
            raise ConnectionError(f"无法连接 Browser Hub ({self.control_url}): {exc}") from exc

        response = json.loads(raw)
        if response.get("request_id") != request_id:
            raise RuntimeError(f"Browser Hub 响应 ID 不匹配: {response}")
        if not response.get("success"):
            raise RuntimeError(response.get("error", "Browser Hub 执行失败"))
        return response.get("data", {})

    @asynccontextmanager
    async def operation(self, name: str = "tool_call"):
        """Hold the hub operation queue for a full MCP tool call."""
        if self._lease_token is not None:
            yield
            return

        lease = await self.send_command("__hub_acquire__", {"name": name}, timeout=REQUEST_TIMEOUT)
        token = lease["lease_token"]
        self._lease_token = token
        try:
            yield
        finally:
            self._lease_token = None
            try:
                await self.send_command("__hub_release__", {"lease_token": token}, timeout=5.0)
            except Exception as exc:
                logger.warning(f"释放 Browser Hub 操作锁失败: {exc}")

    async def _can_connect(self, timeout: float) -> bool:
        try:
            async with websockets.connect(self.control_url, open_timeout=timeout, proxy=None):
                return True
        except ImportError as exc:
            logger.warning(f"Browser Hub 探活连接失败: {exc}")
            return False
        except Exception:
            return False

    def _spawn_hub(self):
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cmd = [sys.executable, "-m", "server.browser_hub"]
        logger.info(f"启动 Browser Hub: {' '.join(cmd)}")
        try:
            subprocess.Popen(
                cmd,
                cwd=project_root,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception as exc:
            self._startup_error = f"启动 Browser Hub 失败: {exc}"
            logger.error(self._startup_error)
