DOMAIN = "world_cup_scoreboard"
PLATFORMS = ["sensor"]

# Config-entry keys.
CONF_FAVORITE_TEAM = "favorite_team"
CONF_NAME = "name"

DEFAULT_NAME = "World Cup Scoreboard"

# ESPN soccer league slug for the (men's) FIFA World Cup. The scoreboard
# endpoint returns every event for the current matchday / tournament window.
LEAGUE_SLUG = "fifa.world"
SCOREBOARD_URL = (
    f"https://site.api.espn.com/apis/site/v2/sports/soccer/{LEAGUE_SLUG}/scoreboard"
)

# Soccer moves slowly compared with baseball, so we poll less aggressively than
# the MLB integration (which uses 5 s). We tighten the interval when any match
# is live so scores/clock stay fresh during a game.
DEFAULT_SCAN_INTERVAL_SECONDS = 30
LIVE_SCAN_INTERVAL_SECONDS = 15

# ESPN status `type.state` values.
STATE_PRE = "pre"
STATE_IN = "in"
STATE_POST = "post"
LIVE_STATES = frozenset({STATE_IN})
