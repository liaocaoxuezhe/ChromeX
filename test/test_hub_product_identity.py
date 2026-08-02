from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from server import hub_client as hub_client_module
from server.browser_hub import BrowserHub
from server.hub_client import HubClient
from server.product_identity import (
    BROWSER_KIND,
    PRODUCT_ID,
    PROTOCOL_VERSION,
    HubProductMismatchError,
    validate_hub_identity,
)


class FakeSocket:
    def __init__(self, identity):
        self.identity = identity
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def recv(self):
        request = self.sent[-1]
        return json.dumps({
            "request_id": request["request_id"],
            "success": True,
            "data": self.identity,
        })


class FakeConnectContext:
    def __init__(self, socket):
        self.socket = socket

    async def __aenter__(self):
        return self.socket

    async def __aexit__(self, exc_type, exc, tb):
        return False


class HubProductIdentityTests(unittest.IsolatedAsyncioTestCase):
    def expected_identity(self):
        return {
            "productId": PRODUCT_ID,
            "browserKind": BROWSER_KIND,
            "protocolVersion": PROTOCOL_VERSION,
        }

    def test_validates_expected_hub_and_rejects_other_product(self):
        validate_hub_identity(self.expected_identity())

        with self.assertRaises(HubProductMismatchError) as raised:
            validate_hub_identity({
                "productId": "tabbitdance",
                "browserKind": "tabbit",
                "protocolVersion": PROTOCOL_VERSION,
            })
        self.assertEqual(raised.exception.code, "HUB_PRODUCT_MISMATCH")

    async def test_hub_status_and_registration_publish_product_identity(self):
        hub = BrowserHub()
        hub.extension_ws._extension_handshake = {
            "productId": PRODUCT_ID,
            "browserKind": BROWSER_KIND,
            "protocolVersion": PROTOCOL_VERSION,
        }
        status = hub._status()
        self.assertEqual(
            {key: status[key] for key in self.expected_identity()},
            self.expected_identity(),
        )
        self.assertEqual(status["extension_handshake"]["productId"], PRODUCT_ID)
        self.assertIsNone(status["extension_handshake_error"])
        response = await hub._handle_adapter_message(
            json.dumps({
                "request_id": "register",
                "command": "__hub_register_adapter__",
                "params": {"adapterId": "adapter-test", "ownerId": "owner-test"},
            }),
            {},
        )
        self.assertTrue(response["success"])
        self.assertEqual(
            {key: response["data"][key] for key in self.expected_identity()},
            self.expected_identity(),
        )

    async def test_adapter_probe_rejects_wrong_product_before_use(self):
        socket = FakeSocket({
            "productId": "tabbitdance",
            "browserKind": "tabbit",
            "protocolVersion": PROTOCOL_VERSION,
        })
        client = HubClient("ws://wrong-product")
        with patch.object(
            hub_client_module.websockets,
            "connect",
            return_value=FakeConnectContext(socket),
        ):
            self.assertFalse(await client._can_connect(timeout=0.1))

        self.assertEqual(socket.sent[0]["command"], "__hub_status__")
        self.assertIn("HUB_PRODUCT_MISMATCH", client.startup_error or "")


if __name__ == "__main__":
    unittest.main()
