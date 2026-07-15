from __future__ import annotations

import sqlite3

import pytest

from server.session_protocol import SessionProtocolError
from server.session_store import SessionStore


def snapshot(epoch="epoch-a", title="调研会话"):
    return {
        "browserEpoch": epoch,
        "sessions": [
            {
                "session": "research",
                "sessionId": "session-a",
                "ownerId": "owner-a",
                "adapterId": "adapter-a",
                "groupId": 11,
                "groupTitle": title,
                "windowId": 1,
                "targetTabId": 101,
                "revision": 1,
                "state": "ACTIVE",
                "browserEpoch": epoch,
                "protocolVersion": 2,
                "tabIds": [101, 102],
                "claimedTabIds": [102],
                "claimRestore": {
                    "102": {"windowId": 1, "groupId": -1, "index": 4}
                },
            }
        ],
        "groupOwners": {"11": "session-a"},
        "tabOwners": {"101": "session-a", "102": "session-a"},
    }


def test_store_creates_versioned_schema_and_round_trips_utf8(tmp_path):
    database = tmp_path / "sessions.sqlite3"
    store = SessionStore(database)

    store.save_snapshot(snapshot())

    assert store.load_snapshot("epoch-a") == snapshot()
    with sqlite3.connect(str(database)) as connection:
        schema_version = connection.execute(
            "SELECT value FROM metadata WHERE key = 'schema_version'"
        ).fetchone()[0]
        journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
    assert schema_version == "1"
    assert journal_mode.lower() == "wal"


def test_save_snapshot_replaces_only_the_same_epoch(tmp_path):
    store = SessionStore(tmp_path / "sessions.sqlite3")
    store.save_snapshot(snapshot("epoch-a", "版本 A"))
    store.save_snapshot(snapshot("epoch-b", "版本 B"))
    updated = snapshot("epoch-a", "版本 A2")
    store.save_snapshot(updated)

    assert store.load_snapshot("epoch-a") == updated
    assert store.load_snapshot("epoch-b")["sessions"][0]["groupTitle"] == "版本 B"


def test_invalid_snapshot_does_not_replace_existing_transaction(tmp_path):
    store = SessionStore(tmp_path / "sessions.sqlite3")
    original = snapshot()
    store.save_snapshot(original)

    with pytest.raises(SessionProtocolError) as exc:
        store.save_snapshot({"sessions": []})

    assert exc.value.code == "INVALID_SESSION_SNAPSHOT"
    assert store.load_snapshot("epoch-a") == original


def test_mark_epoch_orphaned_removes_runtime_ids_and_ownership(tmp_path):
    store = SessionStore(tmp_path / "sessions.sqlite3")
    store.save_snapshot(snapshot())

    orphaned = store.mark_epoch_orphaned("epoch-a")

    session = orphaned["sessions"][0]
    assert session["state"] == "ORPHANED"
    assert session["groupId"] is None
    assert session["windowId"] is None
    assert session["targetTabId"] is None
    assert session["tabIds"] == []
    assert session["claimedTabIds"] == []
    assert session["claimRestore"] == {}
    assert orphaned["groupOwners"] == {}
    assert orphaned["tabOwners"] == {}
    assert store.load_snapshot("epoch-a") == orphaned


def test_operation_result_is_idempotent_for_same_fingerprint(tmp_path):
    store = SessionStore(tmp_path / "sessions.sqlite3")

    first = store.record_operation(
        "operation-a",
        {"command": "session_create_tab", "sessionId": "session-a"},
        {"tabId": 101},
    )
    replay = store.record_operation(
        "operation-a",
        {"sessionId": "session-a", "command": "session_create_tab"},
        {"tabId": 999},
    )

    assert first == {"tabId": 101}
    assert replay == {"tabId": 101}


def test_operation_id_conflict_is_rejected_without_overwrite(tmp_path):
    store = SessionStore(tmp_path / "sessions.sqlite3")
    store.record_operation(
        "operation-a",
        {"command": "session_create_tab", "sessionId": "session-a"},
        {"tabId": 101},
    )

    with pytest.raises(SessionProtocolError) as exc:
        store.record_operation(
            "operation-a",
            {"command": "session_create_tab", "sessionId": "session-b"},
            {"tabId": 202},
        )

    assert exc.value.code == "OPERATION_ID_CONFLICT"
    assert store.load_operation("operation-a") == {"tabId": 101}


def test_store_creates_parent_directory_without_external_dependencies(tmp_path):
    database = tmp_path / "nested" / "runtime" / "sessions.sqlite3"

    store = SessionStore(database)
    store.save_snapshot(snapshot())

    assert database.exists()
    assert store.load_snapshot("epoch-a")["browserEpoch"] == "epoch-a"
