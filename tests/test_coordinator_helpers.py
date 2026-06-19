"""Unit tests for the pure helper functions in :mod:`coordinator`.

These exercise small, pure transformations of ESPN payload shapes. The
fixtures are hand-crafted minimal payloads — they reflect only the keys the
helpers actually read, not full ESPN responses.
"""

from __future__ import annotations

from custom_components.world_cup_scoreboard.const import (
    STATE_IN,
    STATE_POST,
    STATE_PRE,
)
from custom_components.world_cup_scoreboard.coordinator import (
    WorldCupScoreboardCoordinator as Coord,
)
from custom_components.world_cup_scoreboard.coordinator import (
    _competitor,
    _humanize_slug,
    _normalize_event,
    _sort_key,
)

# ---------------------------------------------------------------------------
# _humanize_slug
# ---------------------------------------------------------------------------


def test_humanize_slug_basic():
    assert _humanize_slug("group-stage") == "Group Stage"


def test_humanize_slug_underscores():
    assert _humanize_slug("round_of_16") == "Round Of 16"


def test_humanize_slug_empty_and_none():
    assert _humanize_slug(None) == ""
    assert _humanize_slug("") == ""


# ---------------------------------------------------------------------------
# _competitor
# ---------------------------------------------------------------------------


def _competitors():
    return [
        {
            "homeAway": "home",
            "score": "2",
            "winner": True,
            "team": {
                "displayName": "United States",
                "shortDisplayName": "USA",
                "abbreviation": "usa",
                "logo": "https://example/usa.png",
                "color": "002868",
            },
        },
        {
            "homeAway": "away",
            "score": "1",
            "winner": False,
            "team": {
                "displayName": "Brazil",
                "shortDisplayName": "BRA",
                "abbreviation": "bra",
                "logo": "https://example/bra.png",
            },
        },
    ]


def test_competitor_home_normalizes_and_uppercases_abbr():
    home = _competitor(_competitors(), "home")
    assert home["name"] == "United States"
    assert home["abbr"] == "USA"  # uppercased from "usa"
    assert home["score"] == "2"  # kept as string
    assert home["winner"] is True
    assert home["logo"] == "https://example/usa.png"


def test_competitor_away():
    away = _competitor(_competitors(), "away")
    assert away["abbr"] == "BRA"
    assert away["winner"] is False
    assert away["color"] == ""  # missing key falls back to empty string


def test_competitor_missing_side_returns_empty_shape():
    empty = _competitor(_competitors(), "neither")
    assert empty["abbr"] == ""
    assert empty["score"] is None
    assert empty["winner"] is False


# ---------------------------------------------------------------------------
# _normalize_event
# ---------------------------------------------------------------------------


def _event(state="in", slug="group-stage"):
    return {
        "id": "401",
        "date": "2026-06-19T18:00Z",
        "season": {"slug": slug},
        "competitions": [
            {
                "status": {
                    "displayClock": "45'+2'",
                    "type": {
                        "state": state,
                        "shortDetail": "1st Half",
                        "completed": state == "post",
                    },
                },
                "competitors": _competitors(),
            }
        ],
    }


def test_normalize_event_flattens_match():
    m = _normalize_event(_event())
    assert m["id"] == "401"
    assert m["note"] == "Group Stage"
    assert m["status"]["state"] == "in"
    assert m["status"]["clock"] == "45'+2'"
    assert m["status"]["completed"] is False
    assert m["home"]["abbr"] == "USA"
    assert m["away"]["abbr"] == "BRA"


def test_normalize_event_completed_flag():
    m = _normalize_event(_event(state="post"))
    assert m["status"]["state"] == "post"
    assert m["status"]["completed"] is True


def test_normalize_event_without_competitions_returns_none():
    assert _normalize_event({"id": "x", "competitions": []}) is None
    assert _normalize_event({"id": "x"}) is None


# ---------------------------------------------------------------------------
# _sort_key  (live -> upcoming -> finished, then by kickoff date)
# ---------------------------------------------------------------------------


def _match(state, date):
    return {"status": {"state": state}, "date": date}


def test_sort_key_orders_live_first_then_pre_then_post():
    matches = [
        _match(STATE_POST, "2026-06-19T12:00Z"),
        _match(STATE_PRE, "2026-06-19T21:00Z"),
        _match(STATE_IN, "2026-06-19T18:00Z"),
    ]
    ordered = sorted(matches, key=_sort_key)
    states = [m["status"]["state"] for m in ordered]
    assert states == [STATE_IN, STATE_PRE, STATE_POST]


def test_sort_key_tiebreaks_by_date():
    earlier = _match(STATE_PRE, "2026-06-19T15:00Z")
    later = _match(STATE_PRE, "2026-06-19T21:00Z")
    assert sorted([later, earlier], key=_sort_key) == [earlier, later]


# ---------------------------------------------------------------------------
# WorldCupScoreboardCoordinator._pick_featured
# ---------------------------------------------------------------------------


def _featured_coord(favorite):
    # Bypass __init__ (which needs a live HA hass/entry) — _pick_featured only
    # reads self.favorite.
    coord = Coord.__new__(Coord)
    coord.favorite = favorite
    return coord


def _board():
    return [
        {"id": "1", "home": {"abbr": "BRA"}, "away": {"abbr": "ARG"}},
        {"id": "2", "home": {"abbr": "USA"}, "away": {"abbr": "MEX"}},
    ]


def test_pick_featured_returns_first_match_with_favorite():
    coord = _featured_coord("USA")
    assert coord._pick_featured(_board())["id"] == "2"


def test_pick_featured_matches_away_side_too():
    coord = _featured_coord("MEX")
    assert coord._pick_featured(_board())["id"] == "2"


def test_pick_featured_empty_when_no_favorite():
    coord = _featured_coord("")
    assert coord._pick_featured(_board()) == {}


def test_pick_featured_empty_when_favorite_not_playing():
    coord = _featured_coord("ESP")
    assert coord._pick_featured(_board()) == {}
