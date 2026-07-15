"""Keyed concurrency control for isolated browser Sessions."""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, Hashable, Optional, Tuple


@dataclass
class _LockEntry:
    lock: asyncio.Lock
    users: int = 0


class SessionScheduler:
    """Serialize one Session while allowing independent Sessions to overlap."""

    def __init__(self, max_concurrent_sessions: int = 8) -> None:
        if max_concurrent_sessions < 1:
            raise ValueError("max_concurrent_sessions must be at least 1")
        self.max_concurrent_sessions = max_concurrent_sessions
        self._session_lanes: Dict[str, _LockEntry] = {}
        self._tab_locks: Dict[Tuple[str, int], _LockEntry] = {}
        self._resource_locks: Dict[str, _LockEntry] = {}
        self._pool_guard: Optional[asyncio.Lock] = None
        self._session_slots: Optional[asyncio.Semaphore] = None
        self._in_flight_operations: Dict[str, str] = {}
        self._last_queue_wait_ms: Dict[str, float] = {}

    @asynccontextmanager
    async def session_operation(
        self, session_id: str, operation_id: str
    ) -> AsyncIterator[None]:
        if not session_id:
            raise ValueError("session_id is required")
        if not operation_id:
            raise ValueError("operation_id is required")

        queued_at = time.monotonic()
        async with self._keyed_lock(self._session_lanes, session_id):
            semaphore = self._get_session_slots()
            await semaphore.acquire()
            queue_wait_ms = (time.monotonic() - queued_at) * 1000
            self._last_queue_wait_ms[session_id] = queue_wait_ms
            self._in_flight_operations[session_id] = operation_id
            try:
                yield
            finally:
                if self._in_flight_operations.get(session_id) == operation_id:
                    self._in_flight_operations.pop(session_id, None)
                semaphore.release()

    @asynccontextmanager
    async def tab_operation(
        self, session_id: str, tab_id: int
    ) -> AsyncIterator[None]:
        if not session_id:
            raise ValueError("session_id is required")
        if isinstance(tab_id, bool) or not isinstance(tab_id, int):
            raise ValueError("tab_id must be an integer")
        async with self._keyed_lock(self._tab_locks, (session_id, tab_id)):
            yield

    @asynccontextmanager
    async def resource_operation(self, resource_name: str) -> AsyncIterator[None]:
        if not resource_name:
            raise ValueError("resource_name is required")
        async with self._keyed_lock(self._resource_locks, resource_name):
            yield

    def snapshot(self) -> Dict[str, Any]:
        return {
            "maxConcurrentSessions": self.max_concurrent_sessions,
            "inFlightSessions": len(self._in_flight_operations),
            "inFlightOperations": dict(self._in_flight_operations),
            "lastQueueWaitMs": {
                key: round(value, 3)
                for key, value in self._last_queue_wait_ms.items()
            },
            "sessionLanes": self._pool_snapshot(self._session_lanes),
            "tabLocks": self._pool_snapshot(self._tab_locks),
            "resourceLocks": self._pool_snapshot(self._resource_locks),
        }

    @asynccontextmanager
    async def _keyed_lock(
        self,
        pool: Dict[Hashable, _LockEntry],
        key: Hashable,
    ) -> AsyncIterator[None]:
        entry = await self._retain_entry(pool, key)
        acquired = False
        try:
            await entry.lock.acquire()
            acquired = True
            yield
        finally:
            if acquired:
                entry.lock.release()
            await self._release_entry(pool, key, entry)

    async def _retain_entry(
        self,
        pool: Dict[Hashable, _LockEntry],
        key: Hashable,
    ) -> _LockEntry:
        async with self._get_pool_guard():
            entry = pool.get(key)
            if entry is None:
                entry = _LockEntry(lock=asyncio.Lock())
                pool[key] = entry
            entry.users += 1
            return entry

    async def _release_entry(
        self,
        pool: Dict[Hashable, _LockEntry],
        key: Hashable,
        entry: _LockEntry,
    ) -> None:
        async with self._get_pool_guard():
            entry.users -= 1
            if entry.users == 0 and not entry.lock.locked() and pool.get(key) is entry:
                pool.pop(key, None)

    def _get_pool_guard(self) -> asyncio.Lock:
        # Lazy for Python 3.9: BrowserHub may construct this scheduler before
        # asyncio.run installs the process event loop.
        if self._pool_guard is None:
            self._pool_guard = asyncio.Lock()
        return self._pool_guard

    def _get_session_slots(self) -> asyncio.Semaphore:
        if self._session_slots is None:
            self._session_slots = asyncio.Semaphore(self.max_concurrent_sessions)
        return self._session_slots

    @staticmethod
    def _pool_snapshot(pool: Dict[Hashable, _LockEntry]) -> Dict[str, Any]:
        return {
            str(key): {
                "locked": entry.lock.locked(),
                "users": entry.users,
                "waiters": max(0, entry.users - (1 if entry.lock.locked() else 0)),
            }
            for key, entry in pool.items()
        }
