"""Versioned protocol types for Hub-owned browser sessions.

The public MCP surface continues to use a human-readable ``session`` alias.
These types are for the internal Adapter -> Hub -> Extension boundary, where
every operation must carry an unambiguous owner and opaque session identity.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional


SESSION_PROTOCOL_VERSION = 2


class SessionProtocolError(RuntimeError):
    """A compatible text error with a stable machine-readable code."""

    def __init__(
        self,
        code: str,
        message: str,
        details: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details: Dict[str, Any] = dict(details or {})

    def to_payload(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "ok": False,
            "error": self.message,
            "code": self.code,
        }
        if self.details:
            payload["details"] = dict(self.details)
        return payload


@dataclass(frozen=True)
class SessionHandle:
    """Immutable identity and current Hub-authoritative session binding."""

    session_id: str
    owner_id: str
    adapter_id: str
    alias: str
    group_id: Optional[int]
    group_title: str
    window_id: Optional[int]
    target_tab_id: Optional[int]
    revision: int
    state: str
    browser_epoch: Optional[str]

    def to_payload(self) -> Dict[str, Any]:
        return {
            "session": self.alias,
            "sessionId": self.session_id,
            "ownerId": self.owner_id,
            "adapterId": self.adapter_id,
            "groupId": self.group_id,
            "groupTitle": self.group_title,
            "windowId": self.window_id,
            "targetTabId": self.target_tab_id,
            "revision": self.revision,
            "state": self.state,
            "browserEpoch": self.browser_epoch,
            "protocolVersion": SESSION_PROTOCOL_VERSION,
        }


@dataclass(frozen=True)
class SessionEnvelope:
    """Validated V2 command envelope sent across internal process boundaries."""

    request_id: str
    operation_id: str
    adapter_id: str
    owner_id: str
    session_id: str
    session_alias: str
    session_revision: int
    group_id: Optional[int]
    tab_id: Optional[int]
    command: str
    params: Dict[str, Any]
    protocol_version: int = SESSION_PROTOCOL_VERSION

    @classmethod
    def from_message(cls, message: Mapping[str, Any]) -> "SessionEnvelope":
        if not isinstance(message, Mapping):
            raise SessionProtocolError(
                "INVALID_ENVELOPE",
                "Session command envelope must be an object",
                {"field": "message"},
            )

        actual_version = message.get("protocolVersion")
        if actual_version != SESSION_PROTOCOL_VERSION:
            raise SessionProtocolError(
                "UNSUPPORTED_PROTOCOL_VERSION",
                f"Unsupported session protocol version: {actual_version}",
                {"expected": SESSION_PROTOCOL_VERSION, "actual": actual_version},
            )

        required_fields = (
            "requestId",
            "operationId",
            "adapterId",
            "ownerId",
            "sessionId",
            "sessionAlias",
            "sessionRevision",
            "command",
            "params",
        )
        missing_fields = [
            field
            for field in required_fields
            if field not in message or message.get(field) is None
        ]
        if missing_fields:
            raise SessionProtocolError(
                "INVALID_ENVELOPE",
                "Session command envelope is missing required fields",
                {"missingFields": missing_fields},
            )

        for field in (
            "requestId",
            "operationId",
            "adapterId",
            "ownerId",
            "sessionId",
            "sessionAlias",
            "command",
        ):
            value = message[field]
            if not isinstance(value, str) or not value.strip():
                cls._raise_invalid_field(field, "must be a non-empty string")

        revision = message["sessionRevision"]
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            cls._raise_invalid_field("sessionRevision", "must be a non-negative integer")

        group_id = cls._optional_integer(message, "groupId")
        tab_id = cls._optional_integer(message, "tabId")

        params = message["params"]
        if not isinstance(params, Mapping):
            cls._raise_invalid_field("params", "must be an object")

        return cls(
            request_id=message["requestId"],
            operation_id=message["operationId"],
            adapter_id=message["adapterId"],
            owner_id=message["ownerId"],
            session_id=message["sessionId"],
            session_alias=message["sessionAlias"],
            session_revision=revision,
            group_id=group_id,
            tab_id=tab_id,
            command=message["command"],
            params=dict(params),
        )

    @staticmethod
    def _optional_integer(message: Mapping[str, Any], field: str) -> Optional[int]:
        value = message.get(field)
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            SessionEnvelope._raise_invalid_field(field, "must be an integer or null")
        return value

    @staticmethod
    def _raise_invalid_field(field: str, reason: str) -> None:
        raise SessionProtocolError(
            "INVALID_ENVELOPE",
            f"Invalid Session command envelope field {field}: {reason}",
            {"field": field, "reason": reason},
        )

    def to_message(self) -> Dict[str, Any]:
        return {
            "protocolVersion": self.protocol_version,
            "requestId": self.request_id,
            "operationId": self.operation_id,
            "adapterId": self.adapter_id,
            "ownerId": self.owner_id,
            "sessionId": self.session_id,
            "sessionAlias": self.session_alias,
            "sessionRevision": self.session_revision,
            "groupId": self.group_id,
            "tabId": self.tab_id,
            "command": self.command,
            "params": dict(self.params),
        }
