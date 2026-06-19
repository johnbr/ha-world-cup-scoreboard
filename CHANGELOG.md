# Changelog

## 0.1.0

Initial release.

- `sensor.world_cup_scoreboard` exposing the FIFA World Cup match board (state =
  live match count; attributes carry every match plus the favorite team's
  `featured` match).
- Bundled `custom:world-cup-scoreboard-card` Lovelace card, auto-registered on
  setup. Supports `show_featured`, `featured_only`, `show_completed`, and
  `max_matches` options.
- Config flow with an optional favorite-team (3-letter ESPN abbreviation).
