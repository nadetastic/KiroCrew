from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from kiro_crew.dashboard import slot_retention, warm_task_brief


class _State:
    def __init__(self) -> None:
        self._foreground_slots: dict[int, str] = {}
        self._warm_task_brief_away: dict[str, tuple[float, int]] = {}
        self._warm_task_brief_generation = 0
        self._warm_task_brief_slot_generation: dict[str, int] = {"thread-x": 1}
        self._warm_task_brief_tasks = {}
        self._warm_task_brief_statuses = {}
        self.frames: list[tuple[str, dict]] = []
        self.slots = {}
        self.sessions = object()

    def broadcast_ws_owners(self, kind: str, data: dict) -> None:
        self.frames.append((kind, data))

    def get_slot(self, key: str):
        return self.slots.get(key)

    def flush_slot_now(self, slot) -> None:
        slot.flushed += 1


class _Slot:
    def __init__(self, key: str = "thread-x") -> None:
        self.key = key
        self.running = False
        self.linked_session_key = ""
        self.channel_origin = False
        self._has_reader = False
        self.rows: list[dict] = []
        self.flushed = 0

    def append(self, role: str, content: str, cls: str = "", **kwargs):
        row = {"role": role, "content": content, "cls": cls}
        if kwargs.get("meta") is not None:
            row["meta"] = kwargs["meta"]
        self.rows.append(row)
        return row


def _apply_presence(state: _State, conn: int, slot: object, *, hidden: object = False, now: float):
    candidate = warm_task_brief.note_focus_frame(state, conn, slot, hidden=hidden, now=now)
    slot_retention.note_foreground(state, conn, slot)
    return candidate


def test_visible_for_thirty_minutes_has_no_episode_or_return():
    state = _State()
    _apply_presence(state, 1, "thread-x", now=0)
    candidate = _apply_presence(state, 1, "thread-x", now=3600)
    assert candidate is None
    assert state._warm_task_brief_away == {}
    assert state.frames == []


def test_visible_but_unfocused_has_no_signal_or_episode():
    state = _State()
    _apply_presence(state, 1, "thread-x", now=0)
    # Window blur sends no frame at all.
    assert state._foreground_slots == {1: "thread-x"}
    assert state._warm_task_brief_away == {}


def test_hidden_only_arms_and_does_not_trigger():
    state = _State()
    _apply_presence(state, 1, "thread-x", now=0)
    candidate = _apply_presence(state, 1, None, hidden=True, now=10)
    assert candidate is None
    assert state._warm_task_brief_away == {"thread-x": (10, 1)}
    assert state.frames == []


def test_short_same_thread_return_is_identified_but_below_threshold():
    state = _State()
    _apply_presence(state, 1, "thread-x", now=0)
    _apply_presence(state, 1, None, hidden=True, now=10)
    candidate = _apply_presence(state, 1, "thread-x", now=20)
    assert candidate == warm_task_brief.ReturnCandidate("thread-x", 10, 1)
    assert 20 - candidate.away_started < warm_task_brief.WARM_TASK_BRIEF_AWAY_SECS
    assert state._warm_task_brief_away == {}


def test_last_owner_tab_hidden_arms_one_episode():
    state = _State()
    _apply_presence(state, 1, "thread-x", now=0)
    _apply_presence(state, 2, "thread-x", now=0)
    _apply_presence(state, 1, None, hidden=True, now=10)
    assert state._warm_task_brief_away == {}
    _apply_presence(state, 2, None, hidden=True, now=20)
    assert state._warm_task_brief_away == {"thread-x": (20, 1)}


def test_chat_switch_and_unreasoned_null_never_arm():
    state = _State()
    _apply_presence(state, 1, "thread-x", now=0)
    _apply_presence(state, 1, "thread-y", now=10)
    _apply_presence(state, 1, None, now=20)
    assert state._warm_task_brief_away == {}


def test_return_to_other_thread_consumes_episode():
    state = _State()
    _apply_presence(state, 1, "thread-x", now=0)
    _apply_presence(state, 1, None, hidden=True, now=10)
    assert _apply_presence(state, 1, "thread-y", now=2000) is None
    assert _apply_presence(state, 1, "thread-x", now=2010) is None
    assert state._warm_task_brief_away == {}


def test_socket_cleanup_clears_retention_only_and_never_arms():
    state = _State()
    _apply_presence(state, 1, "thread-x", now=0)
    slot_retention.note_foreground(state, 1, None)
    assert state._foreground_slots == {}
    assert state._warm_task_brief_away == {}


def _snapshot(fingerprint: str = "fp", *, previous_claim: str = ""):
    return warm_task_brief.TaskSnapshot(
        slot_key="thread-x",
        history_key="dashboard:thread-x",
        original_request="Fix the failing test",
        fingerprint=fingerprint,
        transcript="User: Fix the failing test",
        session_state={"phase": "implementing"},
        conductor={"goal": "Fix the test"},
        work_items=({"state": "open", "summary": "Failure reproduced"},),
        previous_claim=previous_claim,
    )


@pytest.mark.asyncio
async def test_status_precedes_the_single_model_call_and_result_has_three_parts(monkeypatch):
    state = _State()
    slot = _Slot()
    state.slots[slot.key] = slot
    state._foreground_slots[1] = slot.key
    snapshot = _snapshot()

    async def read_snapshot(*args):
        return snapshot

    call_frames = []
    call_kwargs = {}

    async def run_model(*args, **kwargs):
        call_frames.extend(state.frames)
        call_kwargs.update(kwargs)
        return '{"current_state":["Failure reproduced"],"next_steps":["Apply the fix"]}'

    monkeypatch.setattr(warm_task_brief, "_snapshot", read_snapshot)
    monkeypatch.setattr(warm_task_brief, "run_bg_oneliner", run_model)
    monkeypatch.setattr(
        warm_task_brief.KiroCrewConfig,
        "load",
        lambda: SimpleNamespace(agent=SimpleNamespace(resolve_model=lambda role: "background")),
    )

    await warm_task_brief._prepare_warm_task_brief(
        state, slot, warm_task_brief.ReturnCandidate(slot.key, 0, 1)
    )

    assert call_frames == [
        (
            "warm_task_brief_status",
            {"slot": slot.key, "status": "preparing"},
        )
    ]
    assert slot.flushed == 2
    assert call_kwargs["crew_log_kind"] == "warm_task_brief"
    assert call_kwargs["crew_log_session_key"] == "dashboard:thread-x"
    assert call_kwargs["timeout"] == 60.0
    assert call_kwargs["retry_rejected_model"] is False
    assert slot.rows[0]["meta"] == {"kind": "warm_task_brief_claim", "fingerprint": "fp"}
    result = slot.rows[-1]
    assert result["meta"]["kind"] == "warm_task_brief"
    assert result["meta"]["original_request"] == "Fix the failing test"
    assert result["meta"]["current_state"] == ["Failure reproduced"]
    assert result["meta"]["next_steps"] == ["Apply the fix"]
    assert state.frames[-1][1]["status"] == "clear"


@pytest.mark.asyncio
async def test_existing_claim_suppresses_status_and_model(monkeypatch):
    state = _State()
    slot = _Slot()
    state.slots[slot.key] = slot
    state._foreground_slots[1] = slot.key

    async def read_snapshot(*args):
        return _snapshot(previous_claim="fp")

    async def unexpected(*args, **kwargs):
        raise AssertionError("model must not run")

    monkeypatch.setattr(warm_task_brief, "_snapshot", read_snapshot)
    monkeypatch.setattr(warm_task_brief, "run_bg_oneliner", unexpected)
    await warm_task_brief._prepare_warm_task_brief(
        state, slot, warm_task_brief.ReturnCandidate(slot.key, 0, 1)
    )
    assert state.frames == []
    assert slot.rows == []


@pytest.mark.asyncio
async def test_model_failure_replaces_preparing_with_unavailable(monkeypatch):
    state = _State()
    slot = _Slot()
    state.slots[slot.key] = slot
    state._foreground_slots[1] = slot.key
    snapshot = _snapshot()

    async def read_snapshot(*args):
        return snapshot

    async def fail(*args, **kwargs):
        raise RuntimeError("provider failed")

    monkeypatch.setattr(warm_task_brief, "_snapshot", read_snapshot)
    monkeypatch.setattr(warm_task_brief, "run_bg_oneliner", fail)
    monkeypatch.setattr(
        warm_task_brief.KiroCrewConfig,
        "load",
        lambda: SimpleNamespace(agent=SimpleNamespace(resolve_model=lambda role: "background")),
    )
    await warm_task_brief._prepare_warm_task_brief(
        state, slot, warm_task_brief.ReturnCandidate(slot.key, 0, 1)
    )
    assert [frame[1]["status"] for frame in state.frames] == ["preparing", "unavailable"]
    assert all(row.get("meta", {}).get("kind") != "warm_task_brief" for row in slot.rows)


@pytest.mark.asyncio
async def test_changed_task_suppresses_stale_result_and_clears_status(monkeypatch):
    state = _State()
    slot = _Slot()
    state.slots[slot.key] = slot
    state._foreground_slots[1] = slot.key
    snapshots = [_snapshot()] * 4 + [_snapshot("changed")]

    async def read_snapshot(*args):
        return snapshots.pop(0)

    async def run_model(*args, **kwargs):
        return '{"current_state":["Old state"],"next_steps":["Old next"]}'

    monkeypatch.setattr(warm_task_brief, "_snapshot", read_snapshot)
    monkeypatch.setattr(warm_task_brief, "run_bg_oneliner", run_model)
    monkeypatch.setattr(
        warm_task_brief.KiroCrewConfig,
        "load",
        lambda: SimpleNamespace(agent=SimpleNamespace(resolve_model=lambda role: "background")),
    )
    await warm_task_brief._prepare_warm_task_brief(
        state, slot, warm_task_brief.ReturnCandidate(slot.key, 0, 1)
    )
    assert [frame[1]["status"] for frame in state.frames] == ["preparing", "clear"]
    assert all(row.get("meta", {}).get("kind") != "warm_task_brief" for row in slot.rows)


@pytest.mark.asyncio
async def test_live_derivation_withheld_slot_never_claims_or_calls_model(monkeypatch):
    state = _State()
    slot = _Slot()
    slot.memory_mode = "incognito"
    state.slots[slot.key] = slot
    state._foreground_slots[1] = slot.key

    async def unexpected(*args, **kwargs):
        raise AssertionError("restricted transcript must not be read or sent")

    monkeypatch.setattr(warm_task_brief, "_snapshot", unexpected)
    monkeypatch.setattr(warm_task_brief, "run_bg_oneliner", unexpected)
    await warm_task_brief._prepare_warm_task_brief(
        state, slot, warm_task_brief.ReturnCandidate(slot.key, 0, 1)
    )
    assert slot.rows == []
    assert state.frames == []


@pytest.mark.asyncio
async def test_handle_focus_starts_once_only_on_eligible_return(monkeypatch):
    state = _State()
    slot = _Slot()
    state.slots[slot.key] = slot
    calls = []

    async def prepare(*args):
        calls.append(args[2])

    monkeypatch.setattr(warm_task_brief, "_prepare_warm_task_brief", prepare)
    state._warm_task_brief_away[slot.key] = (
        warm_task_brief.time.monotonic() - warm_task_brief.WARM_TASK_BRIEF_AWAY_SECS,
        1,
    )
    warm_task_brief.handle_focus_frame(state, 1, slot.key, owner=True)
    slot_retention.note_foreground(state, 1, slot.key)
    await asyncio.sleep(0)
    warm_task_brief.handle_focus_frame(state, 1, slot.key, owner=True)
    await asyncio.sleep(0)

    assert len(calls) == 1
    assert calls[0].slot_key == slot.key
    assert calls[0].generation == 1


def test_snapshot_fingerprint_ignores_claim_and_brief_rows(monkeypatch):
    slot = _Slot()
    rows = [
        {"role": "user", "content": "Original request", "ts": "1"},
        {"role": "assistant", "content": "Work started", "ts": "2"},
    ]
    log = SimpleNamespace(derive_messages_chained=lambda key: list(rows))
    state = SimpleNamespace(conversation_log=log)
    open_item = SimpleNamespace(
        item_id="it_1",
        title="Implement",
        state="open",
        verdict=None,
        decision="",
        worker_session_key="worker",
        status="progress",
        reason=None,
        summary="Started",
        artifacts={},
        last_report_at="3",
        closed_at=None,
        decided_at=None,
    )
    monkeypatch.setattr(warm_task_brief, "read_state", lambda key: {"phase": "implementing"})
    monkeypatch.setattr(warm_task_brief, "read_conductor", lambda key: None)
    monkeypatch.setattr(warm_task_brief, "list_work_items", lambda key: [open_item])

    first = warm_task_brief._snapshot_sync(state, slot)
    rows.extend(
        [
            {
                "role": "notice",
                "content": "",
                "meta": {"kind": "warm_task_brief_claim", "fingerprint": "old"},
            },
            {"role": "notice", "content": "summary", "meta": {"kind": "warm_task_brief"}},
            {"role": "user", "content": "[auto-nudge cycle 2]", "ts": "3"},
        ]
    )
    second = warm_task_brief._snapshot_sync(state, slot)

    assert first is not None and second is not None
    assert first.original_request == "Original request"
    assert first.fingerprint == second.fingerprint
    assert second.previous_claim == "old"


def test_terminal_task_is_not_eligible():
    assert not warm_task_brief._has_open_task(
        {"phase": "done"},
        {"goal": "Finished"},
        ({"state": "accepted"},),
    )


@pytest.mark.asyncio
async def test_second_leave_cancels_preparing_and_advances_generation():
    state = _State()
    state._foreground_slots[1] = "thread-x"
    state._warm_task_brief_statuses["thread-x"] = "preparing"
    task = asyncio.create_task(asyncio.sleep(60))
    state._warm_task_brief_tasks["thread-x"] = task

    warm_task_brief.note_focus_frame(state, 1, None, hidden=True, now=20)
    await asyncio.sleep(0)

    assert task.cancelled()
    assert state.frames[-1] == (
        "warm_task_brief_status",
        {"slot": "thread-x", "status": "clear"},
    )
    assert state._warm_task_brief_slot_generation["thread-x"] == 1


def test_non_owner_focus_cannot_arm_an_episode():
    state = _State()
    state._foreground_slots[7] = "thread-x"
    warm_task_brief.handle_focus_frame(state, 7, None, hidden=True, owner=False)
    assert state._warm_task_brief_away == {}


def test_gateway_restart_has_no_durable_away_episode():
    restarted = _State()
    restarted._foreground_slots[1] = "thread-x"
    warm_task_brief.handle_focus_frame(restarted, 1, "thread-x", owner=True)
    assert restarted._warm_task_brief_tasks == {}
    assert restarted._warm_task_brief_away == {}
