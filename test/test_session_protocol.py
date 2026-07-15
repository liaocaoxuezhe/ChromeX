from __future__ import annotations

import pytest

from server.session_protocol import (
    SessionEnvelope,
    SessionHandle,
    SessionProtocolError,
)


def valid_message(**overrides):
    message = {
        "protocolVersion": 2,
        "requestId": "request-a",
        "operationId": "operation-a",
        "adapterId": "adapter-a",
        "ownerId": "owner-a",
        "sessionId": "session-a",
        "sessionAlias": "research",
        "sessionRevision": 3,
        "groupId": 11,
        "tabId": 101,
        "command": "navigate",
        "params": {"url": "https://example.com"},
    }
    message.update(overrides)
    return message


def test_v2_envelope_requires_operation_identity():
    with pytest.raises(SessionProtocolError) as exc:
        SessionEnvelope.from_message({"protocolVersion": 2, "command": "navigate"})

    assert exc.value.code == "INVALID_ENVELOPE"
    assert "requestId" in exc.value.details["missingFields"]
    assert "operationId" in exc.value.details["missingFields"]


def test_v2_envelope_rejects_unsupported_protocol_version():
    with pytest.raises(SessionProtocolError) as exc:
        SessionEnvelope.from_message(valid_message(protocolVersion=1))

    assert exc.value.code == "UNSUPPORTED_PROTOCOL_VERSION"
    assert exc.value.details == {"expected": 2, "actual": 1}


def test_v2_envelope_preserves_explicit_session_and_tab_identity():
    envelope = SessionEnvelope.from_message(valid_message())

    assert envelope.session_id == "session-a"
    assert envelope.session_alias == "research"
    assert envelope.group_id == 11
    assert envelope.tab_id == 101
    assert envelope.params == {"url": "https://example.com"}
    assert envelope.to_message() == valid_message()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("sessionRevision", -1),
        ("groupId", "11"),
        ("tabId", "101"),
        ("params", []),
    ],
)
def test_v2_envelope_rejects_invalid_field_types(field, value):
    with pytest.raises(SessionProtocolError) as exc:
        SessionEnvelope.from_message(valid_message(**{field: value}))

    assert exc.value.code == "INVALID_ENVELOPE"
    assert exc.value.details["field"] == field


def test_session_handle_keeps_alias_separate_from_identity():
    handle = SessionHandle(
        session_id="sid-a",
        owner_id="owner-a",
        adapter_id="adapter-a",
        alias="research",
        group_id=11,
        group_title="Research",
        window_id=2,
        target_tab_id=101,
        revision=3,
        state="ACTIVE",
        browser_epoch="epoch-a",
    )

    payload = handle.to_payload()

    assert payload["session"] == "research"
    assert payload["sessionId"] == "sid-a"
    assert payload["ownerId"] == "owner-a"
    assert payload["groupId"] == 11
    assert payload["protocolVersion"] == 2


def test_protocol_error_has_compatible_text_and_structured_payload():
    error = SessionProtocolError(
        "TAB_OUTSIDE_SESSION",
        "tab 99 is outside session research",
        {"tabId": 99, "sessionId": "sid-a"},
    )

    assert str(error) == "tab 99 is outside session research"
    assert error.to_payload() == {
        "ok": False,
        "error": "tab 99 is outside session research",
        "code": "TAB_OUTSIDE_SESSION",
        "details": {"tabId": 99, "sessionId": "sid-a"},
    }
