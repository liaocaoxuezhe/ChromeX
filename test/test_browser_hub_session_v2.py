from __future__ import annotations

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path

from server.browser_hub import BrowserHub
from server.session_registry import SessionRegistry
from server.session_scheduler import SessionScheduler
from server.session_store import SessionStore


class RecordingExtension:
    def __init__(self):
        self.is_connected = True
        self.startup_error = None
        self.calls = []
        self.entered = []
        self.two_entered = asyncio.Event()
        self.first_entered = asyncio.Event()
        self.release = asyncio.Event()
        self.bad_group = False
        self.mirror_sessions = []

    async def start(self):
        return None

    async def send_command(self, command, params):
        label = params.get("label", command)
        self.calls.append((command, params))
        if command == "ping_version":
            return {"browserEpoch": "epoch-a"}
        if command == "session_snapshot":
            return {"browserEpoch": "epoch-a", "sessions": list(self.mirror_sessions)}
        if command == "session_restore_snapshot":
            self.mirror_sessions = list(params.get("sessions") or [])
            return {"ok": True}
        if command == "session_register_snapshot":
            self.mirror_sessions.append(dict(params))
            return {"ok": True}
        if command == "session_forget_snapshot":
            self.mirror_sessions = [
                item for item in self.mirror_sessions
                if item.get("sessionId") != params.get("sessionId")
            ]
            return {"ok": True}
        if command == "session_create_group":
            result = {
                "sessionId": params["sessionId"],
                "groupId": 33,
                "windowId": params.get("windowId") or 1,
                "tabId": 303,
                "focusPreserved": True,
                "browserEpoch": "epoch-a",
            }
            self.mirror_sessions.append({
                "sessionId": params["sessionId"],
                "groupId": result["groupId"],
                "windowId": result["windowId"],
                "tabIds": [result["tabId"]],
                "revision": params["revision"],
                "state": "ACTIVE",
            })
            return result
        if command == "session_create_tab":
            result = {
                "sessionId": params["sessionId"],
                "groupId": 999 if self.bad_group else params["groupId"],
                "windowId": params["windowId"],
                "tabId": 304,
                "focusPreserved": True,
            }
            if not self.bad_group:
                mirror = next(item for item in self.mirror_sessions if item["sessionId"] == params["sessionId"])
                mirror["tabIds"] = [*mirror.get("tabIds", []), result["tabId"]]
                mirror["revision"] = params["revision"]
            return result
        self.entered.append(label)
        if len(self.entered) >= 2:
            self.two_entered.set()
        if label == "first":
            self.first_entered.set()
        if params.get("wait"):
            await self.release.wait()
        return {"command": command, "label": label, "context": params.get("sessionContext")}


def envelope(handle, request_id, operation_id, label, wait=False, **overrides):
    message = {
        "protocolVersion": 2,
        "requestId": request_id,
        "operationId": operation_id,
        "adapterId": handle.adapter_id,
        "ownerId": handle.owner_id,
        "sessionId": handle.session_id,
        "sessionAlias": handle.alias,
        "sessionRevision": handle.revision,
        "groupId": handle.group_id,
        "tabId": handle.target_tab_id,
        "command": "test_command",
        "params": {"label": label, "wait": wait},
    }
    message.update(overrides)
    return json.dumps(message)


class BrowserHubSessionV2Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.extension = RecordingExtension()
        self.registry = SessionRegistry(
            id_factory=iter(["session-a", "session-b", "session-c"]).__next__
        )
        self.scheduler = SessionScheduler(max_concurrent_sessions=4)
        self.hub = BrowserHub(
            extension_ws=self.extension,
            session_registry=self.registry,
            session_scheduler=self.scheduler,
            protocol_mode="v2",
        )
        self.session_a = await self._create_active(
            "owner-a", "adapter-a", "research", 11, 101, "a"
        )
        self.session_b = await self._create_active(
            "owner-b", "adapter-b", "research", 22, 202, "b"
        )

    async def _create_active(
        self, owner_id, adapter_id, alias, group_id, tab_id, suffix
    ):
        creating = await self.registry.create(
            owner_id=owner_id,
            adapter_id=adapter_id,
            alias=alias,
            group_title=alias,
            operation_id=f"create-{suffix}",
        )
        return await self.registry.bind_group(
            session_id=creating.session_id,
            group_id=group_id,
            window_id=1,
            seed_tab_id=tab_id,
            browser_epoch="epoch-a",
            expected_revision=creating.revision,
            operation_id=f"bind-{suffix}",
        )

    async def test_same_session_commands_never_overlap(self):
        first = asyncio.create_task(
            self.hub._handle_adapter_message(
                envelope(self.session_a, "request-a", "operation-a", "first", wait=True)
            )
        )
        await self.extension.first_entered.wait()
        second = asyncio.create_task(
            self.hub._handle_adapter_message(
                envelope(self.session_a, "request-b", "operation-b", "second")
            )
        )
        await asyncio.sleep(0)

        self.assertEqual(self.extension.entered, ["first"])
        self.extension.release.set()
        first_result, second_result = await asyncio.gather(first, second)

        self.assertTrue(first_result["success"])
        self.assertTrue(second_result["success"])
        self.assertEqual(self.extension.entered, ["first", "second"])

    async def test_different_session_commands_overlap_in_extension(self):
        first = asyncio.create_task(
            self.hub._handle_adapter_message(
                envelope(self.session_a, "request-a", "operation-a", "session-a", wait=True)
            )
        )
        second = asyncio.create_task(
            self.hub._handle_adapter_message(
                envelope(self.session_b, "request-b", "operation-b", "session-b", wait=True)
            )
        )

        await asyncio.wait_for(self.extension.two_entered.wait(), timeout=0.5)
        self.assertEqual(set(self.extension.entered), {"session-a", "session-b"})
        self.extension.release.set()
        results = await asyncio.gather(first, second)
        self.assertTrue(all(result["success"] for result in results))

    async def test_rich_clipboard_global_resource_is_serialized_across_sessions(self):
        first = asyncio.create_task(self.hub._handle_adapter_message(
            envelope(
                self.session_a, "clipboard-a", "clipboard-op-a", "clipboard-a",
                wait=True, command="browser.clipboard.write",
            )
        ))
        await asyncio.sleep(0)
        while "clipboard-a" not in self.extension.entered:
            await asyncio.sleep(0)
        second = asyncio.create_task(self.hub._handle_adapter_message(
            envelope(
                self.session_b, "clipboard-b", "clipboard-op-b", "clipboard-b",
                command="browser.clipboard.write",
            )
        ))
        await asyncio.sleep(0)
        self.assertEqual(self.extension.entered, ["clipboard-a"])
        self.extension.release.set()
        results = await asyncio.gather(first, second)
        self.assertTrue(all(result["success"] for result in results))
        self.assertEqual(self.extension.entered, ["clipboard-a", "clipboard-b"])

    async def test_v2_command_ignores_legacy_global_operation_lock(self):
        await self.hub._operation_lock.acquire()
        try:
            result = await asyncio.wait_for(
                self.hub._handle_adapter_message(
                    envelope(self.session_a, "request-a", "operation-a", "v2")
                ),
                timeout=0.2,
            )
        finally:
            self.hub._operation_lock.release()

        self.assertTrue(result["success"])
        self.assertEqual(self.extension.entered, ["v2"])

    async def test_foreign_owner_is_rejected_before_extension_invocation(self):
        result = await self.hub._handle_adapter_message(
            envelope(
                self.session_a,
                "request-a",
                "operation-a",
                "foreign",
                ownerId="owner-b",
            )
        )

        self.assertFalse(result["success"])
        self.assertEqual(result["code"], "SESSION_OWNER_MISMATCH")
        self.assertEqual(self.extension.calls, [])

    async def test_foreign_tab_is_rejected_before_extension_invocation(self):
        result = await self.hub._handle_adapter_message(
            envelope(
                self.session_a,
                "request-a",
                "operation-a",
                "foreign-tab",
                tabId=self.session_b.target_tab_id,
            )
        )

        self.assertFalse(result["success"])
        self.assertEqual(result["code"], "TAB_OUTSIDE_SESSION")
        self.assertEqual(self.extension.calls, [])

    async def test_hub_builds_authoritative_extension_context(self):
        result = await self.hub._handle_adapter_message(
            envelope(self.session_a, "request-a", "operation-a", "context")
        )

        self.assertTrue(result["success"])
        command, params = next(call for call in self.extension.calls if call[0] == "test_command")
        self.assertEqual(command, "test_command")
        self.assertEqual(
            params["sessionContext"],
            {
                "sessionId": "session-a",
                "sessionAlias": "research",
                "revision": 1,
                "groupId": 11,
                "windowId": 1,
                "targetTabId": 101,
                "tabId": 101,
                "allowedTabIds": [101],
                "mode": "session-v2",
            },
        )
        self.assertEqual(params["scope"]["groupId"], 11)
        self.assertEqual(params["scope"]["allowedTabIds"], [101])

    async def test_session_control_commands_create_bind_get_and_list(self):
        create = await self.hub._handle_adapter_message(
            json.dumps(
                {
                    "request_id": "request-create",
                    "command": "__session_create__",
                    "params": {
                        "ownerId": "owner-c",
                        "adapterId": "adapter-c",
                        "alias": "build",
                        "groupTitle": "Build",
                        "operationId": "create-c",
                    },
                }
            )
        )
        self.assertTrue(create["success"])
        self.assertEqual(create["data"]["state"], "CREATING")

        bind = await self.hub._handle_adapter_message(
            json.dumps(
                {
                    "request_id": "request-bind",
                    "command": "__session_bind_group__",
                    "params": {
                        "ownerId": "owner-c",
                        "adapterId": "adapter-c",
                        "sessionId": create["data"]["sessionId"],
                        "groupId": 33,
                        "windowId": 1,
                        "seedTabId": 303,
                        "browserEpoch": "epoch-a",
                        "expectedRevision": 0,
                        "operationId": "bind-c",
                    },
                }
            )
        )
        self.assertTrue(bind["success"])
        self.assertEqual(bind["data"]["groupId"], 33)

        listed = await self.hub._handle_adapter_message(
            json.dumps(
                {
                    "request_id": "request-list",
                    "command": "__session_list__",
                    "params": {"ownerId": "owner-c", "adapterId": "adapter-c"},
                }
            )
        )
        self.assertTrue(listed["success"])
        self.assertEqual([item["session"] for item in listed["data"]["sessions"]], ["build"])

    async def test_hub_materializes_group_and_commits_new_tab_ownership(self):
        create = await self.hub._handle_adapter_message(
            json.dumps(
                {
                    "request_id": "request-create",
                    "command": "__session_create__",
                    "params": {
                        "ownerId": "owner-c",
                        "adapterId": "adapter-c",
                        "alias": "build",
                        "groupTitle": "Build",
                        "operationId": "create-c",
                    },
                }
            )
        )
        materialized = await self.hub._handle_adapter_message(
            json.dumps(
                {
                    "request_id": "request-materialize",
                    "command": "__session_materialize__",
                    "params": {
                        "ownerId": "owner-c",
                        "adapterId": "adapter-c",
                        "sessionId": create["data"]["sessionId"],
                        "url": "https://example.com/search?q=Link2Chrome",
                        "expectedRevision": 0,
                        "operationId": "materialize-c",
                    },
                }
            )
        )

        self.assertTrue(materialized["success"])
        self.assertEqual(materialized["data"]["state"], "ACTIVE")
        self.assertEqual(materialized["data"]["groupId"], 33)
        self.assertEqual(self.registry.owner_of_tab(303), "session-c")

        created_tab = await self.hub._handle_adapter_message(
            json.dumps(
                {
                    "request_id": "request-tab",
                    "command": "__session_create_tab__",
                    "params": {
                        "ownerId": "owner-c",
                        "adapterId": "adapter-c",
                        "sessionId": "session-c",
                        "url": "https://example.com",
                        "expectedRevision": 1,
                        "operationId": "tab-c",
                    },
                }
            )
        )

        self.assertTrue(created_tab["success"])
        self.assertEqual(created_tab["data"]["tabId"], 304)
        self.assertEqual(created_tab["data"]["revision"], 2)
        self.assertEqual(self.registry.owner_of_tab(304), "session-c")
        create_group_call = next(call for call in self.extension.calls if call[0] == "session_create_group")
        create_tab_call = next(call for call in self.extension.calls if call[0] == "session_create_tab")
        self.assertEqual(create_group_call[1]["revision"], 1)
        self.assertEqual(
            create_group_call[1]["url"],
            "https://example.com/search?q=Link2Chrome",
        )
        self.assertEqual(create_tab_call[1]["revision"], 2)
        self.assertNotIn("active", create_group_call[1])
        self.assertNotIn("focusWindow", create_tab_call[1])

    async def test_failed_registry_verification_rolls_back_only_new_extension_tab(self):
        self.extension.bad_group = True
        response = await self.hub._handle_adapter_message(json.dumps({
            "request_id": "rollback-request",
            "command": "__session_create_tab__",
            "params": {
                "ownerId": self.session_a.owner_id,
                "adapterId": self.session_a.adapter_id,
                "sessionId": self.session_a.session_id,
                "url": "https://bad.test",
                "expectedRevision": self.session_a.revision,
                "operationId": "rollback-operation",
            },
        }))
        self.assertFalse(response["success"])
        rollback = [call for call in self.extension.calls if call[0] == "session_rollback_tab"]
        self.assertEqual(len(rollback), 1)
        self.assertEqual(rollback[0][1]["tabId"], 304)
        self.assertEqual(self.registry.owner_of_tab(304), None)
        self.assertEqual(self.registry.owner_of_tab(101), self.session_a.session_id)

    async def test_second_stale_create_tab_is_rejected_inside_session_lane(self):
        first = await self.hub._handle_adapter_message(json.dumps({
            "request_id": "tab-first",
            "command": "__session_create_tab__",
            "params": {
                "ownerId": self.session_a.owner_id,
                "adapterId": self.session_a.adapter_id,
                "sessionId": self.session_a.session_id,
                "url": "https://first.test",
                "expectedRevision": self.session_a.revision,
                "operationId": "tab-first-op",
            },
        }))
        second = await self.hub._handle_adapter_message(json.dumps({
            "request_id": "tab-stale",
            "command": "__session_create_tab__",
            "params": {
                "ownerId": self.session_a.owner_id,
                "adapterId": self.session_a.adapter_id,
                "sessionId": self.session_a.session_id,
                "url": "https://stale.test",
                "expectedRevision": self.session_a.revision,
                "operationId": "tab-stale-op",
            },
        }))

        self.assertTrue(first["success"])
        self.assertFalse(second["success"])
        self.assertEqual(second["code"], "STALE_SESSION_REVISION")
        create_calls = [call for call in self.extension.calls if call[0] == "session_create_tab"]
        self.assertEqual(len(create_calls), 1)

    async def test_registered_connection_cannot_impersonate_another_adapter(self):
        identity = {"ownerId": "owner-a", "adapterId": "adapter-a"}
        response = await self.hub._handle_adapter_message(
            json.dumps({
                "request_id": "foreign-list",
                "command": "__session_list__",
                "params": {"ownerId": "owner-b", "adapterId": "adapter-b"},
            }),
            identity,
        )
        self.assertFalse(response["success"])
        self.assertEqual(response["code"], "ADAPTER_IDENTITY_MISMATCH")

    async def test_v2_generic_new_tab_is_rejected_before_extension(self):
        before = len(self.extension.calls)
        response = await self.hub._handle_adapter_message(
            envelope(
                self.session_a,
                "generic-new",
                "generic-new-op",
                "new",
                command="agent_browser_tab_new",
            )
        )
        self.assertFalse(response["success"])
        self.assertEqual(response["code"], "SESSION_TRANSACTION_REQUIRED")
        self.assertEqual(len(self.extension.calls), before)

    async def test_claim_requires_owner_scoped_single_use_token_before_extension(self):
        base = {
            "request_id": "claim",
            "command": "__session_claim_tab__",
            "params": {
                "ownerId": self.session_a.owner_id,
                "adapterId": self.session_a.adapter_id,
                "sessionId": self.session_a.session_id,
                "tabId": 909,
                "expectedRevision": self.session_a.revision,
                "operationId": "claim-op",
            },
        }
        denied = await self.hub._handle_adapter_message(json.dumps(base))
        self.assertFalse(denied["success"])
        self.assertEqual(denied["code"], "INVALID_CLAIM_TOKEN")
        self.assertFalse(any(command == "session_claim_tab" for command, _ in self.extension.calls))

        token = "claim-token"
        self.hub._claim_tokens[token] = {
            "ownerId": self.session_a.owner_id,
            "adapterId": self.session_a.adapter_id,
            "tabId": 909,
            "expiresAt": time.monotonic() + 60,
        }
        base["params"]["claimToken"] = token
        allowed = await self.hub._handle_adapter_message(json.dumps(base))
        self.assertTrue(allowed["success"])
        self.assertNotIn(token, self.hub._claim_tokens)

    async def test_claim_operation_id_conflict_is_rejected_before_extension_mutation(self):
        self.registry._operation_results["reused-op"] = (("different",), self.session_a)
        token = "unused-token"
        self.hub._claim_tokens[token] = {
            "ownerId": self.session_a.owner_id,
            "adapterId": self.session_a.adapter_id,
            "tabId": 910,
            "expiresAt": time.monotonic() + 60,
        }
        before_claims = sum(1 for command, _ in self.extension.calls if command == "session_claim_tab")
        response = await self.hub._handle_adapter_message(json.dumps({
            "request_id": "claim-conflict",
            "command": "__session_claim_tab__",
            "params": {
                "ownerId": self.session_a.owner_id,
                "adapterId": self.session_a.adapter_id,
                "sessionId": self.session_a.session_id,
                "tabId": 910,
                "claimToken": token,
                "expectedRevision": self.session_a.revision,
                "operationId": "reused-op",
            },
        }))
        self.assertFalse(response["success"])
        self.assertEqual(response["code"], "OPERATION_ID_CONFLICT")
        after_claims = sum(1 for command, _ in self.extension.calls if command == "session_claim_tab")
        self.assertEqual(after_claims, before_claims)
        self.assertIn(token, self.hub._claim_tokens)

    async def test_same_epoch_store_restores_empty_extension_and_hub_registries(self):
        snapshot = self.registry.snapshot()
        snapshot["browserEpoch"] = "epoch-a"

        class RecoveryExtension(RecordingExtension):
            def __init__(self):
                super().__init__()
                self.restored = []

            async def send_command(self, command, params):
                self.calls.append((command, params))
                if command == "session_snapshot":
                    return {"browserEpoch": "epoch-a", "sessions": list(self.restored)}
                if command == "session_restore_snapshot":
                    self.restored = list(params["sessions"])
                    return {"ok": True, "restored": [item["sessionId"] for item in self.restored]}
                return await super().send_command(command, params)

        with tempfile.TemporaryDirectory() as directory:
            store = SessionStore(Path(directory) / "sessions.sqlite3")
            store.save_snapshot(snapshot)
            extension = RecoveryExtension()
            recovered = BrowserHub(
                extension_ws=extension,
                session_registry=SessionRegistry(),
                session_store=store,
                protocol_mode="v2",
            )
            result = await recovered._reconcile("restore", {"browserEpoch": "epoch-a"})

        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["restored"], 2)
        self.assertEqual(len(recovered.session_registry.list_sessions()), 2)
        self.assertTrue(any(command == "session_restore_snapshot" for command, _ in extension.calls))

    async def test_live_hub_registry_restores_empty_extension_after_worker_restart(self):
        self.extension.mirror_sessions = []
        result = await self.hub._reconcile("worker-restart", {"browserEpoch": "epoch-a"})
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["reason"], "extension-mirror-verified")
        self.assertEqual(
            {item["sessionId"] for item in self.extension.mirror_sessions},
            {self.session_a.session_id, self.session_b.session_id},
        )

    async def test_reconcile_transient_failure_does_not_fail_open(self):
        original = self.extension.send_command
        attempts = 0

        async def flaky(command, params):
            nonlocal attempts
            if command == "ping_version":
                attempts += 1
                if attempts == 1:
                    raise ConnectionError("transient")
            return await original(command, params)

        self.extension.send_command = flaky
        with self.assertRaises(ConnectionError):
            await self.hub._ensure_reconciled()
        self.assertEqual(self.hub._reconcile_state, "FAILED")
        await self.hub._ensure_reconciled()
        self.assertEqual(self.hub._reconcile_state, "SUCCEEDED")
        self.assertEqual(attempts, 2)

    async def test_legacy_status_and_v1_commands_remain_available(self):
        status = await self.hub._handle_adapter_message(
            json.dumps({"request_id": "status", "command": "__hub_status__", "params": {}})
        )

        self.assertTrue(status["success"])
        self.assertEqual(status["data"]["session_protocol_mode"], "v2")
        self.assertEqual(status["data"]["scheduler"]["inFlightSessions"], 0)
        self.assertEqual(status["data"]["active_sessions"], 2)


if __name__ == "__main__":
    unittest.main()
