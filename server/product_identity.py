"""Stable product identity for ChromeX local browser transports."""

from __future__ import annotations

from typing import Any

PRODUCT_ID = "chromex"
BROWSER_KIND = "chrome"
EXTENSION_ID = "gfmbcnhkhgdlpcdhmolaefigfapbamcg"
PROTOCOL_VERSION = 2


class ExtensionHandshakeError(ConnectionError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class HubProductMismatchError(ConnectionError):
    def __init__(self):
        self.code = "HUB_PRODUCT_MISMATCH"
        super().__init__(self.code)


def hub_identity_payload() -> dict[str, Any]:
    return {
        "productId": PRODUCT_ID,
        "browserKind": BROWSER_KIND,
        "protocolVersion": PROTOCOL_VERSION,
    }


def validate_hub_identity(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise HubProductMismatchError()
    for field, expected in hub_identity_payload().items():
        if payload.get(field) != expected:
            raise HubProductMismatchError()


def validate_extension_hello(message: Any) -> dict[str, Any]:
    if not isinstance(message, dict) or message.get("type") != "hello":
        raise ExtensionHandshakeError("INVALID_EXTENSION_HANDSHAKE")

    expected_fields = (
        ("productId", PRODUCT_ID, "PRODUCT_ID_MISMATCH"),
        ("browserKind", BROWSER_KIND, "BROWSER_KIND_MISMATCH"),
        ("extensionId", EXTENSION_ID, "EXTENSION_ID_MISMATCH"),
        ("protocolVersion", PROTOCOL_VERSION, "PROTOCOL_VERSION_MISMATCH"),
    )
    for field, expected, code in expected_fields:
        if message.get(field) != expected:
            raise ExtensionHandshakeError(code)

    build_version = message.get("buildVersion")
    if not isinstance(build_version, str) or not build_version.strip():
        raise ExtensionHandshakeError("INVALID_EXTENSION_HANDSHAKE")

    return {
        "type": "hello",
        "productId": PRODUCT_ID,
        "browserKind": BROWSER_KIND,
        "extensionId": EXTENSION_ID,
        "protocolVersion": PROTOCOL_VERSION,
        "buildVersion": build_version[:120],
    }
