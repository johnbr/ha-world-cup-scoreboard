# World Cup Scoreboard (Home Assistant)

A deliberately small custom integration that tracks **FIFA World Cup** scores
from ESPN's public scoreboard feed and ships a matching Lovelace card.

It is the lightweight cousin of the MLB Live Scoreboard integration: one
config entry → one `DataUpdateCoordinator` → one sensor that carries the whole
match board as attributes, plus an auto-registered custom card.

## What you get

- **`sensor.world_cup_scoreboard`**
  - `state`: number of matches currently in progress (`live_count`)
  - attributes:
    - `matches[]` — every match: `home`/`away` (`name`, `abbr`, `logo`, `score`,
      `winner`), `status` (`state` `pre`/`in`/`post`, `detail`, `clock`,
      `completed`), `note` (round/stage), `date`, `id`
    - `featured` — the favorite team's most relevant match (live > next > last),
      or `{}` if no favorite is set
    - `league`, `season`, `favorite_team`, `match_count`, `live_count`
- **`custom:world-cup-scoreboard-card`** — pinned featured match + a row per
  match (crest, abbreviation, score, status pill). Auto-registered as a
  Lovelace resource on setup.

## Install

1. Copy `custom_components/world_cup_scoreboard/` into your HA `config/custom_components/`
   (or add this repo to HACS as a custom repository).
2. Restart Home Assistant.
3. **Settings → Devices & Services → Add Integration → "World Cup Scoreboard"**.
   Optionally enter a favorite team as a 3-letter ESPN abbreviation (`USA`, `BRA`,
   `ARG`, …); leave blank for no pinned team.

The card JS is copied into `www/community/world_cup_scoreboard/` and registered
automatically — no manual resource entry needed.

## Card config

```yaml
type: custom:world-cup-scoreboard-card
entity: sensor.world_cup_scoreboard   # default
title: World Cup                      # optional
show_featured: true                   # pin the favorite team at top
show_completed: true                  # include finished matches
max_matches: 0                        # 0 = no limit
```

## Data source

ESPN site API, men's World Cup slug `fifa.world`:
`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard`
(unofficial, no key required). Polled every 30 s, tightening to 15 s while a
match is live.
