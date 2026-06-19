from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, PLATFORMS
from .coordinator import WorldCupScoreboardCoordinator

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type RuntimeData = WorldCupScoreboardCoordinator

# Read version from manifest.json for cache busting.
_MANIFEST_PATH = Path(__file__).parent / "manifest.json"
try:
    with open(_MANIFEST_PATH) as f:
        _VERSION = json.load(f).get("version", "0.0.0")
except Exception:
    _VERSION = "0.0.0"

# Cache buster: convert 0.1.0 -> 010
_VERSION_NUM = _VERSION.replace(".", "")
CARD_FILENAME = "world-cup-scoreboard-card.js"
# ``/hacsfiles/<name>/`` is mapped by HACS to ``<config>/www/community/<name>/``.
HACS_URL_BASE = f"/hacsfiles/{DOMAIN}/{CARD_FILENAME}"
# Legacy/fallback URL served straight from the integration package directory.
LEGACY_URL_BASE = f"/{DOMAIN}/{CARD_FILENAME}"
FALLBACK_URL_BASE = LEGACY_URL_BASE


def _sync_card_to_www_community(hass_config_path: str, source: Path) -> Path | None:
    """Copy the bundled card JS into ``<config>/www/community/<DOMAIN>/``.

    Returns the target path on success, or ``None`` if the copy could not be
    completed (callers then fall back to serving from the package directory).
    """
    try:
        target_dir = Path(hass_config_path) / "www" / "community" / DOMAIN
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / CARD_FILENAME
        if target.exists():
            src_stat = source.stat()
            dst_stat = target.stat()
            if (
                src_stat.st_size == dst_stat.st_size
                and int(src_stat.st_mtime) == int(dst_stat.st_mtime)
            ):
                return target
        shutil.copy2(source, target)
        return target
    except OSError as err:
        _LOGGER.warning(
            "Could not copy %s into www/community/%s (%s); falling back to /%s/ static path",
            CARD_FILENAME,
            DOMAIN,
            err,
            DOMAIN,
        )
        return None


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    source = Path(__file__).parent / CARD_FILENAME

    target = await hass.async_add_executor_job(
        _sync_card_to_www_community, hass.config.path(), source
    )

    if target is not None:
        card_url_base = HACS_URL_BASE
    else:
        card_url_base = FALLBACK_URL_BASE
        await hass.http.async_register_static_paths([
            StaticPathConfig(
                url_path=f"/{DOMAIN}",
                path=str(Path(__file__).parent),
                cache_headers=False,
            )
        ])

    card_url = f"{card_url_base}?v={_VERSION_NUM}"
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["_card_url"] = card_url

    await _async_register_card(hass, card_url)

    async def _register_on_start(event):
        await _async_register_card(hass, card_url)

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _register_on_start)

    return True


async def _async_register_card(hass: HomeAssistant, card_url: str) -> None:
    """Register the bundled card as a Lovelace resource (idempotent)."""
    try:
        from homeassistant.components.lovelace.const import DOMAIN as LOVELACE_DOMAIN

        lovelace_data = hass.data.get(LOVELACE_DOMAIN)
        if lovelace_data is None:
            _LOGGER.debug("Lovelace not ready yet")
            return

        resources = getattr(lovelace_data, "resources", None)
        if resources is None:
            _LOGGER.debug("Lovelace resources not available")
            return

        if hasattr(resources, "loaded") and not resources.loaded:
            await resources.async_load()
            resources.loaded = True

        def _is_ours(url: str) -> bool:
            return HACS_URL_BASE in url or LEGACY_URL_BASE in url

        existing = [r for r in resources.async_items() if _is_ours(r.get("url", ""))]
        if existing:
            for res in existing:
                if res.get("url") != card_url:
                    _LOGGER.info(
                        "Updating World Cup Scoreboard card resource: %s -> %s",
                        res.get("url"),
                        card_url,
                    )
                    await resources.async_update_item(res["id"], {"url": card_url})
            return

        await resources.async_create_item({"url": card_url, "res_type": "module"})
        _LOGGER.info("Registered World Cup Scoreboard card resource: %s", card_url)
    except ImportError:
        _LOGGER.debug("Lovelace resources module not available")
    except Exception as err:
        _LOGGER.warning("Could not auto-register card resource: %s", err)
        _LOGGER.info("Manually add this resource: %s (type: module)", card_url)


def _coordinator_for_entity(
    hass: HomeAssistant, entity_id: str
) -> WorldCupScoreboardCoordinator | None:
    """Resolve the coordinator backing a scoreboard entity.

    The integration is single-instance, so any configured entry's coordinator
    serves the board. We look the entity up to stay forward-compatible and to
    fail cleanly (``None``) before any entry is set up.
    """
    for value in (hass.data.get(DOMAIN) or {}).values():
        if isinstance(value, WorldCupScoreboardCoordinator):
            return value
    return None


def _register_board_at_date_websocket(hass: HomeAssistant) -> None:
    """Register the ``world_cup_scoreboard/board_at_date`` WebSocket command.

    The card's day-navigation arrows call this with the scoreboard entity id
    and a ``YYYYMMDD`` date to fetch that day's board on demand. The result is
    rendered in place of the live board on that one card without disturbing the
    shared sensor (which always tracks today). Imports are local so the
    pure-helper test harness, which imports this package but stubs Home
    Assistant, doesn't need ``websocket_api``/``voluptuous``.
    """
    import voluptuous as vol
    from homeassistant.components import websocket_api

    @websocket_api.websocket_command(
        {
            vol.Required("type"): f"{DOMAIN}/board_at_date",
            vol.Required("entity_id"): cv.entity_id,
            vol.Required("date"): vol.All(cv.string, vol.Match(r"^\d{8}$")),
        }
    )
    @websocket_api.async_response
    async def _handle_board_at_date(hass, connection, msg) -> None:
        coordinator = _coordinator_for_entity(hass, msg["entity_id"])
        if coordinator is None:
            connection.send_error(
                msg["id"], "not_ready", "No World Cup Scoreboard entry is configured"
            )
            return
        try:
            board = await coordinator.async_get_board_for_date(msg["date"])
        except Exception as err:  # surface any fetch/parse failure to the card
            _LOGGER.debug("board_at_date WS request failed: %s", err)
            connection.send_error(msg["id"], "fetch_failed", str(err))
            return
        connection.send_result(msg["id"], board or {})

    websocket_api.async_register_command(hass, _handle_board_at_date)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator = WorldCupScoreboardCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = coordinator

    # Register day-navigation WebSocket command once (idempotent across entries).
    if not hass.data[DOMAIN].get("_ws_registered"):
        _register_board_at_date_websocket(hass)
        hass.data[DOMAIN]["_ws_registered"] = True

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok
