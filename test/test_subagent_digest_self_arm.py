"""A member's digest of sub-agents it spawned ITSELF may arm a loop on itself.

The chain pinned here, end to end except the gateway's dispatch line (pinned by a
source ratchet below):

    POST /api/spawn  ->  note_spawner (transport identity)  ->  attested_own_subagent
                     ->  apply_session_directive(producer_is_own_subagent=...)
                     ->  autonudge_authz (unchanged self-arm rule)

(a) an internal caller the transport attests as the parent: the digest arms;
(b) an owner-browser or app-token spawn naming the member as parent: the digest
    stays refused (409, nothing armed), and its refusal names the turn origin.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

import pytest
from member_memory_helpers import env  # noqa: F401  (fixture)
from member_memory_helpers import make_request

from kiro_crew import autonudge_authz
from kiro_crew.dashboard import session_directive_apply as sda

pytestmark = pytest.mark.xdist_group("member_memory_api")

PARENT = "dashboard:alice"


class _Svc:
    def __init__(self) -> None:
        self.added: list[dict[str, Any]] = []

    def get_by_slot(self, slot_key: str) -> Any:
        return None

    def get_by_id(self, loop_id: str) -> Any:
        return None

    async def add(self, **kw: Any) -> Any:
        self.added.append(kw)
        return SimpleNamespace(
            id=kw.get("loop_id") or "loop-1",
            slot_key=kw["slot_key"],
            idle_secs=kw["idle_secs"],
            max_cycles=kw["max_cycles"],
            monitor=None,
            gate=False,
            next_due_ts=0.0,
        )


@pytest.fixture(autouse=True)
def _fresh_registry(_floor_monkeypatch: pytest.MonkeyPatch) -> None:
    _floor_monkeypatch.setattr(sda, "_ATTESTED_SPAWNERS", {})
    _floor_monkeypatch.setattr(sda, "_TAINTED_WAVES", set())
    _floor_monkeypatch.setattr(sda, "_TURN_MAY_SELF_ARM", set())
    _floor_monkeypatch.setattr(sda, "_ATTESTATION_OFF", False)
    _floor_monkeypatch.setattr(
        autonudge_authz,
        "sel",
        lambda: SimpleNamespace(log_tool_invocation=lambda **kw: None),
    )
    _floor_monkeypatch.setattr(autonudge_authz, "record_self_arm", lambda *_a: None)


async def _spawn(
    env: Any, shape: str, run_id: str = "run-1", *, turn_eligible: bool = True  # noqa: F811
) -> int:
    """Spawn with *shape* while the member's current turn is (or is not) self-arm eligible,
    as ``chat_runner`` stamps it at turn start (a user turn vs a cron or app turn)."""
    from kiro_crew.dashboard.handlers import messaging

    sda.note_turn_self_arm("alice", turn_eligible)
    env.state.subagents = SimpleNamespace(
        spawn=mock.Mock(return_value=SimpleNamespace(id=run_id, done=False))
    )
    req = make_request(
        env.state,
        "/api/spawn",
        body={"task": "triage", "parent_session": PARENT, "batch_id": "b1"},
        owner=shape == "owner",
        internal=shape == "internal",
    )
    if shape == "app":
        req["app"] = "issue-radar"
    response = await messaging.api_spawn(req)
    return response.status


async def _digest_arms(run_id: str = "run-1") -> tuple[str, _Svc]:
    """The member's model issues monitor_start from the digest turn of *run_id*."""
    svc = _Svc()
    slot = SimpleNamespace(workspace="default", mode="member", memory_mode="persistent")
    with (
        mock.patch("kiro_crew.autonudge.get_instance", return_value=svc),
        mock.patch("kiro_crew.dashboard.state.append_and_surface", mock.MagicMock()),
        mock.patch.object(sda, "_audit"),
    ):
        result = await sda.apply_session_directive(
            SimpleNamespace(_slots={"alice": slot}, sessions=None, channel_transports={}),
            SimpleNamespace(key="alice", _app="", messages=[]),
            PARENT,
            "monitor_start",
            {"message": "patrol", "idle_secs": 1800},
            producer_turn_actor="subagent",
            producer_is_own_subagent=sda.attested_own_subagent(run_id, PARENT, "b1"),
        )
    return result, svc


@pytest.mark.asyncio
async def test_own_attested_spawn_lets_its_digest_arm_the_member(env) -> None:  # noqa: F811
    assert await _spawn(env, "internal") == 200
    result, svc = await _digest_arms()
    assert "started on this session" in result
    assert len(svc.added) == 1 and svc.added[0]["self_armed"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("shape", ["owner", "app"])
async def test_a_spawn_naming_the_member_as_parent_stays_refused(env, shape) -> None:  # noqa: F811
    assert await _spawn(env, shape) == 200
    result, svc = await _digest_arms()
    assert result.endswith("[status 409]")
    assert svc.added == []
    assert "this turn was started by a sub-agent result" in result
    assert "send the request yourself in this chat" in result


@pytest.mark.asyncio
async def test_a_cron_or_app_turn_on_the_member_cannot_launder_an_arm(env) -> None:  # noqa: F811
    """The member's own attested MCP, but from a cron/app turn: still refused."""
    assert await _spawn(env, "internal", turn_eligible=False) == 200
    result, svc = await _digest_arms()
    assert result.endswith("[status 409]") and svc.added == []


def test_only_the_turn_runner_stamps_turn_eligibility() -> None:
    import kiro_crew

    root = Path(kiro_crew.__file__).resolve().parent
    callers = sorted(
        path.relative_to(root).as_posix()
        for path in root.rglob("*.py")
        if "note_turn_self_arm(" in path.read_text(encoding="utf-8", errors="replace")
    )
    assert callers == ["dashboard/chat_runner.py", "dashboard/session_directive_apply.py"]


@pytest.mark.parametrize(
    ("run_kwargs", "eligible"),
    [
        ({}, True),  # a user-sent turn
        ({"_directive_user_origin": False, "_turn_actor": "cron"}, False),
        ({"_directive_user_origin": False, "_turn_actor": "app"}, False),
        ({"_directive_user_origin": False, "_directive_self_wake": True}, False),
        ({"_directive_user_origin": False, "_directive_own_subagent": True}, False),
    ],
)
def test_a_real_turn_stamps_its_eligibility_and_clears_it(run_kwargs, eligible) -> None:
    import asyncio

    from turn_harness import Do, TurnScript, run_turn

    seen: dict[str, Any] = {}

    def _during(ctx: Any) -> None:
        seen["key"] = ctx.slot.key
        seen["inside"] = ctx.slot.key in sda._TURN_MAY_SELF_ARM

    asyncio.run(run_turn(TurnScript(events=(Do(_during),), run_kwargs=run_kwargs)))
    assert seen["inside"] is eligible
    assert seen["key"] not in sda._TURN_MAY_SELF_ARM, "cleared at the turn's end"


@pytest.mark.parametrize("producer", ["_directive_self_wake", "_directive_own_subagent"])
def test_a_wake_or_digest_spawned_childs_digest_is_refused(env, producer) -> None:  # noqa: F811
    """A loop the user stopped must not re-arm through a child its wake spawned."""
    import asyncio

    from turn_harness import Do, TurnScript, run_turn

    seen: dict[str, bool] = {}

    def _during(ctx: Any) -> None:
        seen["eligible"] = ctx.slot.key in sda._TURN_MAY_SELF_ARM

    kwargs = {"_directive_user_origin": False, producer: True}
    asyncio.run(run_turn(TurnScript(events=(Do(_during),), run_kwargs=kwargs)))
    assert seen["eligible"] is False

    async def _spawn_then_digest() -> tuple[str, _Svc]:
        assert await _spawn(env, "internal", turn_eligible=seen["eligible"]) == 200
        return await _digest_arms()

    result, svc = asyncio.run(_spawn_then_digest())
    assert result.endswith("[status 409]") and svc.added == []


def test_a_prompts_get_turn_clears_its_eligibility_at_its_end() -> None:
    """``/prompts get`` re-enters at depth 1 and hands that frame the turn's tail."""
    import asyncio

    from turn_harness import Do, TurnScript, run_turn

    seen: dict[str, Any] = {}

    def _during(ctx: Any) -> None:
        seen["key"] = ctx.slot.key
        seen["inside"] = ctx.slot.key in sda._TURN_MAY_SELF_ARM

    script = TurnScript(message="/prompts get demo", events=(Do(_during),))
    with mock.patch(
        "kiro_crew.dashboard.chat_runner._resolve_prompt_mention",
        lambda message, project_dir: ("expanded prompt body", "ok", ""),
    ):
        asyncio.run(run_turn(script))
    assert seen["inside"] is True, "the expanded turn ran as the user-sent turn"
    assert seen["key"] not in sda._TURN_MAY_SELF_ARM, "cleared at the turn's end"


@pytest.mark.asyncio
async def test_an_unattested_spawn_taints_its_wave(env) -> None:  # noqa: F811
    assert await _spawn(env, "internal", "run-1") == 200
    assert await _spawn(env, "app", "run-2") == 200
    result, svc = await _digest_arms("run-1")
    assert result.endswith("[status 409]") and svc.added == []


async def _lost(env: Any, shape: str) -> int:  # noqa: F811
    """POST /api/spawn/lost for wave b1, whose ``reason`` lands in the digest."""
    from kiro_crew.dashboard.handlers import messaging

    env.state.subagents = SimpleNamespace(record_lost_submission=mock.Mock())
    req = make_request(
        env.state,
        "/api/spawn/lost",
        body={"batch_id": "b1", "batch_total": 2, "reason": "x", "parent_session": PARENT},
        owner=shape == "owner",
        internal=shape == "internal",
    )
    if shape == "app":
        req["app"] = "issue-radar"
    response = await messaging.api_spawn_lost(req)
    env.state.subagents.record_lost_submission.assert_called_once()
    return response.status


@pytest.mark.asyncio
@pytest.mark.parametrize(("shape", "arms"), [("internal", True), ("owner", False), ("app", False)])
async def test_an_unattested_lost_report_taints_its_wave(env, shape, arms) -> None:  # noqa: F811
    assert await _spawn(env, "internal", "run-1") == 200
    assert await _lost(env, shape) == 200
    result, svc = await _digest_arms("run-1")
    assert (len(svc.added) == 1) is arms
    assert result.endswith("[status 409]") is not arms


_CHILD = SimpleNamespace(
    id="run-1",
    parent_session_key=PARENT,
    batch_id="b1",
    done=True,
    outcome="failed",
    agent="",
    task="triage",
    _raw_task="triage",
    cwd="",
    max_turns=0,
    model="",
    reasoning_effort=None,
    backend=None,
    approval_mode="",
    silent=False,
    delegation={},
    include_memory=False,
    include_lessons=False,
    include_project=False,
    memory_store="",
    crew="",
    execution_context=SimpleNamespace(app="", memory_mode="persistent", to_record=dict),
)


async def _child_write(
    env: Any, route: str, shape: str, *, turn_eligible: bool  # noqa: F811
) -> int:
    """Write into the attested child ``run-1`` through *route* as *shape*."""
    from kiro_crew.dashboard.handlers import messaging

    sda.note_turn_self_arm("alice", turn_eligible)
    started = SimpleNamespace(id="run-9", done=False, error="")
    env.state.subagents = SimpleNamespace(
        get=lambda _id: _CHILD,
        steer_run=mock.AsyncMock(return_value=(True, "")),
        follow_up_run=mock.AsyncMock(return_value=(True, "")),
        claim_retry=lambda _old: None,
        settle_retry=lambda *_a: None,
        recorded_cwd=lambda _id: "",
        max_concurrent=4,
    )
    body: dict[str, Any] = {
        "steer": {"message": "x"},
        "follow_up": {"message": "x", "mode": "follow_up"},
        "continue": {"task": "x", "parent_session": PARENT},
        "retry": {},
    }[route]
    req = make_request(
        env.state,
        f"/api/spawn/run-1/{'steer' if route == 'follow_up' else route}",
        body=body,
        owner=shape == "owner",
        internal=shape == "internal",
        match_info={"agent_id": "run-1"},
    )
    handler = {
        "steer": messaging.api_spawn_steer,
        "follow_up": messaging.api_spawn_steer,
        "continue": messaging.api_spawn_continue,
        "retry": messaging.api_spawn_retry,
    }[route]
    with (
        mock.patch.object(messaging, "_continue_on_loop", mock.AsyncMock(return_value=started)),
        mock.patch.object(messaging, "_spawn_on_loop", mock.AsyncMock(return_value=started)),
    ):
        response = await handler(req)
    return response.status


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["steer", "follow_up", "continue", "retry"])
@pytest.mark.parametrize(
    ("shape", "turn_eligible", "arms"),
    [("internal", True, True), ("internal", False, False), ("owner", True, False)],
)
async def test_a_child_write_keeps_self_arm_only_from_a_user_turn(
    env, route, shape, turn_eligible, arms  # noqa: F811
) -> None:
    """Steer (both modes), continue and retry: a non-user write revokes and taints."""
    assert await _spawn(env, "internal", "run-1") == 200
    assert await _child_write(env, route, shape, turn_eligible=turn_eligible) == 200
    result, svc = await _digest_arms("run-1")
    assert (len(svc.added) == 1) is arms, result
    if route == "continue":
        assert sda.attested_own_subagent("run-9", PARENT, "") is arms
    if route == "retry":  # the retried run never attests (fail closed)
        assert sda.attested_own_subagent("run-9", PARENT, "") is False


def test_every_child_write_route_goes_through_the_shared_gate() -> None:
    """A route that writes into a child must call ``note_child_write``; a new one
    that reaches a child-write manager method without it fails here."""
    import ast

    import kiro_crew

    writes = {
        "_spawn_on_loop",
        "_continue_on_loop",
        "steer_run",
        "follow_up_run",
        "record_lost_submission",
        "claim_retry",
    }
    owners = Path(kiro_crew.__file__).resolve().parent / "dashboard" / "messaging_api"
    found: dict[str, bool] = {}
    for path in owners.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for fn in tree.body:
            if not isinstance(fn, ast.AsyncFunctionDef) or not fn.name.startswith("api_"):
                continue
            names = {
                getattr(n.func, "attr", getattr(n.func, "id", ""))
                for n in ast.walk(fn)
                if isinstance(n, ast.Call)
            }
            if names & writes:
                found[fn.name] = bool(names & {"note_child_write", "note_write_into_child"})
    assert sorted(found) == sorted(sda.CHILD_WRITE_ROUTES)
    assert all(found.values()), found


def test_taint_overflow_latches_attestation_off(_floor_monkeypatch: pytest.MonkeyPatch) -> None:
    """A flood must not clear a taint and let a later attested sibling re-trust its wave."""
    _floor_monkeypatch.setattr(sda, "_SPAWNER_CAP", 3)  # 4th taint overflows; the rest fit
    sda.note_spawner("", "dashboard:other", "b1", attested=False)  # contaminates wave b1
    for n in range(3):
        sda.note_spawner("", "dashboard:other", f"w{n}", attested=False)
    sda.note_spawner("run-1", PARENT, "b1", attested=True)  # attested sibling, after the flood
    sda.note_spawner("run-9", PARENT, "fresh", attested=True)
    assert not sda.attested_own_subagent("run-1", PARENT, "b1")
    assert not sda.attested_own_subagent("run-9", PARENT, "fresh")


def test_many_attested_spawns_never_latch(_floor_monkeypatch: pytest.MonkeyPatch) -> None:
    """Normal use must not turn the feature off: attested rows age out one by one."""
    _floor_monkeypatch.setattr(sda, "_SPAWNER_CAP", 3)
    for n in range(10):
        sda.note_spawner(f"run-{n}", PARENT, f"b{n}", attested=True)
    assert sda.attested_own_subagent("run-9", PARENT, "b9")
    assert not sda.attested_own_subagent("run-0", PARENT, "b0")  # aged out: fails closed


def test_a_taint_under_another_parent_still_taints_the_batch() -> None:
    """The gateway groups a wave by batch id alone, so the taint must too."""
    sda.note_spawner("run-1", PARENT, "b1", attested=True)
    assert sda.attested_own_subagent("run-1", PARENT, "b1")
    sda.note_spawner("run-2", "dashboard:other", "b1", attested=False)
    assert not sda.attested_own_subagent("run-1", PARENT, "b1")


def test_only_the_gateway_digest_sets_the_own_subagent_mark() -> None:
    """Ratchet: the mark admits a self-arm, so exactly one dispatcher may set it,
    and only from the attested registry."""
    import kiro_crew

    root = Path(kiro_crew.__file__).resolve().parent
    setters = []
    for path in root.rglob("*.py"):
        text = path.read_text(encoding="utf-8", errors="replace")
        if re.search(r"\b_directive_own_subagent\s*=(?!=)", text):
            setters.append(path.relative_to(root).as_posix())
    assert sorted(setters) == ["slack/gateway.py"]
    gateway = (root / "slack" / "gateway.py").read_text(encoding="utf-8")
    assert re.search(r"_directive_own_subagent=attested_own_subagent\(", gateway)


def test_refusal_text_without_a_known_origin() -> None:
    reason = json.dumps(autonudge_authz.external_arm_refusal("member"))
    reworded = sda._origin_arm_refusal(reason, "")
    assert "started by something other than the user" in reworded
    assert "do not accept direct automation" not in reworded
