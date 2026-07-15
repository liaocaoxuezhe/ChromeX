from __future__ import annotations

import asyncio
import unittest

from server.session_scheduler import SessionScheduler


class SessionSchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_session_operations_are_fifo_and_never_overlap(self):
        scheduler = SessionScheduler(max_concurrent_sessions=4)
        first_entered = asyncio.Event()
        release_first = asyncio.Event()
        order = []
        in_flight = 0
        max_in_flight = 0

        async def run_operation(name, should_wait=False):
            nonlocal in_flight, max_in_flight
            async with scheduler.session_operation("session-a", f"operation-{name}"):
                order.append(f"enter-{name}")
                in_flight += 1
                max_in_flight = max(max_in_flight, in_flight)
                if should_wait:
                    first_entered.set()
                    await release_first.wait()
                in_flight -= 1
                order.append(f"exit-{name}")

        first = asyncio.create_task(run_operation("a", should_wait=True))
        await first_entered.wait()
        second = asyncio.create_task(run_operation("b"))
        await asyncio.sleep(0)

        self.assertEqual(order, ["enter-a"])
        release_first.set()
        await asyncio.gather(first, second)

        self.assertEqual(order, ["enter-a", "exit-a", "enter-b", "exit-b"])
        self.assertEqual(max_in_flight, 1)

    async def test_different_sessions_reach_barrier_concurrently(self):
        scheduler = SessionScheduler(max_concurrent_sessions=4)
        both_entered = asyncio.Event()
        release = asyncio.Event()
        entered = set()

        async def run_operation(session_id):
            async with scheduler.session_operation(session_id, f"operation-{session_id}"):
                entered.add(session_id)
                if len(entered) == 2:
                    both_entered.set()
                await release.wait()

        task_a = asyncio.create_task(run_operation("session-a"))
        task_b = asyncio.create_task(run_operation("session-b"))

        await asyncio.wait_for(both_entered.wait(), timeout=0.5)
        self.assertEqual(entered, {"session-a", "session-b"})
        snapshot = scheduler.snapshot()
        self.assertEqual(snapshot["inFlightSessions"], 2)

        release.set()
        await asyncio.gather(task_a, task_b)
        self.assertEqual(scheduler.snapshot()["inFlightSessions"], 0)

    async def test_concurrency_limit_applies_without_global_serialization(self):
        scheduler = SessionScheduler(max_concurrent_sessions=2)
        release = asyncio.Event()
        two_entered = asyncio.Event()
        entered = []

        async def run_operation(session_id):
            async with scheduler.session_operation(session_id, f"operation-{session_id}"):
                entered.append(session_id)
                if len(entered) == 2:
                    two_entered.set()
                await release.wait()

        tasks = [
            asyncio.create_task(run_operation(f"session-{index}"))
            for index in range(3)
        ]
        await asyncio.wait_for(two_entered.wait(), timeout=0.5)
        await asyncio.sleep(0.01)
        self.assertEqual(len(entered), 2)

        release.set()
        await asyncio.gather(*tasks)
        self.assertEqual(len(entered), 3)

    async def test_same_tab_operations_are_serialized(self):
        scheduler = SessionScheduler(max_concurrent_sessions=4)
        release_first = asyncio.Event()
        first_entered = asyncio.Event()
        order = []

        async def run_tab(name, wait=False):
            async with scheduler.tab_operation("session-a", 101):
                order.append(f"enter-{name}")
                if wait:
                    first_entered.set()
                    await release_first.wait()
                order.append(f"exit-{name}")

        first = asyncio.create_task(run_tab("a", wait=True))
        await first_entered.wait()
        second = asyncio.create_task(run_tab("b"))
        await asyncio.sleep(0)
        self.assertEqual(order, ["enter-a"])

        release_first.set()
        await asyncio.gather(first, second)
        self.assertEqual(order, ["enter-a", "exit-a", "enter-b", "exit-b"])

    async def test_named_global_resource_uses_only_its_own_short_lock(self):
        scheduler = SessionScheduler(max_concurrent_sessions=4)
        release_clipboard = asyncio.Event()
        clipboard_entered = asyncio.Event()
        download_entered = asyncio.Event()

        async def clipboard():
            async with scheduler.resource_operation("clipboard"):
                clipboard_entered.set()
                await release_clipboard.wait()

        async def download():
            await clipboard_entered.wait()
            async with scheduler.resource_operation("download-config"):
                download_entered.set()

        task_a = asyncio.create_task(clipboard())
        task_b = asyncio.create_task(download())
        await asyncio.wait_for(download_entered.wait(), timeout=0.5)
        release_clipboard.set()
        await asyncio.gather(task_a, task_b)

    async def test_cancelled_waiter_is_removed_without_leaking_lane(self):
        scheduler = SessionScheduler(max_concurrent_sessions=2)
        release_first = asyncio.Event()
        first_entered = asyncio.Event()

        async def first_operation():
            async with scheduler.session_operation("session-a", "operation-a"):
                first_entered.set()
                await release_first.wait()

        async def waiting_operation():
            async with scheduler.session_operation("session-a", "operation-b"):
                self.fail("cancelled waiter must not enter")

        first = asyncio.create_task(first_operation())
        await first_entered.wait()
        waiting = asyncio.create_task(waiting_operation())
        await asyncio.sleep(0)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting

        release_first.set()
        await first
        await asyncio.sleep(0)

        snapshot = scheduler.snapshot()
        self.assertEqual(snapshot["sessionLanes"], {})
        self.assertEqual(snapshot["inFlightSessions"], 0)


if __name__ == "__main__":
    unittest.main()
