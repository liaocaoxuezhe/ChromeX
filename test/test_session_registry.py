from __future__ import annotations

import asyncio

import pytest

from server.session_protocol import SessionProtocolError
from server.session_registry import SessionRegistry, SessionState


def run(coro):
    return asyncio.run(coro)


def create_session(
    registry: SessionRegistry,
    owner_id: str = "owner-a",
    adapter_id: str = "adapter-a",
    alias: str = "research",
    operation_id: str = "create-a",
):
    return run(
        registry.create(
            owner_id=owner_id,
            adapter_id=adapter_id,
            alias=alias,
            group_title="Research",
            operation_id=operation_id,
        )
    )


def bind_session(
    registry: SessionRegistry,
    session_id: str,
    group_id: int,
    seed_tab_id: int,
    operation_id: str,
):
    return run(
        registry.bind_group(
            session_id=session_id,
            group_id=group_id,
            window_id=1,
            seed_tab_id=seed_tab_id,
            browser_epoch="epoch-a",
            expected_revision=0,
            operation_id=operation_id,
        )
    )


def test_same_alias_is_isolated_by_owner():
    registry = SessionRegistry(id_factory=iter(["session-a", "session-b"]).__next__)

    session_a = create_session(registry)
    session_b = create_session(
        registry,
        owner_id="owner-b",
        adapter_id="adapter-b",
        operation_id="create-b",
    )

    assert session_a.session_id == "session-a"
    assert session_b.session_id == "session-b"
    assert registry.resolve("owner-a", "research").session_id == "session-a"
    assert registry.resolve("owner-b", "research").session_id == "session-b"


def test_repeated_create_for_same_owner_alias_is_idempotent():
    registry = SessionRegistry(id_factory=iter(["session-a", "unused"]).__next__)

    first = create_session(registry, operation_id="create-a")
    second = create_session(registry, operation_id="create-a-retry")

    assert second.session_id == first.session_id
    assert len(registry.list_sessions()) == 1


def test_group_and_tab_reverse_ownership_are_unique():
    registry = SessionRegistry(id_factory=iter(["session-a", "session-b"]).__next__)
    session_a = create_session(registry)
    session_b = create_session(
        registry,
        owner_id="owner-b",
        adapter_id="adapter-b",
        operation_id="create-b",
    )

    active_a = bind_session(registry, session_a.session_id, 11, 101, "bind-a")

    assert active_a.state == SessionState.ACTIVE.value
    assert active_a.revision == 1
    assert registry.owner_of_group(11) == session_a.session_id
    assert registry.owner_of_tab(101) == session_a.session_id

    with pytest.raises(SessionProtocolError) as exc:
        bind_session(registry, session_b.session_id, 11, 202, "bind-b")

    assert exc.value.code == "GROUP_ALREADY_OWNED"
    assert registry.get(session_b.session_id).state == SessionState.CREATING.value
    assert registry.owner_of_tab(202) is None


def test_bind_group_rolls_back_when_seed_tab_is_owned():
    registry = SessionRegistry(id_factory=iter(["session-a", "session-b"]).__next__)
    session_a = create_session(registry)
    session_b = create_session(
        registry,
        owner_id="owner-b",
        adapter_id="adapter-b",
        operation_id="create-b",
    )
    bind_session(registry, session_a.session_id, 11, 101, "bind-a")

    with pytest.raises(SessionProtocolError) as exc:
        bind_session(registry, session_b.session_id, 22, 101, "bind-b")

    assert exc.value.code == "TAB_ALREADY_OWNED"
    assert registry.owner_of_group(22) is None
    assert registry.get(session_b.session_id).revision == 0


def test_mutations_reject_stale_revision_without_side_effects():
    registry = SessionRegistry(id_factory=lambda: "session-a")
    session = create_session(registry)
    bind_session(registry, session.session_id, 11, 101, "bind-a")

    with pytest.raises(SessionProtocolError) as exc:
        run(
            registry.claim_tab(
                session_id=session.session_id,
                tab_id=102,
                expected_revision=0,
                operation_id="claim-a",
            )
        )

    assert exc.value.code == "STALE_SESSION_REVISION"
    assert registry.owner_of_tab(102) is None


def test_claim_set_target_and_release_keep_indexes_consistent():
    registry = SessionRegistry(id_factory=lambda: "session-a")
    session = create_session(registry)
    active = bind_session(registry, session.session_id, 11, 101, "bind-a")

    claimed = run(
        registry.claim_tab(
            session_id=session.session_id,
            tab_id=102,
            expected_revision=active.revision,
            operation_id="claim-a",
            restore={"windowId": 2, "groupId": -1, "index": 4, "active": False},
        )
    )
    targeted = run(
        registry.set_target(
            session_id=session.session_id,
            tab_id=102,
            expected_revision=claimed.revision,
            operation_id="target-a",
        )
    )
    released = run(
        registry.release_tab(
            session_id=session.session_id,
            tab_id=102,
            expected_revision=targeted.revision,
            operation_id="release-a",
        )
    )

    assert targeted.target_tab_id == 102
    assert released.target_tab_id == 101
    assert registry.owner_of_tab(102) is None
    assert registry.owner_of_tab(101) == session.session_id


def test_register_agent_tab_commits_owner_and_target_atomically():
    registry = SessionRegistry(id_factory=lambda: "session-a")
    session = create_session(registry)
    active = bind_session(registry, session.session_id, 11, 101, "bind-a")

    updated = run(
        registry.register_tab(
            session_id=session.session_id,
            tab_id=102,
            expected_revision=active.revision,
            operation_id="register-a",
            set_target=True,
        )
    )

    assert updated.revision == 2
    assert updated.target_tab_id == 102
    assert registry.owner_of_tab(102) == session.session_id
    assert registry.scope_payload(session.session_id)["allowedTabIds"] == [101, 102]


def test_tab_cannot_be_claimed_by_another_active_session():
    registry = SessionRegistry(id_factory=iter(["session-a", "session-b"]).__next__)
    session_a = create_session(registry)
    session_b = create_session(
        registry,
        owner_id="owner-b",
        adapter_id="adapter-b",
        operation_id="create-b",
    )
    active_a = bind_session(registry, session_a.session_id, 11, 101, "bind-a")
    active_b = bind_session(registry, session_b.session_id, 22, 202, "bind-b")
    run(
        registry.claim_tab(
            session_id=session_a.session_id,
            tab_id=303,
            expected_revision=active_a.revision,
            operation_id="claim-a",
        )
    )

    with pytest.raises(SessionProtocolError) as exc:
        run(
            registry.claim_tab(
                session_id=session_b.session_id,
                tab_id=303,
                expected_revision=active_b.revision,
                operation_id="claim-b",
            )
        )

    assert exc.value.code == "TAB_ALREADY_OWNED"
    assert registry.owner_of_tab(303) == session_a.session_id


def test_operation_id_reuse_with_different_fingerprint_is_rejected():
    registry = SessionRegistry(id_factory=lambda: "session-a")
    create_session(registry, operation_id="same-op")

    with pytest.raises(SessionProtocolError) as exc:
        create_session(
            registry,
            owner_id="owner-b",
            adapter_id="adapter-b",
            operation_id="same-op",
        )

    assert exc.value.code == "OPERATION_ID_CONFLICT"


def test_finalize_close_and_orphan_state_transitions_cleanup_indexes():
    registry = SessionRegistry(id_factory=iter(["session-a", "session-b"]).__next__)
    session_a = create_session(registry)
    active_a = bind_session(registry, session_a.session_id, 11, 101, "bind-a")

    finalizing = run(
        registry.begin_finalize(
            session_id=session_a.session_id,
            expected_revision=active_a.revision,
            operation_id="finalize-a",
        )
    )
    closed = run(
        registry.close(
            session_id=session_a.session_id,
            expected_revision=finalizing.revision,
            operation_id="close-a",
        )
    )

    assert closed.state == SessionState.CLOSED.value
    assert registry.owner_of_group(11) is None
    assert registry.owner_of_tab(101) is None
    assert registry.resolve("owner-a", "research") is None

    session_b = create_session(
        registry,
        owner_id="owner-b",
        adapter_id="adapter-b",
        operation_id="create-b",
    )
    active_b = bind_session(registry, session_b.session_id, 22, 202, "bind-b")
    orphaned = run(
        registry.orphan(
            session_id=session_b.session_id,
            expected_revision=active_b.revision,
            operation_id="orphan-b",
        )
    )

    assert orphaned.state == SessionState.ORPHANED.value
    assert registry.owner_of_group(22) is None
    assert registry.owner_of_tab(202) is None


def test_restore_snapshot_requires_exact_epoch_and_rebuilds_reverse_indexes():
    source = SessionRegistry(id_factory=lambda: "session-a")
    creating = create_session(source)
    active = bind_session(source, creating.session_id, 11, 101, "bind-a")
    snapshot = source.snapshot()
    snapshot["browserEpoch"] = "epoch-a"

    restored = SessionRegistry()
    assert restored.restore_snapshot(snapshot, "epoch-a") == 1
    assert restored.get(active.session_id).group_id == 11
    assert restored.owner_of_group(11) == active.session_id
    assert restored.owner_of_tab(101) == active.session_id

    with pytest.raises(SessionProtocolError) as exc:
        SessionRegistry().restore_snapshot(snapshot, "epoch-b")
    assert exc.value.code == "BROWSER_EPOCH_MISMATCH"


def test_unregister_last_tab_vacates_session_to_orphaned():
    registry = SessionRegistry(id_factory=iter(["session-a"]).__next__)
    created = create_session(registry)
    bound = bind_session(registry, created.session_id, 1588304773, 101, "bind-a")
    assert bound.state == SessionState.ACTIVE.value

    updated = run(
        registry.unregister_tab(
            session_id=created.session_id,
            tab_id=101,
            expected_revision=bound.revision,
            operation_id="unregister-a",
        )
    )
    assert updated.state == SessionState.ORPHANED.value
    assert updated.group_id is None
    assert updated.window_id is None
    assert updated.target_tab_id is None

    snapshot = registry.snapshot()
    assert snapshot["groupOwners"] == {}
    assert snapshot["tabOwners"] == {}
    session = snapshot["sessions"][0]
    assert session["state"] == "ORPHANED"
    assert session["groupId"] is None
    assert session["tabIds"] == []


def test_release_last_tab_vacates_session_to_orphaned():
    registry = SessionRegistry(id_factory=iter(["session-a"]).__next__)
    created = create_session(registry)
    bound = bind_session(registry, created.session_id, 42, 101, "bind-a")
    claimed = run(
        registry.claim_tab(
            session_id=created.session_id,
            tab_id=202,
            expected_revision=bound.revision,
            operation_id="claim-a",
        )
    )
    without_seed = run(
        registry.unregister_tab(
            session_id=created.session_id,
            tab_id=101,
            expected_revision=claimed.revision,
            operation_id="unregister-a",
        )
    )
    updated = run(
        registry.release_tab(
            session_id=created.session_id,
            tab_id=202,
            expected_revision=without_seed.revision,
            operation_id="release-a",
        )
    )
    assert updated.state == SessionState.ORPHANED.value
    assert updated.group_id is None
    assert updated.target_tab_id is None
    assert registry.snapshot()["groupOwners"] == {}


def test_unregister_penultimate_tab_keeps_session_active():
    registry = SessionRegistry(id_factory=iter(["session-a"]).__next__)
    created = create_session(registry)
    bound = bind_session(registry, created.session_id, 42, 101, "bind-a")
    with_second = run(
        registry.register_tab(
            session_id=created.session_id,
            tab_id=102,
            expected_revision=bound.revision,
            operation_id="register-b",
        )
    )
    updated = run(
        registry.unregister_tab(
            session_id=created.session_id,
            tab_id=101,
            expected_revision=with_second.revision,
            operation_id="unregister-a",
        )
    )
    assert updated.state == SessionState.ACTIVE.value
    assert updated.group_id == 42
    assert updated.target_tab_id == 102
