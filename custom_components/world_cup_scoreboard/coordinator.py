from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    CONF_FAVORITE_TEAM,
    CONF_NAME,
    DEFAULT_NAME,
    DEFAULT_SCAN_INTERVAL_SECONDS,
    DOMAIN,
    LIVE_SCAN_INTERVAL_SECONDS,
    LIVE_STATES,
    SCOREBOARD_URL,
    STATE_IN,
    STATE_POST,
)

_LOGGER = logging.getLogger(__name__)


def _humanize_slug(slug: str | None) -> str:
    """Turn ESPN's season slug (``group-stage``) into a label (``Group Stage``)."""
    if not slug:
        return ""
    return slug.replace("-", " ").replace("_", " ").title()


def _competitor(competitors: list[dict], home_away: str) -> dict[str, Any]:
    """Normalize one competitor (a side of a match) into the card-facing shape."""
    for c in competitors:
        if str(c.get("homeAway")).lower() == home_away:
            team = c.get("team") or {}
            return {
                "name": team.get("displayName") or team.get("name") or "",
                "short_name": team.get("shortDisplayName") or team.get("name") or "",
                "abbr": (team.get("abbreviation") or "").upper(),
                "logo": team.get("logo") or "",
                "color": team.get("color") or "",
                # ESPN reports score as a string; keep it as-is for display but
                # coerce a numeric copy for sorting/automations.
                "score": c.get("score"),
                "winner": bool(c.get("winner")),
            }
    return {"name": "", "short_name": "", "abbr": "", "logo": "", "color": "", "score": None, "winner": False}


def _normalize_event(event: dict[str, Any]) -> dict[str, Any] | None:
    """Flatten one ESPN ``event`` into a compact match dict for the card."""
    comps = event.get("competitions") or []
    if not comps:
        return None
    comp = comps[0]
    competitors = comp.get("competitors") or []
    status = (comp.get("status") or event.get("status") or {})
    stype = status.get("type") or {}
    state = str(stype.get("state", "")).lower()

    return {
        "id": event.get("id"),
        "date": event.get("date"),  # UTC ISO; card formats kickoff to local time
        "note": _humanize_slug((event.get("season") or {}).get("slug")),
        "status": {
            "state": state,
            "detail": stype.get("shortDetail") or stype.get("description") or "",
            "clock": status.get("displayClock") or "",
            "completed": bool(stype.get("completed")),
        },
        "home": _competitor(competitors, "home"),
        "away": _competitor(competitors, "away"),
    }


def _sort_key(match: dict[str, Any]) -> tuple[int, str]:
    """Order the board: live first, then upcoming, then finished — by kickoff."""
    state = match["status"]["state"]
    rank = {STATE_IN: 0}.get(state, 1 if state != STATE_POST else 2)
    return (rank, str(match.get("date") or ""))


class WorldCupScoreboardCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Polls the ESPN World Cup scoreboard and normalizes it for the card."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.favorite = str(entry.data.get(CONF_FAVORITE_TEAM) or "").upper().strip()
        self.display_name = str(entry.data.get(CONF_NAME) or entry.title or DEFAULT_NAME)
        self._session = async_get_clientsession(hass)

        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=DEFAULT_SCAN_INTERVAL_SECONDS),
        )

    async def _get_json(self, url: str) -> dict[str, Any]:
        headers = {"User-Agent": "Home Assistant", "Accept": "application/json"}
        async with self._session.get(url, headers=headers, timeout=20) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise UpdateFailed(f"HTTP {resp.status} for {url}: {text[:200]}")
            return await resp.json()

    def _pick_featured(self, matches: list[dict[str, Any]]) -> dict[str, Any]:
        """Return the favorite team's most relevant match (live > next > last)."""
        if not self.favorite:
            return {}
        mine = [
            m for m in matches
            if self.favorite in (m["home"]["abbr"], m["away"]["abbr"])
        ]
        if not mine:
            return {}
        # matches are already sorted live > upcoming > finished, so the first is best.
        return mine[0]

    def _build_board(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Flatten a scoreboard payload into the card-facing board dict.

        Shared by the live poll (``_async_update_data``) and on-demand day
        navigation (``async_get_board_for_date``), so both produce identically
        shaped boards. Pure with respect to ``self`` apart from the favorite —
        it does not touch the poll interval (that's the live refresh's job).
        """
        matches: list[dict[str, Any]] = []
        for event in payload.get("events") or []:
            m = _normalize_event(event)
            if m is not None:
                matches.append(m)
        matches.sort(key=_sort_key)

        live_count = sum(1 for m in matches if m["status"]["state"] in LIVE_STATES)
        league = (payload.get("leagues") or [{}])[0]
        calendar = (league.get("calendar") or [{}])[0]

        return {
            "league": league.get("name") or "FIFA World Cup",
            "season": (payload.get("season") or {}).get("year"),
            "matches": matches,
            "featured": self._pick_featured(matches),
            "live_count": live_count,
            "match_count": len(matches),
            # Anchor day for the card's ±1-day navigation. ESPN's day boundary
            # is not midnight-UTC (today's board can include matches that fall on
            # the next UTC date), so the card must step from this value rather
            # than from a UTC clock.
            "day": (payload.get("day") or {}).get("date"),
            # Tournament window — lets the card disable arrows at the edges.
            "calendar_start": calendar.get("startDate"),
            "calendar_end": calendar.get("endDate"),
        }

    async def _async_update_data(self) -> dict[str, Any]:
        payload = await self._get_json(SCOREBOARD_URL)
        board = self._build_board(payload)

        # Tighten the poll interval while a match is live so the score and clock
        # stay fresh; relax it back when nothing is on.
        desired = (
            LIVE_SCAN_INTERVAL_SECONDS if board["live_count"] else DEFAULT_SCAN_INTERVAL_SECONDS
        )
        if self.update_interval != timedelta(seconds=desired):
            self.update_interval = timedelta(seconds=desired)

        return board

    async def async_get_board_for_date(self, date_str: str) -> dict[str, Any]:
        """Return the board for a single ``YYYYMMDD`` day for card navigation.

        Used by the ``world_cup_scoreboard/board_at_date`` WebSocket command so
        the card's ◀ ▶ arrows can page back through previous results and forward
        through upcoming match days without disturbing the shared live sensor
        (which always tracks today). ``has_prev``/``has_next`` flag whether the
        neighboring day still falls inside the tournament calendar window.
        """
        url = f"{SCOREBOARD_URL}?dates={date_str}"
        payload = await self._get_json(url)
        board = self._build_board(payload)

        # A dated query omits the ``day`` label that the default board carries,
        # so pin it to the requested date (``YYYYMMDD`` -> ``YYYY-MM-DD``). The
        # card uses this both as the display label and as the value compared
        # against the calendar edges below.
        day = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
        board["day"] = day

        # Bound navigation to the tournament window. Compare the requested day
        # against the calendar's YYYY-MM-DD edges; default to "navigable" when
        # the calendar is absent.
        start = (board.get("calendar_start") or "")[:10]
        end = (board.get("calendar_end") or "")[:10]
        board["has_prev"] = not (start and day and day <= start)
        board["has_next"] = not (end and day and day >= end)
        return board
