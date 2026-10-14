"""An unmapped custom agent keeps the skill trees kiro-cli lets it inherit.

kiro-cli gives a custom agent the default skill trees (``~/.kiro/skills`` and
the workspace's ``.kiro/skills``) unless ``chat.disableInheritingDefaultResources``
turns that off. Crew's native launches turn it off to bound the startup catalog,
so Crew supplies those trees itself: as the agent's skill scope, and with the
``skill_search`` tool on its native view so the listed skills can load.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from kiro_crew import agent_discovery, context
from kiro_crew.acp import skill_projection as projection


@pytest.fixture
def kiro_tree(tmp_path, monkeypatch):
    """A kiro-cli home holding one global skill, an agents dir and a project."""
    monkeypatch.delenv("KIROCREW_NATIVE_SKILL_PROJECTION", raising=False)
    home = tmp_path / "kiro"
    agents = home / "agents"
    agents.mkdir(parents=True)
    skill = home / "skills" / "deploy-helper"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: deploy-helper\n---\nBody\n", encoding="utf-8")
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setattr(projection, "kiro_home", lambda: home)
    monkeypatch.setattr("kiro_crew.config.paths.kiro_home", lambda: home)
    return home, agents, project


def _write_agent(agents: Path, spec: dict) -> None:
    (agents / f"{spec['name']}.json").write_text(json.dumps(spec), encoding="utf-8")


def _disable_inheritance(project: Path) -> None:
    settings = project / ".kiro" / "settings" / "cli.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text(json.dumps({projection._INHERIT_SETTING: True}), encoding="utf-8")


def _globs(agent: str, agents: Path, **kw) -> list[str]:
    return agent_discovery.agent_skill_globs(agent, agents_dir=agents, **kw)


def test_unmapped_custom_agent_inherits_the_global_skill_tree(kiro_tree):
    home, agents, _project = kiro_tree
    _write_agent(agents, {"name": "custom", "tools": ["read"]})
    assert _globs("custom", agents, inherit_defaults=True) == [
        str(home / "skills" / "*" / "SKILL.md")
    ]
    # Listing callers (no inherit_defaults) still read the authored mapping only.
    assert _globs("custom", agents) == []


def test_workspace_skill_tree_is_inherited_too(kiro_tree):
    home, _agents, project = kiro_tree
    (project / ".kiro" / "skills").mkdir(parents=True)
    assert agent_discovery.inherited_skill_globs(project) == [
        str(home / "skills" / "*" / "SKILL.md"),
        str(project / ".kiro" / "skills" / "*" / "SKILL.md"),
    ]


def test_a_missing_tree_is_left_out(kiro_tree):
    home, _agents, project = kiro_tree
    for child in (home / "skills").rglob("*"):
        if child.is_file():
            child.unlink()
    (home / "skills" / "deploy-helper").rmdir()
    (home / "skills").rmdir()
    assert agent_discovery.inherited_skill_globs(project) == []


def test_workspace_that_opts_out_of_inheritance_gets_no_skills(kiro_tree):
    _home, _agents, project = kiro_tree
    _disable_inheritance(project)
    assert agent_discovery.inherited_skill_globs(project) == []


def test_global_opt_out_of_inheritance_gets_no_skills(kiro_tree):
    home, agents, _project = kiro_tree
    settings = home / "settings" / "cli.json"
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({projection._INHERIT_SETTING: True}), encoding="utf-8")
    _write_agent(agents, {"name": "custom", "tools": ["read"]})
    assert _globs("custom", agents, inherit_defaults=True) == []


def test_mapped_custom_agent_keeps_only_its_own_mapping(kiro_tree):
    _home, agents, _project = kiro_tree
    _write_agent(agents, {"name": "custom", "resources": ["skill:///opt/skills/one/SKILL.md"]})
    assert _globs("custom", agents, inherit_defaults=True) == ["/opt/skills/one/SKILL.md"]


@pytest.mark.parametrize(
    "spec",
    [
        {"tools": []},
        {"excludedTools": ["@kirocrew-core/skill_search"]},
        {"excludedTools": ["@kirocrew-core"]},
        {"mcpServers": {"kirocrew-core": {"disabled": True}}},
        {"mcpServers": {"kirocrew-core": {"disabledTools": ["skill_search"]}}},
    ],
    ids=["zero-tools", "search-excluded", "core-excluded", "core-disabled", "search-disabled"],
)
def test_agent_that_withholds_skill_search_inherits_nothing(kiro_tree, spec):
    _home, agents, _project = kiro_tree
    _write_agent(agents, {"name": "custom", **spec})
    assert _globs("custom", agents, inherit_defaults=True) == []


def test_default_agent_is_unchanged(kiro_tree):
    _home, agents, _project = kiro_tree
    _write_agent(agents, {"name": "kirocrew", "tools": ["*"]})
    assert _globs("kirocrew", agents, inherit_defaults=True) == []


def test_injection_plan_gives_the_inherited_trees_to_an_unmapped_custom_agent(
    kiro_tree, monkeypatch
):
    home, agents, project = kiro_tree
    _write_agent(agents, {"name": "custom", "tools": ["read"]})
    monkeypatch.setattr(agent_discovery, "_kiro_agents_dir", lambda: agents)
    monkeypatch.setattr(
        agent_discovery,
        "list_agents",
        lambda **kw: [SimpleNamespace(name="custom", filename="custom.json", scope="global")],
    )
    inject, globs = context._skills_injection_plan("custom", is_cc=False, project_dir=project)
    assert inject is True
    assert globs == [str(home / "skills" / "*" / "SKILL.md")]

    _disable_inheritance(project)
    assert context._skills_injection_plan("custom", is_cc=False, project_dir=project) == (
        False,
        [],
    )


@pytest.fixture
def native_custom(kiro_tree, tmp_path, monkeypatch):
    home, agents, project = kiro_tree
    monkeypatch.setattr(projection, "data_home", lambda: tmp_path / "crew", raising=False)
    monkeypatch.setattr(projection, "kiro_agents_dir", lambda: agents)
    monkeypatch.setattr(projection.platform_compat, "path_volume_is_remote", lambda path: False)
    monkeypatch.setattr(projection.platform_compat, "first_linked_ancestor", lambda path: None)
    monkeypatch.setattr(
        "kiro_crew.agent.managed_mcp_spec_entry",
        lambda name: {"command": "test-core", "args": []},
    )
    monkeypatch.setattr(
        projection,
        "list_agents",
        lambda **kw: [SimpleNamespace(name="custom", filename="custom.json", scope="global")],
    )
    monkeypatch.setattr("kiro_crew.agent._KIRO_MCP_JSON", home / "settings" / "mcp.json")
    return agents, project


def test_native_view_of_an_inheriting_agent_gets_skill_search(native_custom):
    agents, project = native_custom
    _write_agent(agents, {"name": "custom", "tools": ["read"]})
    view = projection.prepare_native_skill_projection(project).specs["custom"]
    assert view["tools"] == ["read", projection._SEARCH_TOOL]
    assert "kirocrew-core" in view["mcpServers"]


def test_native_view_of_a_zero_tool_agent_stays_zero_tool(native_custom):
    agents, project = native_custom
    _write_agent(agents, {"name": "custom", "tools": []})
    view = projection.prepare_native_skill_projection(project).specs["custom"]
    assert view["tools"] == []
    assert "kirocrew-core" not in view.get("mcpServers", {})


def test_native_view_without_inheritance_gets_no_search(native_custom):
    agents, project = native_custom
    _disable_inheritance(project)
    _write_agent(agents, {"name": "custom", "tools": ["read"]})
    view = projection.prepare_native_skill_projection(project).specs["custom"]
    assert view["tools"] == ["read"]
