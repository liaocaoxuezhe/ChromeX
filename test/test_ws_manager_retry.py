# -*- coding: utf-8 -*-

import asyncio

import pytest

from server.ws_manager import WSManager


class FakeConnection:
    def __init__(self, manager, result=None, fail=False):
        self.manager = manager
        self.result = result or {}
        self.fail = fail
        self.sent = []

    async def send(self, message):
        self.sent.append(message)
        futures = list(self.manager._pending_requests.values())
        assert futures
        future = futures[-1]
        if self.fail:
            future.set_exception(ConnectionError("Extension 连接已断开"))
        else:
            future.set_result({"success": True, "data": self.result})


class DuplicateConnection:
    remote_address = ("::1", 12345, 0, 0)

    def __init__(self):
        self.closed = False
        self.close_code = None
        self.close_reason = None

    async def close(self, code=None, reason=None):
        self.closed = True
        self.close_code = code
        self.close_reason = reason


def test_readonly_command_retries_once_after_extension_reconnect():
    async def run():
        manager = WSManager()
        first = FakeConnection(manager, fail=True)
        second = FakeConnection(manager, result={"tabs": [{"id": 1}]})
        manager._connection = first

        async def wait_for_connection(timeout=10.0):
            manager._connection = second
            return True

        manager.wait_for_connection = wait_for_connection

        result = await manager.send_command("get_all_tabs")

        assert result == {"tabs": [{"id": 1}]}
        assert len(first.sent) == 1
        assert len(second.sent) == 1

    asyncio.run(run())


def test_duplicate_extension_connection_does_not_replace_active_connection():
    async def run():
        manager = WSManager()
        active = DuplicateConnection()
        duplicate = DuplicateConnection()
        manager._connection = active

        await manager._handle_connection(duplicate)

        assert manager._connection is active
        assert not active.closed
        assert duplicate.closed
        assert duplicate.close_code == 1008

    asyncio.run(run())


def test_mutating_command_does_not_retry_after_extension_disconnect():
    async def run():
        manager = WSManager()
        first = FakeConnection(manager, fail=True)
        manager._connection = first

        async def wait_for_connection(timeout=10.0):
            raise AssertionError("mutating commands must not retry")

        manager.wait_for_connection = wait_for_connection

        with pytest.raises(ConnectionError):
            await manager.send_command("click", {"x": 1, "y": 2})

        assert len(first.sent) == 1

    asyncio.run(run())
