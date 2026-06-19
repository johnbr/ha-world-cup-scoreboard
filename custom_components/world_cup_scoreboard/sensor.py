from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceEntryType
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import WorldCupScoreboardCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: WorldCupScoreboardCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([WorldCupScoreboardSensor(coordinator, entry)])


class WorldCupScoreboardSensor(
    CoordinatorEntity[WorldCupScoreboardCoordinator], SensorEntity
):
    _attr_icon = "mdi:soccer"
    _attr_has_entity_name = False
    # The board payload (every match + the featured match) is large and
    # high-churn — meaningless as recorder history and over the 16 KB attribute
    # cap. The card reads the live state object, so keep it out of the recorder
    # entirely (same approach as the MLB scoreboard sensor).
    _unrecorded_attributes = frozenset({MATCH_ALL})

    def __init__(
        self, coordinator: WorldCupScoreboardCoordinator, entry: ConfigEntry
    ) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_scoreboard"
        self._attr_name = "World Cup Scoreboard"
        self._attr_suggested_object_id = "world_cup_scoreboard"

    @property
    def native_value(self) -> int:
        """Number of matches currently in progress."""
        return int((self.coordinator.data or {}).get("live_count", 0))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        data = self.coordinator.data or {}
        return {
            "league": data.get("league"),
            "season": data.get("season"),
            "favorite_team": self.coordinator.favorite or None,
            "match_count": data.get("match_count", 0),
            "live_count": data.get("live_count", 0),
            "matches": data.get("matches", []),
            "featured": data.get("featured", {}),
        }

    @property
    def device_info(self) -> dict[str, Any]:
        return {
            "identifiers": {(DOMAIN, self.coordinator.entry.entry_id)},
            "name": "World Cup Scoreboard",
            "manufacturer": "ESPN / Custom",
            "model": "World Cup Scoreboard",
            "entry_type": DeviceEntryType.SERVICE,
        }
