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
from server.session_protocol import (
    SESSION_PROTOCOL_VERSION,
    SessionHandle,
    SessionProtocolError,
)

logger = get_logger("hub_client")

HUB_HOST = os.getenv("LINK2CHROME_HUB_HOST", "localhost")
HUB_CONTROL_PORT = int(os.getenv("LINK2CHROME_HUB_CONTROL_PORT", "8766"))
HUB_CONTROL_URL = f"ws://{HUB_HOST}:{HUB_CONTROL_PORT}"
HUB_STARTUP_TIMEOUT = float(os.getenv("LINK2CHROME_HUB_STARTUP_TIMEOUT", "10"))
REQUEST_TIMEOUT = float(os.getenv("LINK2CHROME_REQUEST_TIMEOUT", "35"))
SESSION_PROTOCOL_MODE = os.getenv("LINK2CHROME_SESSION_PROTOCOL", "v2").lower()


class HubClient:
    """Thin transport facade matching the old WSManager API."""

    def __init__(
        self,
        control_url: str = HUB_CONTROL_URL,
        adapter_id: str | None = None,
        owner_id: str | None = None,
        protocol_mode: str | None = None,
    ):
        self.control_url = control_url
        self.adapter_id = (
            adapter_id
            or os.getenv("LINK2CHROME_ADAPTER_ID")
            or f"adapter-{str(uuid.uuid4())[:8]}"
        )
        self.owner_id = (
            owner_id
            or os.getenv("LINK2CHROME_AGENT_ID")
            or self.adapter_id
        )
        self.protocol_mode = (protocol_mode or SESSION_PROTOCOL_MODE).lower()
        if self.protocol_mode not in {"v1", "shadow", "v2"}:
            raise ValueError(
                "LINK2CHROME_SESSION_PROTOCOL must be one of: v1, shadow, v2"
            )
        self._startup_error: str | None = None
        self._started = False
        self._lease_token: str | None = None
        self._session_scope: str | None = None

    @property
    def is_connected(self) -> bool:
        # This is a synchronous compatibility hook for diagnose output. Tool
        # calls use real async round-trips and will report precise failures.
        return self._started and self._startup_error is None

    @property
    def startup_error(self) -> str | None:
        return self._startup_error

    def set_session_scope(self, session: str | None) -> None:
        self._session_scope = session

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
        if self._session_scope:
            message["session"] = self._session_scope

        response = await self._round_trip(message, request_id, timeout)
        return self._response_data(response, request_id, structured=False)

    async def create_session(
        self,
        alias: str,
        group_title: str | None = None,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        return await self._send_control(
            "__session_create__",
            {
                "ownerId": self.owner_id,
                "adapterId": self.adapter_id,
                "alias": alias,
                "groupTitle": group_title or alias,
                "operationId": operation_id or str(uuid.uuid4()),
            },
        )

    async def bind_session_group(
        self,
        session_id: str,
        group_id: int,
        window_id: int,
        seed_tab_id: int,
        browser_epoch: str,
        expected_revision: int,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        return await self._send_control(
            "__session_bind_group__",
            {
                "ownerId": self.owner_id,
                "adapterId": self.adapter_id,
                "sessionId": session_id,
                "groupId": group_id,
                "windowId": window_id,
                "seedTabId": seed_tab_id,
                "browserEpoch": browser_epoch,
                "expectedRevision": expected_revision,
                "operationId": operation_id or str(uuid.uuid4()),
            },
        )

    async def open_session(
        self,
        alias: str,
        group_title: str | None = None,
        operation_id: str | None = None,
        window_id: int | None = None,
        initial_url: str | None = None,
    ) -> dict[str, Any]:
        creating = await self.create_session(
            alias=alias,
            group_title=group_title,
            operation_id=operation_id,
        )
        if creating.get("state") == "ACTIVE":
            if initial_url:
                return await self._create_session_tab_latest(
                    creating,
                    initial_url,
                )
            return creating
        try:
            return await self.materialize_session(
                creating,
                operation_id=str(uuid.uuid4()),
                window_id=window_id,
                initial_url=initial_url,
            )
        except SessionProtocolError as exc:
            if exc.code != "STALE_SESSION_REVISION":
                raise
            current = await self.get_session(alias)
            if current.get("state") != "ACTIVE":
                raise
            if initial_url:
                return await self._create_session_tab_latest(
                    current,
                    initial_url,
                )
            return current

    async def _create_session_tab_latest(
        self,
        handle: SessionHandle | dict[str, Any],
        url: str,
        max_attempts: int = 3,
    ) -> dict[str, Any]:
        current = handle
        alias = self._coerce_handle(handle).alias
        for attempt in range(max_attempts):
            try:
                return await self.create_session_tab(current, url)
            except SessionProtocolError as exc:
                if exc.code != "STALE_SESSION_REVISION" or attempt + 1 >= max_attempts:
                    raise
                current = await self.get_session(alias)
        raise RuntimeError("unreachable")

    async def materialize_session(
        self,
        handle: SessionHandle | dict[str, Any],
        operation_id: str | None = None,
        window_id: int | None = None,
        initial_url: str | None = None,
    ) -> dict[str, Any]:
        session = self._coerce_handle(handle)
        params: dict[str, Any] = {
            "ownerId": session.owner_id,
            "adapterId": session.adapter_id,
            "sessionId": session.session_id,
            "expectedRevision": session.revision,
            "operationId": operation_id or str(uuid.uuid4()),
        }
        if window_id is not None:
            params["windowId"] = window_id
        if initial_url:
            params["url"] = initial_url
        return await self._send_control("__session_materialize__", params)

    async def create_session_tab(
        self,
        handle: SessionHandle | dict[str, Any],
        url: str,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        session = self._coerce_handle(handle)
        return await self._send_control(
            "__session_create_tab__",
            {
                "ownerId": session.owner_id,
                "adapterId": session.adapter_id,
                "sessionId": session.session_id,
                "url": url,
                "expectedRevision": session.revision,
                "operationId": operation_id or str(uuid.uuid4()),
            },
        )

    async def get_session(self, alias: str) -> dict[str, Any]:
        return await self._send_control(
            "__session_get__",
            {"ownerId": self.owner_id, "adapterId": self.adapter_id, "alias": alias},
        )

    async def get_session_by_id(self, session_id: str) -> dict[str, Any]:
        return await self._send_control(
            "__session_get__",
            {"sessionId": session_id, "ownerId": self.owner_id, "adapterId": self.adapter_id},
        )

    async def list_sessions(self) -> dict[str, Any]:
        return await self._send_control(
            "__session_list__",
            {"ownerId": self.owner_id, "adapterId": self.adapter_id},
        )

    async def list_user_tabs(self) -> dict[str, Any]:
        return await self._send_control(
            "__session_user_tabs__",
            {"ownerId": self.owner_id, "adapterId": self.adapter_id},
        )

    async def reconcile(self, browser_epoch: str) -> dict[str, Any]:
        return await self._send_control("__hub_reconcile__", {"browserEpoch": browser_epoch})

    async def close_session(
        self,
        handle: SessionHandle | dict[str, Any],
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        session = self._coerce_handle(handle)
        return await self._send_control(
            "__session_close__",
            {
                "ownerId": session.owner_id,
                "adapterId": session.adapter_id,
                "sessionId": session.session_id,
                "expectedRevision": session.revision,
                "operationId": operation_id or str(uuid.uuid4()),
            },
        )

    async def claim_session_tab(
        self,
        handle,
        tab_id: int,
        operation_id: str | None = None,
        claim_token: str | None = None,
    ):
        session = self._coerce_handle(handle)
        return await self._send_control("__session_claim_tab__", {
            "ownerId": session.owner_id, "adapterId": session.adapter_id,
            "sessionId": session.session_id, "tabId": tab_id,
            "claimToken": claim_token,
            "expectedRevision": session.revision,
            "operationId": operation_id or str(uuid.uuid4()),
        })

    async def release_session_tab(self, handle, tab_id: int, operation_id: str | None = None):
        session = self._coerce_handle(handle)
        return await self._send_control("__session_release_tab__", {
            "ownerId": session.owner_id, "adapterId": session.adapter_id,
            "sessionId": session.session_id, "tabId": tab_id,
            "expectedRevision": session.revision,
            "operationId": operation_id or str(uuid.uuid4()),
        })

    async def finalize_session(self, handle, keep_tab_ids, operation_id: str | None = None):
        session = self._coerce_handle(handle)
        return await self._send_control("__session_finalize__", {
            "ownerId": session.owner_id, "adapterId": session.adapter_id,
            "sessionId": session.session_id, "keepTabIds": list(keep_tab_ids),
            "expectedRevision": session.revision,
            "operationId": operation_id or str(uuid.uuid4()),
        })

    async def send_session_command(
        self,
        handle: SessionHandle | dict[str, Any],
        command: str,
        params: dict[str, Any] | None = None,
        operation_id: str | None = None,
        tab_id: int | None = None,
        timeout: float = REQUEST_TIMEOUT,
    ) -> dict[str, Any]:
        """Send one V2 command without mutating client-wide Session state."""
        if not self._started:
            await self.start()
        if self._startup_error:
            raise ConnectionError(self._startup_error)

        session = self._coerce_handle(handle)
        request_id = str(uuid.uuid4())[:8]
        message = {
            "protocolVersion": SESSION_PROTOCOL_VERSION,
            "requestId": request_id,
            "operationId": operation_id or str(uuid.uuid4()),
            "adapterId": session.adapter_id,
            "ownerId": session.owner_id,
            "sessionId": session.session_id,
            "sessionAlias": session.alias,
            "sessionRevision": session.revision,
            "groupId": session.group_id,
            "tabId": session.target_tab_id if tab_id is None else tab_id,
            "command": command,
            "params": params or {},
        }
        response = await self._round_trip(message, request_id, timeout)
        return self._response_data(response, request_id, structured=True)

    async def _send_control(
        self,
        command: str,
        params: dict[str, Any],
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
            "params": params,
        }
        response = await self._round_trip(message, request_id, timeout)
        return self._response_data(response, request_id, structured=True)

    async def _round_trip(
        self,
        message: dict[str, Any],
        request_id: str,
        timeout: float,
    ) -> dict[str, Any]:
        try:
            async with websockets.connect(self.control_url, proxy=None) as websocket:
                registration_id = f"register-{str(uuid.uuid4())[:8]}"
                await websocket.send(json.dumps({
                    "request_id": registration_id,
                    "command": "__hub_register_adapter__",
                    "params": {"adapterId": self.adapter_id, "ownerId": self.owner_id},
                }, ensure_ascii=False))
                registration_raw = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                registration = json.loads(registration_raw)
                if registration.get("request_id") != registration_id or not registration.get("success"):
                    raise ConnectionError(registration.get("error", "Browser Hub adapter registration failed"))
                await websocket.send(json.dumps(message, ensure_ascii=False))
                raw = await asyncio.wait_for(websocket.recv(), timeout=timeout)
        except asyncio.TimeoutError as exc:
            command = message.get("command", "session command")
            raise TimeoutError(
                f"等待 Browser Hub 响应超时 ({timeout}s): {command}"
            ) from exc
        except ImportError as exc:
            self._started = False
            raise ConnectionError(
                f"连接 Browser Hub 失败 ({self.control_url}): {exc}. "
                "本地 Hub 连接已禁用代理；如果仍看到此错误，请检查 websockets 版本。"
            ) from exc
        except OSError as exc:
            self._started = False
            raise ConnectionError(f"无法连接 Browser Hub ({self.control_url}): {exc}") from exc
        return json.loads(raw)

    @staticmethod
    def _response_data(
        response: dict[str, Any],
        request_id: str,
        structured: bool,
    ) -> dict[str, Any]:
        if response.get("request_id") != request_id:
            raise RuntimeError(f"Browser Hub 响应 ID 不匹配: {response}")
        if not response.get("success"):
            if structured and response.get("code"):
                raise SessionProtocolError(
                    response["code"],
                    response.get("error", "Browser Hub Session 执行失败"),
                    response.get("details") or {},
                )
            raise RuntimeError(response.get("error", "Browser Hub 执行失败"))
        return response.get("data", {})

    @staticmethod
    def _coerce_handle(handle: SessionHandle | dict[str, Any]) -> SessionHandle:
        if isinstance(handle, SessionHandle):
            return handle
        return SessionHandle(
            session_id=handle["sessionId"],
            owner_id=handle["ownerId"],
            adapter_id=handle["adapterId"],
            alias=handle["session"],
            group_id=handle.get("groupId"),
            group_title=handle.get("groupTitle") or handle["session"],
            window_id=handle.get("windowId"),
            target_tab_id=handle.get("targetTabId"),
            revision=handle["revision"],
            state=handle["state"],
            browser_epoch=handle.get("browserEpoch"),
        )

    @asynccontextmanager
    async def operation(self, name: str = "tool_call"):
        """Hold the hub operation queue for a full MCP tool call."""
        if self._lease_token is not None:
            yield
            return

        payload = {"name": name}
        if self._session_scope:
            payload["session"] = self._session_scope
        lease = await self.send_command("__hub_acquire__", payload, timeout=REQUEST_TIMEOUT)
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
