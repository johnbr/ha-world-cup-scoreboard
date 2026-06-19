/**
 * World Cup Scoreboard Card
 *
 * A lightweight Lovelace card that renders the `sensor.world_cup_scoreboard`
 * board: a pinned/highlighted featured match (the configured favorite team)
 * plus one row per match. Styled to resemble the MLB live game card.
 *
 * Config:
 *   type: custom:world-cup-scoreboard-card
 *   entity: sensor.world_cup_scoreboard   # default
 *   title: World Cup                       # optional header text
 *   show_featured: true                    # pin the favorite team at top
 *   featured_only: false                   # show ONLY the favorite team's match
 *   show_completed: true                   # include finished matches
 *   max_matches: 0                         # 0 = no limit
 */

const STATE_PRE = "pre";
const STATE_IN = "in";
const STATE_POST = "post";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function kickoffLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    weekday: "short", hour: "numeric", minute: "2-digit",
  });
}

class WorldCupScoreboardCard extends HTMLElement {
  setConfig(config) {
    this._config = {
      entity: "sensor.world_cup_scoreboard",
      title: "World Cup",
      show_featured: true,
      featured_only: false,
      show_completed: true,
      max_matches: 0,
      ...(config || {}),
    };
    this._sig = null;
  }

  set hass(hass) {
    this._hass = hass;
    const st = hass.states[this._config.entity];
    // Re-render only when the underlying data changes, so we don't thrash the
    // DOM on every unrelated state update HA pushes.
    const sig = st ? `${st.state}|${st.last_updated}` : "missing";
    if (sig === this._sig) return;
    this._sig = sig;
    this._render(st);
  }

  getCardSize() {
    const st = this._hass && this._hass.states[this._config.entity];
    const n = st ? (st.attributes.match_count || 0) : 3;
    return 2 + Math.min(n, 8);
  }

  _statusPill(match) {
    const status = match.status || {};
    const state = status.state || "";
    if (state === STATE_IN) {
      const clk = status.clock ? esc(status.clock) : "LIVE";
      return `<span class="pill live"><span class="dot"></span>${clk}</span>`;
    }
    if (state === STATE_POST) {
      return `<span class="pill final">${esc(status.detail || "FT")}</span>`;
    }
    // pre / unknown -> kickoff time (local), falling back to ESPN's detail text
    const kick = kickoffLocal(match.date) || status.detail || "Scheduled";
    return `<span class="pill pre">${esc(kick)}</span>`;
  }

  _side(team, align) {
    const crest = team.logo
      ? `<img class="crest" src="${esc(team.logo)}" alt="${esc(team.abbr)}" loading="lazy" />`
      : `<span class="crest placeholder">${esc(team.abbr || "?")}</span>`;
    const name = `<span class="abbr${team.winner ? " win" : ""}">${esc(team.abbr || team.short_name || "")}</span>`;
    return align === "home"
      ? `${crest}${name}`
      : `${name}${crest}`;
  }

  _score(match) {
    const state = match.status.state;
    if (state === STATE_PRE) return `<span class="score muted">vs</span>`;
    const h = match.home.score == null ? "" : esc(match.home.score);
    const a = match.away.score == null ? "" : esc(match.away.score);
    return `<span class="score">${h}<span class="dash">–</span>${a}</span>`;
  }

  _row(match, featured) {
    const note = match.note ? `<div class="note">${esc(match.note)}</div>` : `<div class="note"></div>`;
    return `
      <div class="match${featured ? " featured" : ""}">
        <div class="toprow">
          ${note}
          ${this._statusPill(match)}
        </div>
        <div class="teams">
          <div class="side home">${this._side(match.home, "home")}</div>
          ${this._score(match)}
          <div class="side away">${this._side(match.away, "away")}</div>
        </div>
        ${featured ? `<div class="fav-tag">★ Featured</div>` : ""}
      </div>`;
  }

  _render(st) {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });

    if (!st) {
      this.shadowRoot.innerHTML = this._styles() +
        `<ha-card><div class="empty">Entity ${esc(this._config.entity)} not found.</div></ha-card>`;
      return;
    }

    const attrs = st.attributes || {};
    const cfg = this._config;
    let matches = Array.isArray(attrs.matches) ? attrs.matches.slice() : [];
    // featured_only implies the featured match is shown (it's all there is).
    const showFeatured = cfg.show_featured || cfg.featured_only;
    const featured = showFeatured && attrs.featured && attrs.featured.id
      ? attrs.featured : null;

    if (cfg.featured_only) {
      // Only the favorite team's match; suppress the rest of the board.
      matches = [];
    } else {
      if (!cfg.show_completed) {
        matches = matches.filter((m) => m.status.state !== STATE_POST);
      }
      // Avoid showing the featured match twice.
      if (featured) matches = matches.filter((m) => m.id !== featured.id);
      if (cfg.max_matches > 0) matches = matches.slice(0, cfg.max_matches);
    }

    const header = `
      <div class="header">
        <div class="title">${esc(cfg.title || attrs.league || "World Cup")}</div>
        <div class="sub">${esc(attrs.league || "")}${attrs.season ? " · " + esc(attrs.season) : ""}${attrs.live_count ? ` · ${attrs.live_count} live` : ""}</div>
      </div>`;

    const emptyMsg = cfg.featured_only
      ? (attrs.favorite_team
          ? `${esc(attrs.favorite_team)} has no match on the current board.`
          : "No favorite team set — re-add the integration to choose one.")
      : "No matches scheduled.";
    const body = matches.length || featured
      ? `${featured ? this._row(featured, true) : ""}${matches.map((m) => this._row(m, false)).join("")}`
      : `<div class="empty">${esc(emptyMsg)}</div>`;

    this.shadowRoot.innerHTML = this._styles() +
      `<ha-card>${header}<div class="list">${body}</div></ha-card>`;
  }

  _styles() {
    return `<style>
      ha-card { padding: 12px 14px 14px; }
      .header { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:8px; }
      .title { font-size:1.15rem; font-weight:700; }
      .sub { font-size:0.78rem; color: var(--secondary-text-color); }
      .list { display:flex; flex-direction:column; gap:8px; }
      .match { border:1px solid var(--divider-color); border-radius:12px; padding:8px 10px; background: var(--card-background-color); }
      .match.featured { border-color: var(--primary-color); box-shadow: 0 0 0 1px var(--primary-color) inset; }
      .toprow { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; min-height:18px; }
      .note { font-size:0.72rem; text-transform:uppercase; letter-spacing:.04em; color: var(--secondary-text-color); }
      .teams { display:grid; grid-template-columns: 1fr auto 1fr; align-items:center; gap:8px; }
      .side { display:flex; align-items:center; gap:8px; min-width:0; }
      .side.home { justify-content:flex-start; }
      .side.away { justify-content:flex-end; }
      .crest { width:30px; height:30px; object-fit:contain; }
      .crest.placeholder { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:50%; background: var(--secondary-background-color); font-size:0.7rem; font-weight:700; }
      .abbr { font-weight:700; font-size:1rem; }
      .abbr.win { color: var(--primary-color); }
      .score { font-size:1.3rem; font-weight:800; font-variant-numeric: tabular-nums; white-space:nowrap; }
      .score.muted { font-size:0.9rem; font-weight:600; color: var(--secondary-text-color); }
      .dash { margin:0 6px; color: var(--secondary-text-color); }
      .pill { font-size:0.72rem; font-weight:700; padding:2px 8px; border-radius:999px; display:inline-flex; align-items:center; gap:5px; }
      .pill.live { color:#fff; background: var(--success-color, #43a047); }
      .pill.final { color: var(--secondary-text-color); background: var(--secondary-background-color); }
      .pill.pre { color: var(--primary-text-color); background: var(--secondary-background-color); }
      .pill .dot { width:7px; height:7px; border-radius:50%; background:#fff; animation: wcblink 1.1s infinite; }
      @keyframes wcblink { 0%,100%{opacity:1;} 50%{opacity:.25;} }
      .fav-tag { margin-top:4px; font-size:0.68rem; font-weight:700; color: var(--primary-color); }
      .empty { padding:18px 4px; text-align:center; color: var(--secondary-text-color); }
    </style>`;
  }

  static getStubConfig() {
    return { entity: "sensor.world_cup_scoreboard", title: "World Cup" };
  }
}

customElements.define("world-cup-scoreboard-card", WorldCupScoreboardCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "world-cup-scoreboard-card",
  name: "World Cup Scoreboard Card",
  description: "FIFA World Cup match board with an optional pinned favorite team.",
});

// eslint-disable-next-line no-console
console.info("%c WORLD-CUP-SCOREBOARD-CARD ", "color:#fff;background:#43a047;font-weight:700;");
