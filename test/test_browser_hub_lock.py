import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import browser_hub


class BrowserHubLockTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.original_acquire_timeout = browser_hub.ACQUIRE_WAIT_TIMEOUT

    async def asyncTearDown(self):
        browser_hub.ACQUIRE_WAIT_TIMEOUT = self.original_acquire_timeout

    async def test_acquire_times_out_instead_of_waiting_forever(self):
        browser_hub.ACQUIRE_WAIT_TIMEOUT = 0.01
        hub = browser_hub.BrowserHub()
        await hub._operation_lock.acquire()
        hub._lease_token = "busy-token"
        hub._lease_name = "busy-tool"
        hub._lease_started_at = time.monotonic()

        response = await hub._handle_adapter_message(
            json.dumps(
                {
                    "request_id": "req-1",
                    "command": "__hub_acquire__",
                    "params": {"name": "next-tool"},
                }
            )
        )

        assert response["request_id"] == "req-1"
        assert response["success"] is False
        assert "操作锁等待超时" in response["error"]
        assert hub._operation_lock.locked()
        assert hub._lease_name == "busy-tool"

        hub._release_current_lease()

    async def test_undelivered_acquire_response_releases_lease(self):
        hub = browser_hub.BrowserHub()
        await hub._operation_lock.acquire()
        hub._lease_token = "new-token"
        hub._lease_name = "new-tool"
        hub._lease_started_at = time.monotonic()

        hub._release_undelivered_lease(
            {
                "success": True,
                "data": {
                    "lease_token": "new-token",
                    "lease_name": "new-tool",
                },
            }
        )

        assert not hub._operation_lock.locked()
        assert hub._lease_token is None
        assert hub._lease_name is None


def test_browser_diagnose_bypasses_operation_lock():
    main_source = Path("server/main.py").read_text(encoding="utf-8")
    bypass_block = main_source.split('if name == "browser_diagnose":', 1)[1]
    bypass_block = bypass_block.split("async with ws_manager.operation(name):", 1)[0]

    assert "tool_diagnose(arguments)" in bypass_block
    assert "op_logger.log_operation" in bypass_block
