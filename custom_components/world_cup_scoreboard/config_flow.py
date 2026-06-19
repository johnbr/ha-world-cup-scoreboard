from __future__ import annotations

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

from .const import CONF_FAVORITE_TEAM, CONF_NAME, DEFAULT_NAME, DOMAIN


class WorldCupScoreboardConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict | None = None) -> FlowResult:
        # Single instance: one tournament-wide board per HA install.
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            favorite = str(user_input.get(CONF_FAVORITE_TEAM) or "").upper().strip()
            name = str(user_input.get(CONF_NAME) or DEFAULT_NAME).strip()
            return self.async_create_entry(
                title=name,
                data={CONF_FAVORITE_TEAM: favorite, CONF_NAME: name},
            )

        # Favorite team is a free-text 3-letter ESPN abbreviation (USA, BRA,
        # ARG, ...) so the 2026 field doesn't need a hardcoded roster. Leave it
        # blank for no pinned/highlighted team.
        schema = vol.Schema(
            {
                vol.Optional(CONF_FAVORITE_TEAM, default=""): str,
                vol.Optional(CONF_NAME, default=DEFAULT_NAME): str,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema)
