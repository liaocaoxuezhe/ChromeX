from __future__ import annotations

import asyncio
import json
import unittest

from server.product_identity import (
    BROWSER_KIND,
    EXTENSION_ID,
    PRODUCT_ID,
    PROTOCOL_VERSION,
    ExtensionHandshakeError,
    validate_extension_hello,
)
from server.ws_manager import WSManager


class FakeWebSocket:
    remote_address = ("127.0.0.1", 12345)

    def __init__(self, first_message=None):
        self.first_message = first_message
        self.first_ready = asyncio.Event()
        self.sent = []
        self.sent_event = asyncio.Event()
        self.finish = asyncio.Event()
        self.closed = False
        self.close_code = None
        self.close_reason = None
        if first_message is not None:
            self.first_ready.set()

    async def recv(self):
        await self.first_ready.wait()
        return json.dumps(self.first_message)

    async def send(self, message):
        self.sent.append(json.loads(message))
        self.sent_event.set()

    def __aiter__(self):
        return self

    async def __anext__(self):
        await self.finish.wait()
        raise StopAsyncIteration

    async def close(self, code=None, reason=None):
        self.closed = True
        self.close_code = code
        self.close_reason = reason
        self.finish.set()


class ExtensionProductHandshakeTests(unittest.TestCase):
    def valid_hello(self):
        return {
            "type": "hello",
            "productId": PRODUCT_ID,
            "browserKind": BROWSER_KIND,
            "extensionId": EXTENSION_ID,
            "protocolVersion": PROTOCOL_VERSION,
            "buildVersion": "chromex-test-build",
        }

    def test_valid_hello_returns_sanitized_identity(self):
        self.assertEqual(validate_extension_hello(self.valid_hello()), self.valid_hello())

    def test_identity_mismatches_fail_with_stable_codes(self):
        cases = {
            "productId": ("tabbitdance", "PRODUCT_ID_MISMATCH"),
            "browserKind": ("tabbit", "BROWSER_KIND_MISMATCH"),
            "extensionId": ("wrong-extension", "EXTENSION_ID_MISMATCH"),
            "protocolVersion": (999, "PROTOCOL_VERSION_MISMATCH"),
        }
        for field, (value, expected_code) in cases.items():
            with self.subTest(field=field):
                message = self.valid_hello()
                message[field] = value
                with self.assertRaises(ExtensionHandshakeError) as raised:
                    validate_extension_hello(message)
                self.assertEqual(raised.exception.code, expected_code)

    def test_non_hello_first_frame_is_rejected(self):
        with self.assertRaises(ExtensionHandshakeError) as raised:
            validate_extension_hello({"type": "ping"})
        self.assertEqual(raised.exception.code, "INVALID_EXTENSION_HANDSHAKE")


class ExtensionWebSocketHandshakeTests(unittest.IsolatedAsyncioTestCase):
    def valid_hello(self):
        return {
            "type": "hello",
            "productId": PRODUCT_ID,
            "browserKind": BROWSER_KIND,
            "extensionId": EXTENSION_ID,
            "protocolVersion": PROTOCOL_VERSION,
            "buildVersion": "chromex-test-build",
        }

    async def test_connection_becomes_active_only_after_valid_hello(self):
        manager = WSManager(handshake_timeout=0.2)
        websocket = FakeWebSocket()
        task = asyncio.create_task(manager._handle_connection(websocket))
        await asyncio.sleep(0)

        self.assertFalse(manager.is_connected)
        websocket.first_message = self.valid_hello()
        websocket.first_ready.set()
        await asyncio.wait_for(websocket.sent_event.wait(), timeout=0.2)

        self.assertTrue(manager.is_connected)
        self.assertEqual(websocket.sent[0]["type"], "hello_ack")
        self.assertEqual(manager.connection_status()["handshake"]["productId"], PRODUCT_ID)

        websocket.finish.set()
        await task

    async def test_wrong_product_is_rejected_without_becoming_active(self):
        hello = self.valid_hello()
        hello["productId"] = "tabbitdance"
        manager = WSManager(handshake_timeout=0.2)
        websocket = FakeWebSocket(hello)

        await manager._handle_connection(websocket)

        self.assertFalse(manager.is_connected)
        self.assertTrue(websocket.closed)
        self.assertEqual(websocket.close_code, 1008)
        self.assertEqual(websocket.close_reason, "PRODUCT_ID_MISMATCH")

    async def test_missing_first_frame_times_out_fail_closed(self):
        manager = WSManager(handshake_timeout=0.01)
        websocket = FakeWebSocket()

        await manager._handle_connection(websocket)

        self.assertFalse(manager.is_connected)
        self.assertTrue(websocket.closed)
        self.assertEqual(websocket.close_reason, "EXTENSION_HANDSHAKE_TIMEOUT")


if __name__ == "__main__":
    unittest.main()
