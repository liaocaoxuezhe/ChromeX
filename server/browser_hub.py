"""
Singleton Browser Hub.

The hub owns the Chrome Extension WebSocket port and exposes a separate local
control WebSocket for many MCP stdio adapter processes. Legacy V1 operations
remain globally serialized while explicit V2 operations use per-Session lanes.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import websockets
from websockets.asyncio.server import ServerConnection

from server.logger import setup_logging, get_logger, get_operation_logger
from server.session_protocol import SessionEnvelope, SessionProtocolError
from server.session_registry import SessionRegistry, SessionState
from server.session_scheduler import SessionScheduler
from server.session_store import SessionStore
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
LEASE_IDLE_TIMEOUT = float(os.getenv("LINK2CHROME_HUB_LEASE_IDLE_TIMEOUT", "60"))
ACQUIRE_WAIT_TIMEOUT = float(os.getenv("LINK2CHROME_HUB_ACQUIRE_TIMEOUT", "30"))
MAX_CONCURRENT_SESSIONS = int(os.getenv("LINK2CHROME_MAX_CONCURRENT_SESSIONS", "8"))
SESSION_PROTOCOL_MODE = os.getenv("LINK2CHROME_SESSION_PROTOCOL", "v2").lower()


class BrowserHub:
    def __init__(
        self,
        extension_ws=None,
        session_registry: SessionRegistry | None = None,
        session_scheduler: SessionScheduler | None = None,
        session_store=None,
        protocol_mode: str | None = None,
    ):
        self.extension_ws = extension_ws or WSManager()
        self.session_registry = session_registry or SessionRegistry()
        self.session_scheduler = session_scheduler or SessionScheduler(
            max_concurrent_sessions=MAX_CONCURRENT_SESSIONS
        )
        self.session_store = session_store
        self.protocol_mode = (protocol_mode or SESSION_PROTOCOL_MODE).lower()
        if self.protocol_mode not in {"v1", "shadow", "v2"}:
            raise ValueError(
                "LINK2CHROME_SESSION_PROTOCOL must be one of: v1, shadow, v2"
            )
        self._control_server = None
        self._operation_lock = asyncio.Lock()
        self._lease_token: str | None = None
        self._lease_name: str | None = None
        self._lease_scope: dict[str, Any] | None = None
        self._lease_started_at: float | None = None
        self._lease_last_seen_at: float | None = None
        self._adapter_connections: set[ServerConnection] = set()
        self._registered_adapters: dict[str, dict[str, Any]] = {}
        self._claim_tokens: dict[str, dict[str, Any]] = {}
        self._hub_id = str(uuid.uuid4())[:8]
        self._reconcile_lock: asyncio.Lock | None = None
        self._reconcile_state = "NOT_STARTED"
        self._reconciled_connection_generation: int | None = None
        if hasattr(self.extension_ws, "add_event_handler"):
            self.extension_ws.add_event_handler(self._handle_extension_event)

    async def _handle_extension_event(self, event: dict[str, Any]) -> None:
        if event.get("type") == "session_tab_closed":
            session_id = self._require_text(event, "sessionId")
            operation_id = self._require_text(event, "operationId")
            async with self.session_scheduler.session_operation(session_id, operation_id):
                handle = self.session_registry.get(session_id)
                updated = await self.session_registry.unregister_tab(
                    session_id=session_id,
                    tab_id=self._require_int(event, "tabId"),
                    expected_revision=handle.revision,
                    operation_id=operation_id,
                )
            self._persist_snapshot(updated.browser_epoch)
            return
        if event.get("type") != "session_tab_discovered":
            return
        session_id = self._require_text(event, "sessionId")
        operation_id = self._require_text(event, "operationId")
        async with self.session_scheduler.session_operation(session_id, operation_id):
            handle = self.session_registry.get(session_id)
            if event.get("groupId") != handle.group_id or event.get("windowId") != handle.window_id:
                raise SessionProtocolError(
                    "GROUP_VERIFICATION_FAILED",
                    "Extension discovered a tab outside the Session group",
                    {"sessionId": session_id, "tabId": event.get("tabId")},
                )
            updated = await self.session_registry.register_tab(
                session_id=session_id,
                tab_id=self._require_int(event, "tabId"),
                expected_revision=handle.revision,
                operation_id=operation_id,
                set_target=False,
            )
        self._persist_snapshot(updated.browser_epoch)

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
        connection_identity: dict[str, str] = {}
        logger.debug(f"MCP adapter 已连接: {websocket.remote_address}")
        try:
            async for raw_message in websocket:
                response = await self._handle_adapter_message(raw_message, connection_identity)
                try:
                    await websocket.send(json.dumps(response, ensure_ascii=False))
                except Exception:
                    self._release_undelivered_lease(response)
                    raise
        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception as exc:
            logger.exception(f"MCP adapter 连接异常: {exc}")
        finally:
            self._adapter_connections.discard(websocket)

    async def _handle_adapter_message(
        self,
        raw_message: str,
        connection_identity: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        request_id = None
        try:
            message = json.loads(raw_message)
            request_id = message.get("request_id")
            command = message["command"]
            params = message.get("params") or {}
            self._release_expired_lease()

            if command == "__hub_status__":
                return self._ok(request_id, self._status())
            if command == "__hub_reconcile__":
                return await self._reconcile(request_id, params)
            if command == "__hub_register_adapter__":
                adapter_id = self._require_text(params, "adapterId")
                owner_id = self._require_text(params, "ownerId")
                existing = self._registered_adapters.get(adapter_id)
                if existing and existing.get("ownerId") != owner_id:
                    raise SessionProtocolError(
                        "ADAPTER_IDENTITY_MISMATCH",
                        f"adapter {adapter_id} is already bound to another owner",
                        {"adapterId": adapter_id},
                    )
                self._registered_adapters[adapter_id] = {
                    "adapterId": adapter_id,
                    "ownerId": owner_id,
                    "registeredAt": time.time(),
                }
                if connection_identity is not None:
                    connection_identity.update({"adapterId": adapter_id, "ownerId": owner_id})
                return self._ok(request_id, self._registered_adapters[adapter_id])
            if command.startswith("__session_"):
                if self.protocol_mode == "v1":
                    raise SessionProtocolError(
                        "SESSION_PROTOCOL_DISABLED",
                        "Session protocol V2 is not enabled",
                        {"mode": self.protocol_mode},
                    )
                await self._ensure_reconciled()
                self._validate_connection_identity(connection_identity, params)
                return await self._handle_session_control(request_id, command, params)
            if command == "__hub_acquire__":
                return await self._acquire_lease(request_id, params)
            if command == "__hub_release__":
                token = params.get("lease_token")
                if token != self._lease_token:
                    raise RuntimeError("Browser Hub 操作锁 token 不匹配")
                self._release_current_lease()
                return self._ok(request_id, {"released": True})

            if message.get("protocolVersion") == 2:
                if self.protocol_mode == "v1":
                    raise SessionProtocolError(
                        "SESSION_PROTOCOL_DISABLED",
                        "Session protocol V2 is not enabled",
                        {"mode": self.protocol_mode},
                    )
                self._validate_connection_identity(connection_identity, message)
                return await self._handle_v2_operation(message)

            # One real browser, one visible UI: serialize operations from all
            # adapters. This is deliberately conservative for the first pass.
            if message.get("session"):
                params = dict(params)
                params.setdefault("scope", {})
                params["scope"].setdefault("session", message["session"])

            if self.protocol_mode in {"v1", "shadow"} and self.session_store is not None:
                version = await self.extension_ws.send_command("ping_version", {})
                browser_epoch = version.get("browserEpoch")
                if browser_epoch and self.session_store.has_active_v2_sessions(browser_epoch):
                    raise SessionProtocolError(
                        "V2_SESSIONS_ACTIVE",
                        "Legacy Session control is disabled while persisted V2 Sessions are active",
                    )

            if message.get("lease_token") == self._lease_token:
                self._lease_last_seen_at = time.monotonic()
                data = await self.extension_ws.send_command(command, params)
            else:
                async with self._operation_lock:
                    data = await self.extension_ws.send_command(command, params)
            return self._ok(request_id, data)
        except SessionProtocolError as exc:
            logger.error(f"Hub Session 请求失败 [{exc.code}]: {exc}")
            return {
                "request_id": request_id,
                "success": False,
                "error": str(exc),
                "code": exc.code,
                "details": exc.details,
            }
        except Exception as exc:
            logger.error(f"Hub 请求失败: {exc}")
            return {
                "request_id": request_id,
                "success": False,
                "error": str(exc),
            }

    def _status(self) -> dict[str, Any]:
        lease_age = None
        if self._lease_started_at is not None:
            lease_age = round(time.monotonic() - self._lease_started_at, 3)
        lease_idle = None
        if self._lease_last_seen_at is not None:
            lease_idle = round(time.monotonic() - self._lease_last_seen_at, 3)
        registry_snapshot = self.session_registry.snapshot()
        return {
            "hub_id": self._hub_id,
            "adapter_connections": len(self._adapter_connections),
            "extension_connected": self.extension_ws.is_connected,
            "extension_startup_error": self.extension_ws.startup_error,
            "queue_locked": self._operation_lock.locked(),
            "lease_name": self._lease_name,
            "lease_scope": self._lease_scope,
            "lease_age_seconds": lease_age,
            "lease_idle_seconds": lease_idle,
            "session_protocol_mode": self.protocol_mode,
            "active_sessions": len(self.session_registry.list_sessions()),
            "registered_adapters": len(self._registered_adapters),
            "scheduler": self.session_scheduler.snapshot(),
            "registry": {
                "sessions": len(registry_snapshot.get("sessions", [])),
                "groupOwners": len(registry_snapshot.get("groupOwners", {})),
                "tabOwners": len(registry_snapshot.get("tabOwners", {})),
                "states": {
                    state: sum(1 for item in registry_snapshot.get("sessions", []) if item.get("state") == state)
                    for state in ("CREATING", "ACTIVE", "FINALIZING", "ORPHANED", "FAILED")
                },
            },
        }

    @staticmethod
    def _validate_connection_identity(
        connection_identity: dict[str, str] | None,
        claimed: dict[str, Any],
    ) -> None:
        # Direct unit calls omit a connection. Production websocket traffic is
        # required to register and is then bound to that connection identity.
        if connection_identity is None:
            return
        if not connection_identity:
            raise SessionProtocolError(
                "ADAPTER_NOT_REGISTERED",
                "Session V2 requires adapter registration on this connection",
            )
        if (
            claimed.get("ownerId") != connection_identity.get("ownerId")
            or claimed.get("adapterId") != connection_identity.get("adapterId")
        ):
            raise SessionProtocolError(
                "ADAPTER_IDENTITY_MISMATCH",
                "Session identity does not match the registered adapter connection",
                {"adapterId": connection_identity.get("adapterId")},
            )

    async def _reconcile(self, request_id, params):
        browser_epoch = self._require_text(params, "browserEpoch")
        registry_live = bool(self.session_registry.list_sessions())
        if registry_live:
            snapshot = self.session_registry.snapshot()
            snapshot["browserEpoch"] = browser_epoch
            live_epochs = {
                item.get("browserEpoch")
                for item in snapshot.get("sessions") or []
                if item.get("state") == "ACTIVE"
            }
            if live_epochs and live_epochs != {browser_epoch}:
                return self._ok(request_id, {"restored": 0, "reason": "browser-epoch-mismatch"})
        elif self.session_store is not None:
            snapshot = self.session_store.load_snapshot(browser_epoch)
        else:
            snapshot = None
        if snapshot is None:
            reason = "store-disabled" if self.session_store is None else "snapshot-not-found"
            return self._ok(request_id, {"restored": 0, "reason": reason})
        extension = await self.extension_ws.send_command("session_snapshot", {})
        if extension.get("browserEpoch") != browser_epoch:
            if self.session_store is not None:
                self.session_store.mark_epoch_orphaned(browser_epoch)
            return self._ok(request_id, {"restored": 0, "reason": "browser-epoch-mismatch"})
        expected = [
            item for item in snapshot.get("sessions") or []
            if item.get("state") == "ACTIVE"
        ]
        if expected and not (extension.get("sessions") or []):
            await self.extension_ws.send_command(
                "session_restore_snapshot", {"sessions": expected}
            )
            extension = await self.extension_ws.send_command("session_snapshot", {})
        actual = {item.get("sessionId"): item for item in extension.get("sessions") or []}
        expected_ids = {item.get("sessionId") for item in expected}
        if set(actual) != expected_ids or any(
            actual[item["sessionId"]].get("groupId") != item.get("groupId")
            or actual[item["sessionId"]].get("windowId") != item.get("windowId")
            or set(actual[item["sessionId"]].get("tabIds") or []) != set(item.get("tabIds") or [])
            for item in expected
        ):
            return self._ok(request_id, {"restored": 0, "reason": "ownership-ambiguous"})
        if registry_live:
            return self._ok(request_id, {"restored": len(expected), "reason": "extension-mirror-verified"})
        restored = self.session_registry.restore_snapshot(snapshot, browser_epoch)
        return self._ok(request_id, {"restored": restored, "reason": "exact-epoch"})

    async def _ensure_reconciled(self) -> None:
        if self._reconcile_lock is None:
            self._reconcile_lock = asyncio.Lock()
        async with self._reconcile_lock:
            connection_generation = getattr(
                self.extension_ws, "connection_generation", None
            )
            if (
                self._reconcile_state == "SUCCEEDED"
                and connection_generation == self._reconciled_connection_generation
            ):
                return
            self._reconcile_state = "RUNNING"
            try:
                version = await self.extension_ws.send_command("ping_version", {})
                browser_epoch = version.get("browserEpoch")
                if not isinstance(browser_epoch, str) or not browser_epoch:
                    raise SessionProtocolError(
                        "BROWSER_EPOCH_REQUIRED",
                        "Extension did not provide a browser epoch for Session recovery",
                    )
                result = await self._reconcile(None, {"browserEpoch": browser_epoch})
                reason = (result.get("data") or {}).get("reason")
                if reason in {"ownership-ambiguous", "browser-epoch-mismatch"}:
                    raise SessionProtocolError(
                        "SESSION_RECOVERY_REQUIRED",
                        "Session ownership recovery is ambiguous; refusing Chrome mutations",
                        {"browserEpoch": browser_epoch, "reason": reason},
                    )
                self._reconcile_state = "SUCCEEDED"
                self._reconciled_connection_generation = connection_generation
            except Exception:
                self._reconcile_state = "FAILED"
                raise

    async def _handle_session_control(
        self,
        request_id: str | None,
        command: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        if command == "__session_user_tabs__":
            raw = await self.extension_ws.send_command("get_all_tabs", {})
            owner_id = self._require_text(params, "ownerId")
            adapter_id = self._require_text(params, "adapterId")
            for tabs in (raw.get("windows") or {}).values():
                for tab in tabs:
                    tab_id = tab.get("id")
                    if not isinstance(tab_id, int):
                        continue
                    token = str(uuid.uuid4())
                    self._claim_tokens[token] = {
                        "ownerId": owner_id,
                        "adapterId": adapter_id,
                        "tabId": tab_id,
                        "expiresAt": time.monotonic() + 60.0,
                    }
                    tab["claimToken"] = token
            return self._ok(request_id, raw)

        if command == "__session_create__":
            handle = await self.session_registry.create(
                owner_id=self._require_text(params, "ownerId"),
                adapter_id=self._require_text(params, "adapterId"),
                alias=self._require_text(params, "alias"),
                group_title=params.get("groupTitle")
                or self._require_text(params, "alias"),
                operation_id=self._require_text(params, "operationId"),
            )
            return self._ok(request_id, self._session_payload(handle))

        if command == "__session_bind_group__":
            session_id = self._require_text(params, "sessionId")
            current = self.session_registry.get(session_id)
            self._validate_control_owner(current, params)
            expected_revision = self._require_int(params, "expectedRevision")
            operation_id = self._require_text(params, "operationId")
            async with self.session_scheduler.session_operation(session_id, operation_id):
                current = self.session_registry.get(session_id)
                self._validate_control_owner(current, params)
                self._validate_expected_revision(current, expected_revision)
                await self.extension_ws.send_command("session_register_snapshot", {
                    "sessionId": session_id,
                    "ownerId": current.owner_id,
                    "alias": current.alias,
                    "groupId": self._require_int(params, "groupId"),
                    "windowId": self._require_int(params, "windowId"),
                    "targetTabId": self._require_int(params, "seedTabId"),
                    "tabIds": [self._require_int(params, "seedTabId")],
                    "claimedTabIds": [],
                    "claimRestore": {},
                    "revision": expected_revision + 1,
                    "state": "ACTIVE",
                })
                try:
                    handle = await self.session_registry.bind_group(
                        session_id=session_id,
                        group_id=self._require_int(params, "groupId"),
                        window_id=self._require_int(params, "windowId"),
                        seed_tab_id=self._require_int(params, "seedTabId"),
                        browser_epoch=self._require_text(params, "browserEpoch"),
                        expected_revision=expected_revision,
                        operation_id=operation_id,
                    )
                except Exception:
                    await self.extension_ws.send_command(
                        "session_forget_snapshot", {"sessionId": session_id}
                    )
                    raise
            self._persist_snapshot(handle.browser_epoch)
            return self._ok(request_id, self._session_payload(handle))

        if command == "__session_materialize__":
            session_id = self._require_text(params, "sessionId")
            handle = self.session_registry.get(session_id)
            self._validate_control_owner(handle, params)
            expected_revision = self._require_int(params, "expectedRevision")
            if handle.revision != expected_revision:
                raise SessionProtocolError(
                    "STALE_SESSION_REVISION",
                    f"Session {handle.alias} revision changed",
                    {
                        "sessionId": session_id,
                        "expectedRevision": expected_revision,
                        "actualRevision": handle.revision,
                    },
                )
            operation_id = self._require_text(params, "operationId")
            extension_params = {
                "sessionId": handle.session_id,
                "ownerId": handle.owner_id,
                "alias": handle.alias,
                "title": handle.group_title,
                "revision": handle.revision + 1,
                "expectedRevision": expected_revision,
            }
            if params.get("url"):
                extension_params["url"] = params["url"]
            if isinstance(params.get("windowId"), int):
                extension_params["windowId"] = params["windowId"]
            async with self.session_scheduler.session_operation(
                session_id, operation_id
            ):
                handle = self.session_registry.get(session_id)
                self._validate_control_owner(handle, params)
                self._validate_expected_revision(handle, expected_revision)
                result = await self.extension_ws.send_command(
                    "session_create_group", extension_params
                )
                try:
                    active = await self.session_registry.bind_group(
                        session_id=session_id,
                        group_id=self._require_int(result, "groupId"),
                        window_id=self._require_int(result, "windowId"),
                        seed_tab_id=self._require_int(result, "tabId"),
                        browser_epoch=result.get("browserEpoch") or params.get("browserEpoch") or "runtime",
                        expected_revision=expected_revision,
                        operation_id=operation_id,
                    )
                except Exception:
                    await self.extension_ws.send_command(
                        "session_rollback_group", {"sessionId": session_id}
                    )
                    raise
            self._persist_snapshot(active.browser_epoch)
            return self._ok(
                request_id,
                {**active.to_payload(), "focusPreserved": result.get("focusPreserved", False)},
            )

        if command == "__session_create_tab__":
            session_id = self._require_text(params, "sessionId")
            handle = self.session_registry.get(session_id)
            self._validate_control_owner(handle, params)
            expected_revision = self._require_int(params, "expectedRevision")
            if handle.revision != expected_revision:
                raise SessionProtocolError(
                    "STALE_SESSION_REVISION",
                    f"Session {handle.alias} revision changed",
                    {
                        "sessionId": session_id,
                        "expectedRevision": expected_revision,
                        "actualRevision": handle.revision,
                    },
                )
            if handle.state != SessionState.ACTIVE.value:
                raise SessionProtocolError(
                    "INVALID_SESSION_STATE",
                    f"Session {handle.alias} is in state {handle.state}",
                    {"sessionId": session_id, "state": handle.state},
                )
            operation_id = self._require_text(params, "operationId")
            extension_params = {
                "sessionId": handle.session_id,
                "groupId": handle.group_id,
                "windowId": handle.window_id,
                "url": params.get("url") or "about:blank",
                "revision": handle.revision + 1,
            }
            async with self.session_scheduler.session_operation(
                session_id, operation_id
            ):
                handle = self.session_registry.get(session_id)
                self._validate_control_owner(handle, params)
                self._validate_expected_revision(handle, expected_revision)
                extension_params.update({
                    "groupId": handle.group_id,
                    "windowId": handle.window_id,
                    "revision": handle.revision + 1,
                    "expectedRevision": handle.revision,
                })
                result = await self.extension_ws.send_command(
                    "session_create_tab", extension_params
                )
                tab_id = self._require_int(result, "tabId")
                try:
                    if result.get("groupId") != handle.group_id or result.get("windowId") != handle.window_id:
                        raise SessionProtocolError(
                            "GROUP_VERIFICATION_FAILED",
                            "Extension returned a tab outside the Session group",
                            {
                                "sessionId": session_id,
                                "expectedGroupId": handle.group_id,
                                "actualGroupId": result.get("groupId"),
                                "expectedWindowId": handle.window_id,
                                "actualWindowId": result.get("windowId"),
                            },
                        )
                    updated = await self.session_registry.register_tab(
                        session_id=session_id,
                        tab_id=tab_id,
                        expected_revision=expected_revision,
                        operation_id=operation_id,
                        set_target=True,
                    )
                except Exception:
                    await self.extension_ws.send_command(
                        "session_rollback_tab",
                        {
                            "sessionId": session_id,
                            "tabId": tab_id,
                            "expectedRevision": expected_revision + 1,
                            "revision": expected_revision,
                        },
                    )
                    raise
            self._persist_snapshot(updated.browser_epoch)
            return self._ok(
                request_id,
                {
                    **updated.to_payload(),
                    "tabId": tab_id,
                    "focusPreserved": result.get("focusPreserved", False),
                },
            )

        if command == "__session_claim_tab__":
            session_id = self._require_text(params, "sessionId")
            handle = self.session_registry.get(session_id)
            self._validate_control_owner(handle, params)
            expected_revision = self._require_int(params, "expectedRevision")
            operation_id = self._require_text(params, "operationId")
            tab_id = self._require_int(params, "tabId")
            async with self.session_scheduler.session_operation(session_id, operation_id):
                handle = self.session_registry.get(session_id)
                self._validate_control_owner(handle, params)
                self._validate_expected_revision(handle, expected_revision)
                replay = self.session_registry.preflight_operation(
                    operation_id, "claim_tab", session_id, tab_id, handle.revision
                )
                if replay is not None:
                    return self._ok(request_id, {**self._session_payload(replay), "claimedTabId": tab_id})
                if self.session_registry.owner_of_tab(tab_id) != session_id:
                    self._consume_claim_token(params, handle, tab_id)
                async with self.session_scheduler.resource_operation(f"chrome-tab:{tab_id}"):
                    owner = self.session_registry.owner_of_tab(tab_id)
                    if owner and owner != session_id:
                        raise SessionProtocolError(
                            "TAB_ALREADY_OWNED",
                            f"tab {tab_id} belongs to another Session",
                            {"tabId": tab_id, "sessionId": owner},
                        )
                    result = await self.extension_ws.send_command(
                        "session_claim_tab",
                        {
                            "sessionId": session_id,
                            "tabId": tab_id,
                            "expectedRevision": handle.revision,
                            "revision": handle.revision + 1,
                        },
                    )
                    try:
                        updated = await self.session_registry.claim_tab(
                            session_id=session_id,
                            tab_id=tab_id,
                            expected_revision=handle.revision,
                            operation_id=operation_id,
                            restore=result.get("restore") or {},
                        )
                    except Exception:
                        await self.extension_ws.send_command(
                            "session_abort_claim",
                            {
                                "sessionId": session_id,
                                "tabId": tab_id,
                                "expectedRevision": handle.revision + 1,
                                "revision": handle.revision,
                            },
                        )
                        raise
            self._persist_snapshot(updated.browser_epoch)
            return self._ok(request_id, {**updated.to_payload(), "claimedTabId": tab_id})

        if command == "__session_release_tab__":
            session_id = self._require_text(params, "sessionId")
            handle = self.session_registry.get(session_id)
            self._validate_control_owner(handle, params)
            expected_revision = self._require_int(params, "expectedRevision")
            operation_id = self._require_text(params, "operationId")
            tab_id = self._require_int(params, "tabId")
            async with self.session_scheduler.session_operation(session_id, operation_id):
                handle = self.session_registry.get(session_id)
                self._validate_control_owner(handle, params)
                self._validate_expected_revision(handle, expected_revision)
                replay = self.session_registry.preflight_operation(
                    operation_id, "release_tab", session_id, tab_id, handle.revision
                )
                if replay is not None:
                    return self._ok(request_id, self._session_payload(replay))
                async with self.session_scheduler.resource_operation(f"chrome-tab:{tab_id}"):
                    release_result = await self.extension_ws.send_command(
                        "session_release_tab",
                        {
                            "sessionId": session_id,
                            "tabId": tab_id,
                            "expectedRevision": handle.revision,
                            "revision": handle.revision + 1,
                        },
                    )
                    try:
                        updated = await self.session_registry.release_tab(
                            session_id=session_id,
                            tab_id=tab_id,
                            expected_revision=handle.revision,
                            operation_id=operation_id,
                        )
                    except Exception:
                        await self.extension_ws.send_command(
                            "session_abort_release",
                            {
                                "sessionId": session_id,
                                "tabId": tab_id,
                                "restore": release_result.get("restored") or {},
                                "expectedRevision": handle.revision + 1,
                                "revision": handle.revision,
                            },
                        )
                        raise
            self._persist_snapshot(updated.browser_epoch)
            return self._ok(request_id, updated.to_payload())

        if command == "__session_get__":
            session_id = params.get("sessionId")
            if session_id:
                handle = self.session_registry.get(session_id)
            else:
                handle = self.session_registry.resolve(
                    self._require_text(params, "ownerId"),
                    self._require_text(params, "alias"),
                )
                if handle is None:
                    raise SessionProtocolError(
                        "SESSION_NOT_FOUND",
                        f"Session '{params.get('alias')}' does not exist",
                        {
                            "ownerId": params.get("ownerId"),
                            "session": params.get("alias"),
                        },
                    )
            self._validate_control_owner(handle, params)
            return self._ok(request_id, self._session_payload(handle))

        if command == "__session_list__":
            owner_id = params.get("ownerId")
            sessions = [
                self._session_payload(handle)
                for handle in self.session_registry.list_sessions()
                if (owner_id is None or handle.owner_id == owner_id)
                and handle.adapter_id == params.get("adapterId")
            ]
            return self._ok(request_id, {"sessions": sessions})

        if command == "__session_close__":
            session_id = self._require_text(params, "sessionId")
            current = self.session_registry.get(session_id)
            self._validate_control_owner(current, params)
            expected_revision = self._require_int(params, "expectedRevision")
            operation_id = self._require_text(params, "operationId")
            async with self.session_scheduler.session_operation(session_id, operation_id):
                current = self.session_registry.get(session_id)
                self._validate_control_owner(current, params)
                self._validate_expected_revision(current, expected_revision)
                await self.extension_ws.send_command("session_close", {"sessionId": session_id})
                handle = await self.session_registry.close(
                    session_id=session_id,
                    expected_revision=expected_revision,
                    operation_id=operation_id,
                )
            self._persist_snapshot(handle.browser_epoch)
            return self._ok(request_id, handle.to_payload())

        if command == "__session_finalize__":
            session_id = self._require_text(params, "sessionId")
            current = self.session_registry.get(session_id)
            self._validate_control_owner(current, params)
            expected_revision = self._require_int(params, "expectedRevision")
            operation_id = self._require_text(params, "operationId")
            keep_tab_ids = [int(tab_id) for tab_id in params.get("keepTabIds") or []]
            async with self.session_scheduler.session_operation(session_id, operation_id):
                current = self.session_registry.get(session_id)
                self._validate_control_owner(current, params)
                self._validate_expected_revision(current, expected_revision)
                result = await self.extension_ws.send_command(
                    "session_finalize", {"sessionId": session_id, "keepTabIds": keep_tab_ids}
                )
                handle = await self.session_registry.close(
                    session_id=session_id,
                    expected_revision=expected_revision,
                    operation_id=operation_id,
                )
            self._persist_snapshot(handle.browser_epoch)
            return self._ok(request_id, {**handle.to_payload(), **result})

        raise SessionProtocolError(
            "UNKNOWN_SESSION_COMMAND",
            f"Unknown Hub Session command: {command}",
            {"command": command},
        )

    async def _handle_v2_operation(
        self, message: dict[str, Any]
    ) -> dict[str, Any]:
        envelope = SessionEnvelope.from_message(message)
        if envelope.command in {"agent_browser_tab_new", "tab_group_create"} or (
            envelope.command == "tab_manage" and envelope.params.get("action") == "new"
        ):
            raise SessionProtocolError(
                "SESSION_TRANSACTION_REQUIRED",
                f"{envelope.command} must use the Hub Session transaction API in V2",
                {"command": envelope.command, "sessionId": envelope.session_id},
            )
        handle = self.session_registry.get(envelope.session_id)
        self._validate_envelope_owner(envelope, handle)

        if handle.state != SessionState.ACTIVE.value:
            raise SessionProtocolError(
                "INVALID_SESSION_STATE",
                f"Session {handle.alias} is in state {handle.state}",
                {"sessionId": handle.session_id, "state": handle.state},
            )
        if envelope.session_revision != handle.revision:
            raise SessionProtocolError(
                "STALE_SESSION_REVISION",
                f"Session {handle.alias} revision changed",
                {
                    "sessionId": handle.session_id,
                    "expectedRevision": envelope.session_revision,
                    "actualRevision": handle.revision,
                },
            )
        if envelope.group_id != handle.group_id:
            raise SessionProtocolError(
                "GROUP_MISMATCH",
                f"group {envelope.group_id} does not belong to session {handle.alias}",
                {
                    "sessionId": handle.session_id,
                    "expectedGroupId": handle.group_id,
                    "actualGroupId": envelope.group_id,
                },
            )
        if envelope.tab_id is None:
            raise SessionProtocolError(
                "TAB_ID_REQUIRED",
                f"Session command {envelope.command} requires an explicit tabId",
                {"sessionId": handle.session_id, "command": envelope.command},
            )
        if self.session_registry.owner_of_tab(envelope.tab_id) != handle.session_id:
            raise SessionProtocolError(
                "TAB_OUTSIDE_SESSION",
                f"tab {envelope.tab_id} is outside session {handle.alias}",
                {"tabId": envelope.tab_id, "sessionId": handle.session_id},
            )

        await self._ensure_reconciled()
        handle = self.session_registry.get(envelope.session_id)
        self._validate_envelope_owner(envelope, handle)

        scope = self.session_registry.scope_payload(handle.session_id)
        params = dict(envelope.params)
        params["scope"] = {
            "session": scope["session"],
            "sessionId": scope["sessionId"],
            "groupId": scope["groupId"],
            "groupTitle": scope["groupTitle"],
            "allowedTabIds": scope["allowedTabIds"],
            "claimedTabIds": scope["claimedTabIds"],
            "mode": "session-v2",
        }
        params["sessionContext"] = {
            "sessionId": handle.session_id,
            "sessionAlias": handle.alias,
            "revision": handle.revision,
            "groupId": handle.group_id,
            "windowId": handle.window_id,
            "targetTabId": handle.target_tab_id,
            "tabId": envelope.tab_id,
            "allowedTabIds": scope["allowedTabIds"],
            "mode": "session-v2",
        }

        async with self.session_scheduler.session_operation(
            handle.session_id, envelope.operation_id
        ):
            handle = self.session_registry.get(envelope.session_id)
            self._validate_envelope_owner(envelope, handle)
            self._validate_expected_revision(handle, envelope.session_revision)
            if envelope.group_id != handle.group_id:
                raise SessionProtocolError(
                    "GROUP_MISMATCH",
                    f"group {envelope.group_id} does not belong to session {handle.alias}",
                    {"sessionId": handle.session_id, "expectedGroupId": handle.group_id, "actualGroupId": envelope.group_id},
                )
            if self.session_registry.owner_of_tab(envelope.tab_id) != handle.session_id:
                raise SessionProtocolError(
                    "TAB_OUTSIDE_SESSION",
                    f"tab {envelope.tab_id} is outside session {handle.alias}",
                    {"tabId": envelope.tab_id, "sessionId": handle.session_id},
                )
            scope = self.session_registry.scope_payload(handle.session_id)
            if (
                envelope.command == "agent_browser_tab_close"
                and envelope.tab_id in set(scope.get("claimedTabIds") or [])
            ):
                raise SessionProtocolError(
                    "CLAIMED_TAB_CLOSE_FORBIDDEN",
                    "Claimed user tabs must be released or finalized, not closed",
                    {"sessionId": handle.session_id, "tabId": envelope.tab_id},
                )
            params["scope"]["allowedTabIds"] = scope["allowedTabIds"]
            params["scope"]["claimedTabIds"] = scope["claimedTabIds"]
            params["sessionContext"].update({
                "revision": handle.revision,
                "targetTabId": handle.target_tab_id,
                "allowedTabIds": scope["allowedTabIds"],
            })
            async with self.session_scheduler.tab_operation(
                handle.session_id, envelope.tab_id
            ):
                if envelope.command in {
                    "clipboard_read",
                    "clipboard_write",
                    "browser.clipboard.read",
                    "browser.clipboard.write",
                }:
                    async with self.session_scheduler.resource_operation(
                        "browser-global:clipboard"
                    ):
                        data = await self.extension_ws.send_command(envelope.command, params)
                else:
                    data = await self.extension_ws.send_command(envelope.command, params)
                updated = handle
                if envelope.command == "agent_browser_tab_switch":
                    updated = await self.session_registry.set_target(
                        handle.session_id, envelope.tab_id, handle.revision, envelope.operation_id
                    )
                elif envelope.command == "agent_browser_tab_close":
                    updated = await self.session_registry.unregister_tab(
                        handle.session_id, envelope.tab_id, handle.revision, envelope.operation_id
                    )
        if updated.revision != handle.revision:
            self._persist_snapshot(updated.browser_epoch)
            data = {
                **data,
                "sessionRevision": updated.revision,
                "targetTabId": updated.target_tab_id,
                "tabIds": self.session_registry.scope_payload(updated.session_id)["allowedTabIds"],
            }
        return self._ok(envelope.request_id, data)

    @staticmethod
    def _validate_envelope_owner(envelope: SessionEnvelope, handle) -> None:
        if envelope.owner_id != handle.owner_id or envelope.adapter_id != handle.adapter_id:
            raise SessionProtocolError(
                "SESSION_OWNER_MISMATCH",
                f"Session {handle.alias} belongs to another owner",
                {
                    "sessionId": handle.session_id,
                    "ownerId": envelope.owner_id,
                    "adapterId": envelope.adapter_id,
                },
            )
        if envelope.session_alias != handle.alias:
            raise SessionProtocolError(
                "SESSION_ALIAS_MISMATCH",
                f"Session alias does not match sessionId {handle.session_id}",
                {
                    "sessionId": handle.session_id,
                    "expectedAlias": handle.alias,
                    "actualAlias": envelope.session_alias,
                },
            )

    def _persist_snapshot(self, browser_epoch: str | None) -> None:
        if self.session_store is None or not browser_epoch:
            return
        snapshot = self.session_registry.snapshot()
        snapshot["browserEpoch"] = browser_epoch
        self.session_store.save_snapshot(snapshot)

    def _session_payload(self, handle) -> dict[str, Any]:
        payload = handle.to_payload()
        try:
            scope = self.session_registry.scope_payload(handle.session_id)
        except SessionProtocolError:
            return payload
        payload["tabIds"] = list(scope.get("allowedTabIds") or [])
        payload["claimedTabIds"] = list(scope.get("claimedTabIds") or [])
        return payload

    @staticmethod
    def _validate_control_owner(handle, params: dict[str, Any]) -> None:
        owner_id = params.get("ownerId")
        adapter_id = params.get("adapterId")
        if owner_id != handle.owner_id or adapter_id != handle.adapter_id:
            raise SessionProtocolError(
                "SESSION_OWNER_MISMATCH",
                f"Session {handle.alias} belongs to another owner",
                {
                    "sessionId": handle.session_id,
                    "ownerId": owner_id,
                    "adapterId": adapter_id,
                },
            )

    @staticmethod
    def _validate_expected_revision(handle, expected_revision: int) -> None:
        if handle.revision != expected_revision:
            raise SessionProtocolError(
                "STALE_SESSION_REVISION",
                f"Session {handle.alias} revision changed",
                {
                    "sessionId": handle.session_id,
                    "expectedRevision": expected_revision,
                    "actualRevision": handle.revision,
                },
            )

    def _consume_claim_token(self, params: dict[str, Any], handle, tab_id: int) -> None:
        token = params.get("claimToken")
        record = self._claim_tokens.pop(token, None) if isinstance(token, str) else None
        if (
            record is None
            or record.get("ownerId") != handle.owner_id
            or record.get("adapterId") != handle.adapter_id
            or record.get("tabId") != tab_id
            or record.get("expiresAt", 0) < time.monotonic()
        ):
            raise SessionProtocolError(
                "INVALID_CLAIM_TOKEN",
                "A valid single-use claimToken is required for claiming a user tab",
                {"sessionId": handle.session_id, "tabId": tab_id},
            )

    @staticmethod
    def _require_text(params: dict[str, Any], field: str) -> str:
        value = params.get(field)
        if not isinstance(value, str) or not value:
            raise SessionProtocolError(
                "INVALID_SESSION_COMMAND",
                f"Session command requires {field}",
                {"field": field},
            )
        return value

    @staticmethod
    def _require_int(params: dict[str, Any], field: str) -> int:
        value = params.get(field)
        if isinstance(value, bool) or not isinstance(value, int):
            raise SessionProtocolError(
                "INVALID_SESSION_COMMAND",
                f"Session command requires integer {field}",
                {"field": field},
            )
        return value

    async def _acquire_lease(self, request_id: str | None, params: dict[str, Any]) -> dict[str, Any]:
        try:
            await asyncio.wait_for(self._operation_lock.acquire(), timeout=ACQUIRE_WAIT_TIMEOUT)
        except asyncio.TimeoutError as exc:
            self._release_expired_lease()
            if not self._operation_lock.locked():
                await self._operation_lock.acquire()
            else:
                raise TimeoutError(
                    f"Browser Hub 操作锁等待超时 ({ACQUIRE_WAIT_TIMEOUT}s), "
                    f"当前 lease={self._lease_name or 'unknown'}"
                ) from exc

        self._lease_token = str(uuid.uuid4())
        self._lease_name = params.get("name", "tool_call")
        self._lease_scope = {"session": params.get("session")} if params.get("session") else None
        self._lease_started_at = time.monotonic()
        self._lease_last_seen_at = self._lease_started_at
        return self._ok(
            request_id,
            {
                "lease_token": self._lease_token,
                "lease_name": self._lease_name,
            },
        )

    def _release_undelivered_lease(self, response: dict[str, Any]) -> None:
        if not response.get("success"):
            return
        data = response.get("data") or {}
        token = data.get("lease_token")
        if token and token == self._lease_token:
            logger.warning(f"客户端断开，释放未送达的 Browser Hub 操作锁: {self._lease_name}")
            self._release_current_lease()

    def _release_current_lease(self):
        self._lease_token = None
        self._lease_name = None
        self._lease_scope = None
        self._lease_started_at = None
        self._lease_last_seen_at = None
        if self._operation_lock.locked():
            self._operation_lock.release()

    def _release_expired_lease(self):
        if not self._lease_started_at:
            return
        now = time.monotonic()
        age = now - self._lease_started_at
        idle = now - (self._lease_last_seen_at or self._lease_started_at)
        if age <= LEASE_TIMEOUT and idle <= LEASE_IDLE_TIMEOUT:
            return
        logger.warning(
            f"Browser Hub 操作锁超时释放: {self._lease_name} "
            f"(age={age:.1f}s, idle={idle:.1f}s)"
        )
        self._release_current_lease()

    @staticmethod
    def _ok(request_id: str | None, data: dict[str, Any]) -> dict[str, Any]:
        return {
            "request_id": request_id,
            "success": True,
            "data": data,
        }


def main():
    default_db = Path.home() / "Library" / "Application Support" / "Link2Chrome" / "session-v2.sqlite3"
    database_path = os.getenv("LINK2CHROME_SESSION_DB", str(default_db))
    asyncio.run(BrowserHub(session_store=SessionStore(database_path)).run_forever())


if __name__ == "__main__":
    main()
