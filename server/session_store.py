"""Durable SQLite journal for Hub Session ownership snapshots."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Union

from server.session_protocol import SessionProtocolError


SCHEMA_VERSION = 1
PathLike = Union[str, Path]


class SessionStore:
    """Small single-writer store owned by BrowserHub.

    Runtime tab/group IDs are persisted only with their browser epoch. A new
    Chrome epoch invalidates those IDs instead of attempting title-based
    recovery.
    """

    def __init__(self, database_path: PathLike) -> None:
        self.database_path = Path(database_path).expanduser().resolve()
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def save_snapshot(self, snapshot: Mapping[str, Any]) -> None:
        browser_epoch = self._require_browser_epoch(snapshot)
        payload_json = self._canonical_json(snapshot)
        now = time.time()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO snapshots(browser_epoch, payload_json, status, updated_at)
                VALUES (?, ?, 'ACTIVE', ?)
                ON CONFLICT(browser_epoch) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    status = excluded.status,
                    updated_at = excluded.updated_at
                """,
                (browser_epoch, payload_json, now),
            )

    def load_snapshot(self, browser_epoch: str) -> Optional[Dict[str, Any]]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM snapshots WHERE browser_epoch = ?",
                (browser_epoch,),
            ).fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    def mark_epoch_orphaned(self, browser_epoch: str) -> Optional[Dict[str, Any]]:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT payload_json FROM snapshots WHERE browser_epoch = ?",
                (browser_epoch,),
            ).fetchone()
            if row is None:
                return None

            snapshot = json.loads(row[0])
            for session in snapshot.get("sessions", []):
                if session.get("state") == "CLOSED":
                    continue
                session["state"] = "ORPHANED"
                session["groupId"] = None
                session["windowId"] = None
                session["targetTabId"] = None
                session["tabIds"] = []
                session["claimedTabIds"] = []
                session["claimRestore"] = {}
                revision = session.get("revision", 0)
                session["revision"] = revision + 1 if isinstance(revision, int) else 1
            snapshot["groupOwners"] = {}
            snapshot["tabOwners"] = {}

            connection.execute(
                """
                UPDATE snapshots
                SET payload_json = ?, status = 'ORPHANED', updated_at = ?
                WHERE browser_epoch = ?
                """,
                (self._canonical_json(snapshot), time.time(), browser_epoch),
            )
            return snapshot

    def record_operation(
        self,
        operation_id: str,
        fingerprint: Mapping[str, Any],
        result: Mapping[str, Any],
    ) -> Dict[str, Any]:
        if not operation_id:
            raise ValueError("operation_id is required")
        fingerprint_json = self._canonical_json(fingerprint)
        result_json = self._canonical_json(result)

        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT fingerprint_json, result_json
                FROM operations
                WHERE operation_id = ?
                """,
                (operation_id,),
            ).fetchone()
            if row is not None:
                previous_fingerprint, previous_result = row
                if previous_fingerprint != fingerprint_json:
                    raise SessionProtocolError(
                        "OPERATION_ID_CONFLICT",
                        f"operationId {operation_id} was already used for another mutation",
                        {"operationId": operation_id},
                    )
                return json.loads(previous_result)

            connection.execute(
                """
                INSERT INTO operations(
                    operation_id, fingerprint_json, result_json, created_at
                ) VALUES (?, ?, ?, ?)
                """,
                (operation_id, fingerprint_json, result_json, time.time()),
            )
            return json.loads(result_json)

    def load_operation(self, operation_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT result_json FROM operations WHERE operation_id = ?",
                (operation_id,),
            ).fetchone()
        return json.loads(row[0]) if row is not None else None

    def has_active_v2_sessions(self, browser_epoch: str | None = None) -> bool:
        with self._connect() as connection:
            if browser_epoch:
                rows = connection.execute(
                    "SELECT payload_json FROM snapshots WHERE status = 'ACTIVE' AND browser_epoch = ?",
                    (browser_epoch,),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT payload_json FROM snapshots WHERE status = 'ACTIVE'"
                ).fetchall()
        for (payload_json,) in rows:
            snapshot = json.loads(payload_json)
            if any(
                item.get("state") in {"CREATING", "ACTIVE", "FINALIZING"}
                and item.get("protocolVersion", 2) == 2
                for item in snapshot.get("sessions") or []
            ):
                return True
        return False

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS snapshots (
                    browser_epoch TEXT PRIMARY KEY,
                    payload_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS operations (
                    operation_id TEXT PRIMARY KEY,
                    fingerprint_json TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                """
            )
            connection.execute(
                """
                INSERT INTO metadata(key, value)
                VALUES ('schema_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (str(SCHEMA_VERSION),),
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.database_path), timeout=5.0)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @staticmethod
    def _canonical_json(value: Mapping[str, Any]) -> str:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    @staticmethod
    def _require_browser_epoch(snapshot: Mapping[str, Any]) -> str:
        if not isinstance(snapshot, Mapping):
            raise SessionProtocolError(
                "INVALID_SESSION_SNAPSHOT",
                "Session snapshot must be an object",
                {"field": "snapshot"},
            )
        browser_epoch = snapshot.get("browserEpoch")
        if not isinstance(browser_epoch, str) or not browser_epoch:
            raise SessionProtocolError(
                "INVALID_SESSION_SNAPSHOT",
                "Session snapshot requires browserEpoch",
                {"field": "browserEpoch"},
            )
        return browser_epoch
