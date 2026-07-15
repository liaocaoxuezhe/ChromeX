"""Hub-authoritative Session, tab, and tab-group ownership registry."""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Set, Tuple

from server.session_protocol import SESSION_PROTOCOL_VERSION, SessionHandle, SessionProtocolError


class SessionState(str, Enum):
    CREATING = "CREATING"
    ACTIVE = "ACTIVE"
    FINALIZING = "FINALIZING"
    CLOSED = "CLOSED"
    ORPHANED = "ORPHANED"
    FAILED = "FAILED"


@dataclass
class SessionRecord:
    session_id: str
    owner_id: str
    adapter_id: str
    alias: str
    group_title: str
    protocol_version: int = SESSION_PROTOCOL_VERSION
    state: SessionState = SessionState.CREATING
    group_id: Optional[int] = None
    window_id: Optional[int] = None
    target_tab_id: Optional[int] = None
    revision: int = 0
    browser_epoch: Optional[str] = None
    tab_ids: Set[int] = field(default_factory=set)
    claimed_tab_ids: Set[int] = field(default_factory=set)
    claim_restore: Dict[int, Dict[str, Any]] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_handle(self) -> SessionHandle:
        return SessionHandle(
            session_id=self.session_id,
            owner_id=self.owner_id,
            adapter_id=self.adapter_id,
            alias=self.alias,
            group_id=self.group_id,
            group_title=self.group_title,
            window_id=self.window_id,
            target_tab_id=self.target_tab_id,
            revision=self.revision,
            state=self.state.value,
            browser_epoch=self.browser_epoch,
        )


OperationFingerprint = Tuple[Any, ...]
OperationResult = Tuple[OperationFingerprint, SessionHandle]


class SessionRegistry:
    """The only component allowed to decide Session ownership.

    Adapter-local SessionManager instances may cache returned handles for public
    API compatibility, but they must not create independent ownership records.
    """

    def __init__(self, id_factory: Optional[Callable[[], str]] = None) -> None:
        self._id_factory = id_factory or (lambda: str(uuid.uuid4()))
        self._sessions: Dict[str, SessionRecord] = {}
        self._session_by_owner_alias: Dict[Tuple[str, str], str] = {}
        self._session_by_group: Dict[int, str] = {}
        self._session_by_tab: Dict[int, str] = {}
        self._operation_results: Dict[str, OperationResult] = {}
        # BrowserHub is constructed before ``asyncio.run`` enters its event
        # loop. Python 3.9 therefore requires lazy creation of asyncio
        # primitives instead of constructing them in this initializer.
        self._lock: Optional[asyncio.Lock] = None

    async def create(
        self,
        owner_id: str,
        adapter_id: str,
        alias: str,
        group_title: str,
        operation_id: str,
    ) -> SessionHandle:
        fingerprint = self._fingerprint(
            "create", owner_id, adapter_id, alias, group_title
        )
        async with self._mutation_lock():
            replay = self._replay(operation_id, fingerprint)
            if replay is not None:
                return replay

            identity = (owner_id, alias)
            existing_id = self._session_by_owner_alias.get(identity)
            if existing_id is not None:
                handle = self._sessions[existing_id].to_handle()
                self._record_operation(operation_id, fingerprint, handle)
                return handle

            session_id = self._id_factory()
            if not isinstance(session_id, str) or not session_id:
                raise ValueError("Session id factory must return a non-empty string")
            if session_id in self._sessions:
                raise SessionProtocolError(
                    "SESSION_ID_CONFLICT",
                    f"Session id already exists: {session_id}",
                    {"sessionId": session_id},
                )

            record = SessionRecord(
                session_id=session_id,
                owner_id=owner_id,
                adapter_id=adapter_id,
                alias=alias,
                group_title=group_title,
            )
            self._sessions[session_id] = record
            self._session_by_owner_alias[identity] = session_id
            handle = record.to_handle()
            self._record_operation(operation_id, fingerprint, handle)
            return handle

    async def bind_group(
        self,
        session_id: str,
        group_id: int,
        window_id: int,
        seed_tab_id: int,
        browser_epoch: str,
        expected_revision: int,
        operation_id: str,
    ) -> SessionHandle:
        fingerprint = self._fingerprint(
            "bind_group",
            session_id,
            group_id,
            window_id,
            seed_tab_id,
            browser_epoch,
            expected_revision,
        )
        async with self._mutation_lock():
            replay = self._replay(operation_id, fingerprint)
            if replay is not None:
                return replay
            record = self._require_session(session_id)
            self._require_revision(record, expected_revision)
            self._require_state(record, {SessionState.CREATING})

            group_owner = self._session_by_group.get(group_id)
            if group_owner is not None and group_owner != session_id:
                raise SessionProtocolError(
                    "GROUP_ALREADY_OWNED",
                    f"group {group_id} is already owned by another session",
                    {"groupId": group_id, "sessionId": group_owner},
                )
            tab_owner = self._session_by_tab.get(seed_tab_id)
            if tab_owner is not None and tab_owner != session_id:
                raise SessionProtocolError(
                    "TAB_ALREADY_OWNED",
                    f"tab {seed_tab_id} is already owned by another session",
                    {"tabId": seed_tab_id, "sessionId": tab_owner},
                )

            record.group_id = group_id
            record.window_id = window_id
            record.target_tab_id = seed_tab_id
            record.browser_epoch = browser_epoch
            record.tab_ids.add(seed_tab_id)
            record.state = SessionState.ACTIVE
            self._session_by_group[group_id] = session_id
            self._session_by_tab[seed_tab_id] = session_id
            self._touch(record)
            handle = record.to_handle()
            self._record_operation(operation_id, fingerprint, handle)
            return handle

    async def claim_tab(
        self,
        session_id: str,
        tab_id: int,
        expected_revision: int,
        operation_id: str,
        restore: Optional[Mapping[str, Any]] = None,
    ) -> SessionHandle:
        fingerprint = self._fingerprint(
            "claim_tab", session_id, tab_id, expected_revision, restore or {}
        )
        async with self._mutation_lock():
            replay = self._replay(operation_id, fingerprint)
            if replay is not None:
                return replay
            record = self._require_session(session_id)
            self._require_revision(record, expected_revision)
            self._require_state(record, {SessionState.ACTIVE})

            owner = self._session_by_tab.get(tab_id)
            if owner is not None and owner != session_id:
                raise SessionProtocolError(
                    "TAB_ALREADY_OWNED",
                    f"tab {tab_id} is already owned by another session",
                    {"tabId": tab_id, "sessionId": owner},
                )
            if tab_id not in record.tab_ids:
                record.tab_ids.add(tab_id)
                record.claimed_tab_ids.add(tab_id)
                record.claim_restore[tab_id] = dict(restore or {})
                self._session_by_tab[tab_id] = session_id
                self._touch(record)

            handle = record.to_handle()
            self._record_operation(operation_id, fingerprint, handle)
            return handle

    async def register_tab(
        self,
        session_id: str,
        tab_id: int,
        expected_revision: int,
        operation_id: str,
        set_target: bool = True,
    ) -> SessionHandle:
        fingerprint = self._fingerprint(
            "register_tab", session_id, tab_id, expected_revision, set_target
        )
        async with self._mutation_lock():
            replay = self._replay(operation_id, fingerprint)
            if replay is not None:
                return replay
            record = self._require_session(session_id)
            self._require_revision(record, expected_revision)
            self._require_state(record, {SessionState.ACTIVE})

            owner = self._session_by_tab.get(tab_id)
            if owner is not None and owner != session_id:
                raise SessionProtocolError(
                    "TAB_ALREADY_OWNED",
                    f"tab {tab_id} is already owned by another session",
                    {"tabId": tab_id, "sessionId": owner},
                )
            if tab_id not in record.tab_ids:
                record.tab_ids.add(tab_id)
                self._session_by_tab[tab_id] = session_id
                if set_target:
                    record.target_tab_id = tab_id
                self._touch(record)

            handle = record.to_handle()
            self._record_operation(operation_id, fingerprint, handle)
            return handle

    async def release_tab(
        self,
        session_id: str,
        tab_id: int,
        expected_revision: int,
        operation_id: str,
    ) -> SessionHandle:
        fingerprint = self._fingerprint(
            "release_tab", session_id, tab_id, expected_revision
        )
        async with self._mutation_lock():
            replay = self._replay(operation_id, fingerprint)
            if replay is not None:
                return replay
            record = self._require_session(session_id)
            self._require_revision(record, expected_revision)
            self._require_state(record, {SessionState.ACTIVE, SessionState.FINALIZING})
            if tab_id not in record.claimed_tab_ids:
                raise SessionProtocolError(
                    "TAB_NOT_CLAIMED",
                    f"tab {tab_id} is not a claimed tab in session {record.alias}",
                    {"tabId": tab_id, "sessionId": session_id},
                )

            record.claimed_tab_ids.remove(tab_id)
            record.tab_ids.discard(tab_id)
            record.claim_restore.pop(tab_id, None)
            if self._session_by_tab.get(tab_id) == session_id:
                self._session_by_tab.pop(tab_id, None)
            if record.target_tab_id == tab_id:
                record.target_tab_id = min(record.tab_ids) if record.tab_ids else None
            self._touch(record)
            handle = record.to_handle()
            self._record_operation(operation_id, fingerprint, handle)
            return handle

    async def unregister_tab(
        self, session_id: str, tab_id: int, expected_revision: int, operation_id: str
    ) -> SessionHandle:
        fingerprint = self._fingerprint("unregister_tab", session_id, tab_id, expected_revision)
        async with self._mutation_lock():
            replay = self._replay(operation_id, fingerprint)
            if replay is not None:
                return replay
            record = self._require_session(session_id)
            self._require_revision(record, expected_revision)
            if tab_id in record.tab_ids:
                record.tab_ids.discard(tab_id)
                record.claimed_tab_ids.discard(tab_id)
                record.claim_restore.pop(tab_id, None)
                if self._session_by_tab.get(tab_id) == session_id:
                    self._session_by_tab.pop(tab_id, None)
                if record.target_tab_id == tab_id:
                    record.target_tab_id = min(record.tab_ids) if record.tab_ids else None
                self._touch(record)
            handle = record.to_handle()
            self._record_operation(operation_id, fingerprint, handle)
            return handle

    async def set_target(
        self,
        session_id: str,
        tab_id: int,
        expected_revision: int,
        operation_id: str,
    ) -> SessionHandle:
        fingerprint = self._fingerprint(
            "set_target", session_id, tab_id, expected_revision
        )
        async with self._mutation_lock():
            replay = self._replay(operation_id, fingerprint)
            if replay is not None:
                return replay
            record = self._require_session(session_id)
            self._require_revision(record, expected_revision)
            self._require_state(record, {SessionState.ACTIVE})
            if self._session_by_tab.get(tab_id) != session_id:
                raise SessionProtocolError(
                    "TAB_OUTSIDE_SESSION",
                    f"tab {tab_id} is outside session {record.alias}",
                    {"tabId": tab_id, "sessionId": session_id},
                )
            record.target_tab_id = tab_id
            self._touch(record)
            handle = record.to_handle()
            self._record_operation(operation_id, fingerprint, handle)
            return handle

    async def begin_finalize(
        self,
        session_id: str,
        expected_revision: int,
        operation_id: str,
    ) -> SessionHandle:
        return await self._transition(
            "begin_finalize",
            session_id,
            expected_revision,
            operation_id,
            {SessionState.ACTIVE},
            SessionState.FINALIZING,
            cleanup_ownership=False,
            remove_alias=False,
        )

    async def close(
        self,
        session_id: str,
        expected_revision: int,
        operation_id: str,
    ) -> SessionHandle:
        return await self._transition(
            "close",
            session_id,
            expected_revision,
            operation_id,
            {
                SessionState.CREATING,
                SessionState.ACTIVE,
                SessionState.FINALIZING,
                SessionState.ORPHANED,
                SessionState.FAILED,
            },
            SessionState.CLOSED,
            cleanup_ownership=True,
            remove_alias=True,
        )

    async def orphan(
        self,
        session_id: str,
        expected_revision: int,
        operation_id: str,
    ) -> SessionHandle:
        return await self._transition(
            "orphan",
            session_id,
            expected_revision,
            operation_id,
            {SessionState.CREATING, SessionState.ACTIVE, SessionState.FINALIZING},
            SessionState.ORPHANED,
            cleanup_ownership=True,
            remove_alias=False,
        )

    async def _transition(
        self,
        name: str,
        session_id: str,
        expected_revision: int,
        operation_id: str,
        allowed_states: Set[SessionState],
        next_state: SessionState,
        cleanup_ownership: bool,
        remove_alias: bool,
    ) -> SessionHandle:
        fingerprint = self._fingerprint(
            name, session_id, expected_revision, next_state.value
        )
        async with self._mutation_lock():
            replay = self._replay(operation_id, fingerprint)
            if replay is not None:
                return replay
            record = self._require_session(session_id)
            self._require_revision(record, expected_revision)
            self._require_state(record, allowed_states)

            if cleanup_ownership:
                self._remove_ownership(record)
            if remove_alias:
                identity = (record.owner_id, record.alias)
                if self._session_by_owner_alias.get(identity) == session_id:
                    self._session_by_owner_alias.pop(identity, None)
            record.state = next_state
            self._touch(record)
            handle = record.to_handle()
            self._record_operation(operation_id, fingerprint, handle)
            return handle

    def resolve(self, owner_id: str, alias: str) -> Optional[SessionHandle]:
        session_id = self._session_by_owner_alias.get((owner_id, alias))
        if session_id is None:
            return None
        return self._sessions[session_id].to_handle()

    def get(self, session_id: str) -> SessionHandle:
        return self._require_session(session_id).to_handle()

    def list_sessions(self, include_closed: bool = False) -> List[SessionHandle]:
        records: Iterable[SessionRecord] = self._sessions.values()
        if not include_closed:
            records = (record for record in records if record.state != SessionState.CLOSED)
        return [record.to_handle() for record in records]

    def owner_of_group(self, group_id: int) -> Optional[str]:
        return self._session_by_group.get(group_id)

    def owner_of_tab(self, tab_id: int) -> Optional[str]:
        return self._session_by_tab.get(tab_id)

    def scope_payload(self, session_id: str) -> Dict[str, Any]:
        record = self._require_session(session_id)
        return {
            "session": record.alias,
            "sessionId": record.session_id,
            "groupId": record.group_id,
            "groupTitle": record.group_title,
            "windowId": record.window_id,
            "targetTabId": record.target_tab_id,
            "allowedTabIds": sorted(record.tab_ids),
            "claimedTabIds": sorted(record.claimed_tab_ids),
            "revision": record.revision,
            "mode": "session-v2",
        }

    def preflight_operation(
        self, operation_id: str, *fingerprint_prefix: Any
    ) -> Optional[SessionHandle]:
        """Reject operationId reuse before any external Chrome mutation.

        Claim restore metadata is learned from Chrome, so callers may validate
        the stable fingerprint prefix before the full Registry commit.
        """
        previous = self._operation_results.get(operation_id)
        if previous is None:
            return None
        previous_fingerprint, previous_result = previous
        expected_prefix = self._fingerprint(*fingerprint_prefix)
        if previous_fingerprint[: len(expected_prefix)] != expected_prefix:
            raise SessionProtocolError(
                "OPERATION_ID_CONFLICT",
                f"operationId {operation_id} was already used for another mutation",
                {"operationId": operation_id},
            )
        return previous_result

    def _mutation_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def snapshot(self) -> Dict[str, Any]:
        return {
            "sessions": [
                {
                    **record.to_handle().to_payload(),
                    "tabIds": sorted(record.tab_ids),
                    "claimedTabIds": sorted(record.claimed_tab_ids),
                    "claimRestore": {
                        str(tab_id): dict(restore)
                        for tab_id, restore in record.claim_restore.items()
                    },
                    "createdAt": record.created_at,
                    "updatedAt": record.updated_at,
                }
                for record in self._sessions.values()
            ],
            "groupOwners": {
                str(group_id): session_id
                for group_id, session_id in self._session_by_group.items()
            },
            "tabOwners": {
                str(tab_id): session_id
                for tab_id, session_id in self._session_by_tab.items()
            },
        }

    def restore_snapshot(self, snapshot: Mapping[str, Any], browser_epoch: str) -> int:
        """Restore an exact-epoch snapshot into an empty Registry."""
        if snapshot.get("browserEpoch") != browser_epoch:
            raise SessionProtocolError(
                "BROWSER_EPOCH_MISMATCH",
                "Runtime Chrome IDs cannot be restored across browser epochs",
                {"expected": browser_epoch, "actual": snapshot.get("browserEpoch")},
            )
        if self._sessions:
            raise SessionProtocolError("REGISTRY_NOT_EMPTY", "Cannot restore into a live Registry")

        sessions: Dict[str, SessionRecord] = {}
        aliases: Dict[Tuple[str, str], str] = {}
        groups: Dict[int, str] = {}
        tabs: Dict[int, str] = {}
        for raw in snapshot.get("sessions") or []:
            if raw.get("protocolVersion", SESSION_PROTOCOL_VERSION) != SESSION_PROTOCOL_VERSION:
                raise SessionProtocolError(
                    "SESSION_PROTOCOL_MISMATCH",
                    "Persisted Session protocol cannot change during recovery",
                    {
                        "sessionId": raw.get("sessionId"),
                        "protocolVersion": raw.get("protocolVersion"),
                    },
                )
            state = SessionState(raw.get("state", SessionState.ORPHANED.value))
            record = SessionRecord(
                session_id=str(raw["sessionId"]),
                owner_id=str(raw["ownerId"]),
                adapter_id=str(raw["adapterId"]),
                alias=str(raw["session"]),
                group_title=str(raw.get("groupTitle") or raw["session"]),
                state=state,
                group_id=raw.get("groupId"),
                window_id=raw.get("windowId"),
                target_tab_id=raw.get("targetTabId"),
                revision=int(raw.get("revision", 0)),
                browser_epoch=browser_epoch,
                tab_ids={int(value) for value in raw.get("tabIds") or []},
                claimed_tab_ids={int(value) for value in raw.get("claimedTabIds") or []},
                claim_restore={int(key): dict(value) for key, value in (raw.get("claimRestore") or {}).items()},
                created_at=float(raw.get("createdAt", time.time())),
                updated_at=float(raw.get("updatedAt", time.time())),
            )
            identity = (record.owner_id, record.alias)
            if record.session_id in sessions or identity in aliases:
                raise SessionProtocolError("SNAPSHOT_OWNERSHIP_CONFLICT", "Duplicate Session identity in snapshot")
            if record.group_id is not None and record.group_id in groups:
                raise SessionProtocolError("SNAPSHOT_OWNERSHIP_CONFLICT", "Duplicate group owner in snapshot")
            for tab_id in record.tab_ids:
                if tab_id in tabs:
                    raise SessionProtocolError("SNAPSHOT_OWNERSHIP_CONFLICT", "Duplicate tab owner in snapshot")
                tabs[tab_id] = record.session_id
            sessions[record.session_id] = record
            aliases[identity] = record.session_id
            if record.group_id is not None:
                groups[record.group_id] = record.session_id

        self._sessions = sessions
        self._session_by_owner_alias = aliases
        self._session_by_group = groups
        self._session_by_tab = tabs
        return len(sessions)

    def _remove_ownership(self, record: SessionRecord) -> None:
        if record.group_id is not None and self._session_by_group.get(record.group_id) == record.session_id:
            self._session_by_group.pop(record.group_id, None)
        for tab_id in tuple(record.tab_ids):
            if self._session_by_tab.get(tab_id) == record.session_id:
                self._session_by_tab.pop(tab_id, None)
        record.tab_ids.clear()
        record.claimed_tab_ids.clear()
        record.claim_restore.clear()
        record.group_id = None
        record.window_id = None
        record.target_tab_id = None

    def _require_session(self, session_id: str) -> SessionRecord:
        record = self._sessions.get(session_id)
        if record is None:
            raise SessionProtocolError(
                "SESSION_NOT_FOUND",
                f"Session '{session_id}' does not exist",
                {"sessionId": session_id},
            )
        return record

    @staticmethod
    def _require_revision(record: SessionRecord, expected_revision: int) -> None:
        if record.revision != expected_revision:
            raise SessionProtocolError(
                "STALE_SESSION_REVISION",
                f"Session {record.alias} revision changed",
                {
                    "sessionId": record.session_id,
                    "expectedRevision": expected_revision,
                    "actualRevision": record.revision,
                },
            )

    @staticmethod
    def _require_state(record: SessionRecord, allowed: Set[SessionState]) -> None:
        if record.state not in allowed:
            raise SessionProtocolError(
                "INVALID_SESSION_STATE",
                f"Session {record.alias} is in state {record.state.value}",
                {
                    "sessionId": record.session_id,
                    "state": record.state.value,
                    "allowedStates": sorted(state.value for state in allowed),
                },
            )

    @staticmethod
    def _touch(record: SessionRecord) -> None:
        record.revision += 1
        record.updated_at = time.time()

    def _replay(
        self, operation_id: str, fingerprint: OperationFingerprint
    ) -> Optional[SessionHandle]:
        previous = self._operation_results.get(operation_id)
        if previous is None:
            return None
        previous_fingerprint, previous_result = previous
        if previous_fingerprint != fingerprint:
            raise SessionProtocolError(
                "OPERATION_ID_CONFLICT",
                f"operationId {operation_id} was already used for another mutation",
                {"operationId": operation_id},
            )
        return previous_result

    def _record_operation(
        self,
        operation_id: str,
        fingerprint: OperationFingerprint,
        result: SessionHandle,
    ) -> None:
        self._operation_results[operation_id] = (fingerprint, result)

    @classmethod
    def _fingerprint(cls, *values: Any) -> OperationFingerprint:
        return tuple(cls._freeze(value) for value in values)

    @classmethod
    def _freeze(cls, value: Any) -> Any:
        if isinstance(value, Mapping):
            return tuple(
                sorted((str(key), cls._freeze(item)) for key, item in value.items())
            )
        if isinstance(value, (list, tuple, set, frozenset)):
            return tuple(cls._freeze(item) for item in value)
        return value
