"""List-form trailer agreement across dashboard and channel readers."""

import json
from pathlib import Path

import pytest

from kiro_crew.dashboard.state import _parse_options
from kiro_crew.messaging.renderer import split_options_trailer
from kiro_crew.slack.format import extract_options
from kiro_crew.whatsapp.turn_renderer import _strip_options

CASES = json.loads(
    (Path(__file__).parent / "fixtures/options_list.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_list_options_agree_across_surfaces(case):
    text = case["input"]
    body = case.get("body", text)
    options = case["options"]
    assert split_options_trailer(text) == (body, options)
    assert split_options_trailer(text, hide_partial=True) == (body, options)
    assert extract_options(text) == (body, options)
    assert _parse_options(text) == options
    assert _strip_options(text) == body.strip()


def test_dashboard_prefers_trailing_list_over_earlier_marker():
    assert _parse_options("[OPTION: Old]\n[OPTIONS]\n- New") == ["New"]
