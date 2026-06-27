/**
 * World Cup Scoreboard Card
 *
 * A lightweight Lovelace card that renders the `sensor.world_cup_scoreboard`
 * board: a pinned/highlighted featured match (the configured favorite team)
 * plus one row per match. Styled to resemble the MLB live game card.
 *
 * Day navigation: ◀ / ▶ arrows beside the date page back through previous
 * match days and forward through upcoming ones. Navigation is card-local —
 * it fetches that day's board over a WebSocket command without disturbing the
 * shared live sensor (which always tracks today) — and snaps back to the live
 * view after a few idle seconds.
 *
 * Config:
 *   type: custom:world-cup-scoreboard-card
 *   entity: sensor.world_cup_scoreboard   # default
 *   title: World Cup                       # optional header text
 *   show_featured: true                    # pin the favorite team at top
 *   featured_only: false                   # show ONLY the favorite team's match
 *   show_completed: true                   # include finished matches
 *   max_matches: 0                         # 0 = no limit
 *   layout: "default"                      # "mlb" = stacked rows styled like the MLB card
 *   show_day_nav: true                     # ◀ ▶ arrows to page between days
 *   nav_snap_back_ms: 8000                 # idle ms before snapping back to today (0 = sticky)
 *
 * The "mlb" layout renders each match as two stacked team rows (away over home),
 * logo + name on the left and score on the right, with an understated status
 * marker (live clock / kickoff time / FT) off to the right — mirroring the
 * MLB Live Game card's scoreboard so the two cards sit together cleanly.
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

// --- Day-navigation date helpers --------------------------------------------
// ESPN's "day" is a label (e.g. "2026-06-19"), not a UTC instant — a day's
// board can include matches that fall on the next UTC date. We treat the day
// as a calendar date and step it by whole days in UTC so the anchor stays put
// regardless of the viewer's timezone.

function parseDay(s) {
  if (!s) return null;
  const p = String(s).slice(0, 10).split("-");
  if (p.length !== 3) return null;
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  return isNaN(d.getTime()) ? null : d;
}

function shiftDay(base, n) {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function isoDay(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabel(offset, target) {
  if (offset === 0) return "Today";
  if (offset === -1) return "Yesterday";
  if (offset === 1) return "Tomorrow";
  if (!target) return offset > 0 ? `+${offset} days` : `${offset} days`;
  return target.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
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
      layout: "default",
      show_day_nav: true,
      nav_snap_back_ms: 8000,
      ...(config || {}),
    };
    this._sig = null;
    // Day-navigation state (card-local; never touches the sensor).
    this._dayOffset = 0;       // 0 = today / live view
    this._navBoard = null;     // fetched board for the current non-zero offset
    this._navCache = new Map(); // YYYYMMDD -> board
    this._navInflight = null;  // date string currently being fetched
    this._snapTimer = null;
    this._liveState = null;    // latest live state object (today's board)
  }

  set hass(hass) {
    this._hass = hass;
    const st = hass.states[this._config.entity];
    this._liveState = st || null;
    // While paged away from today, live updates must not clobber the navigated
    // view; we keep the latest live state for the anchor but don't re-render.
    if (this._dayOffset !== 0) return;
    // Re-render only when the underlying data changes, so we don't thrash the
    // DOM on every unrelated state update HA pushes.
    const sig = st ? `${st.state}|${st.last_updated}` : "missing";
    if (sig === this._sig) return;
    this._sig = sig;
    this._renderLive();
  }

  disconnectedCallback() {
    this._clearSnapBack();
  }

  getCardSize() {
    const st = this._hass && this._hass.states[this._config.entity];
    const n = st ? (st.attributes.match_count || 0) : 3;
    return 2 + Math.min(n, 8);
  }

  // --- Day navigation -------------------------------------------------------

  _anchorDay() {
    return parseDay(this._liveState && this._liveState.attributes
      ? this._liveState.attributes.day : null);
  }

  _clearSnapBack() {
    if (this._snapTimer) {
      clearTimeout(this._snapTimer);
      this._snapTimer = null;
    }
  }

  _armSnapBack() {
    this._clearSnapBack();
    const ms = Number(this._config.nav_snap_back_ms) || 0;
    if (this._dayOffset === 0 || ms <= 0) return;
    this._snapTimer = setTimeout(() => this._snapBack(), ms);
  }

  _snapBack() {
    this._snapTimer = null;
    this._dayOffset = 0;
    this._navBoard = null;
    this._renderLive();
  }

  _navigate(delta) {
    const anchor = this._anchorDay();
    if (!anchor) return; // sensor hasn't reported its day yet
    const target = this._dayOffset + delta;
    this._dayOffset = target;
    if (target === 0) {
      this._navBoard = null;
      this._clearSnapBack();
      this._renderLive();
      return;
    }
    this._armSnapBack();
    const dateStr = ymd(shiftDay(anchor, target));
    const cached = this._navCache.get(dateStr);
    if (cached) {
      this._navBoard = cached;
      this._renderNav();
      return;
    }
    this._fetchDay(dateStr);
  }

  _fetchDay(dateStr) {
    const conn = this._hass && this._hass.connection;
    if (!conn) return;
    if (this._navInflight === dateStr) return; // de-dupe rapid taps
    this._navInflight = dateStr;
    this._renderLoading();
    conn
      .sendMessagePromise({
        type: "world_cup_scoreboard/board_at_date",
        entity_id: this._config.entity,
        date: dateStr,
      })
      .then((board) => {
        this._navInflight = null;
        board = board || {};
        // The navigated board lacks the favorite team (it's a sensor-config
        // value, not part of a day's payload); carry it over for the
        // featured-only empty message.
        const live = this._liveState && this._liveState.attributes;
        board.favorite_team = live ? live.favorite_team : null;
        this._navCache.set(dateStr, board);
        // Apply only if this is still the day the user is looking at.
        const anchor = this._anchorDay();
        if (anchor && ymd(shiftDay(anchor, this._dayOffset)) === dateStr) {
          this._navBoard = board;
          this._renderNav();
        }
      })
      .catch((err) => {
        this._navInflight = null;
        this._renderNavMessage(`Couldn't load that day (${esc(err && err.message ? err.message : err)}).`);
      });
  }

  // --- Rendering ------------------------------------------------------------

  _renderLive() {
    const st = this._liveState ||
      (this._hass && this._hass.states[this._config.entity]) || null;
    this._renderBoard(st ? (st.attributes || {}) : null, {});
  }

  _renderNav() {
    if (!this._navBoard) return;
    this._renderBoard(this._navBoard, { nav: true });
  }

  _renderLoading() {
    const live = (this._liveState && this._liveState.attributes) || {};
    const anchor = this._anchorDay();
    const board = {
      league: live.league,
      season: live.season,
      matches: [],
      featured: {},
      live_count: 0,
      day: anchor ? isoDay(shiftDay(anchor, this._dayOffset)) : null,
      calendar_start: live.calendar_start,
      calendar_end: live.calendar_end,
      favorite_team: live.favorite_team,
    };
    this._renderBoard(board, { loading: true });
  }

  _renderNavMessage(html) {
    const board = this._navBoard ||
      ((this._liveState && this._liveState.attributes) || {});
    this._renderBoard(board, { message: html });
  }

  _navBounds(board) {
    // Prefer the coordinator's explicit flags (sent for navigated days); fall
    // back to comparing the day against the tournament calendar window.
    if (board && (board.has_prev !== undefined || board.has_next !== undefined)) {
      return { hasPrev: board.has_prev !== false, hasNext: board.has_next !== false };
    }
    const day = String(board && board.day || "").slice(0, 10);
    const start = String(board && board.calendar_start || "").slice(0, 10);
    const end = String(board && board.calendar_end || "").slice(0, 10);
    return {
      hasPrev: !(start && day && day <= start),
      hasNext: !(end && day && day >= end),
    };
  }

  _navRow(board) {
    if (!this._config.show_day_nav) return "";
    const { hasPrev, hasNext } = this._navBounds(board);
    const anchor = this._anchorDay();
    const target = anchor ? shiftDay(anchor, this._dayOffset) : null;
    const label = dayLabel(this._dayOffset, target);
    const back = this._dayOffset !== 0
      ? `<button class="navbtn today" title="Back to today" aria-label="Back to today">⟳</button>`
      : "";
    return `
      <div class="daynav">
        <button class="navbtn prev" ${hasPrev ? "" : "disabled"} title="Previous day" aria-label="Previous day">◀</button>
        <span class="navlabel">${esc(label)}</span>
        <button class="navbtn next" ${hasNext ? "" : "disabled"} title="Next day" aria-label="Next day">▶</button>
        ${back}
      </div>`;
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

  // --- MLB-style layout (mirrors the MLB Live Game card's scoreboard) --------
  // Two stacked team rows (away over home), each `[crest] name … score`, with a
  // single understated status marker to the right. Intentionally drops the
  // filled/blinking live pill — just the clock/time text, MLB-style.

  _mlbMarker(match) {
    const status = match.status || {};
    const state = status.state || "";
    if (state === STATE_IN) {
      return { cls: "live", text: status.clock ? esc(status.clock) : "LIVE" };
    }
    if (state === STATE_POST) {
      return { cls: "final", text: esc(status.detail || "FT") };
    }
    return { cls: "pre", text: esc(kickoffLocal(match.date) || status.detail || "Scheduled") };
  }

  _mlbTeamRow(team) {
    const logo = team.logo
      ? `<img class="mlogo" src="${esc(team.logo)}" alt="" loading="lazy" />`
      : `<span class="mlogo ph">${esc(team.abbr || "?")}</span>`;
    const name = esc(team.name || team.short_name || team.abbr || "—");
    const score = team.score == null ? "—" : esc(team.score);
    return `
      <div class="mrow${team.winner ? " win" : ""}">
        <div class="mleft">${logo}<span class="mname">${name}</span></div>
        <div class="mright"><span class="mscoreval">${score}</span></div>
      </div>`;
  }

  _mlbRow(match) {
    const marker = this._mlbMarker(match);
    const note = match.note ? `<div class="mnote">${esc(match.note)}</div>` : "";
    return `
      <div class="mlbmatch">
        ${note}
        <div class="mscore">
          <div class="mteams">
            ${this._mlbTeamRow(match.away)}
            ${this._mlbTeamRow(match.home)}
          </div>
          <div class="mmarker ${marker.cls}">${marker.text}</div>
        </div>
      </div>`;
  }

  _wireEvents() {
    if (this._navWired) return;
    this._navWired = true;
    this.shadowRoot.addEventListener("click", (ev) => {
      const btn = ev.target.closest && ev.target.closest(".navbtn");
      if (!btn || btn.disabled) return;
      if (btn.classList.contains("today")) {
        this._dayOffset = 0;
        this._navBoard = null;
        this._clearSnapBack();
        this._renderLive();
        return;
      }
      this._navigate(btn.classList.contains("next") ? 1 : -1);
    });
  }

  _renderBoard(attrs, meta) {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._wireEvents();

    if (!attrs) {
      this.shadowRoot.innerHTML = this._styles() +
        `<ha-card><div class="empty">Entity ${esc(this._config.entity)} not found.</div></ha-card>`;
      return;
    }

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

    const mlb = cfg.layout === "mlb";
    // The MLB-style layout mirrors the MLB card, which carries no big title /
    // sub line — so show a header only when a title is explicitly configured.
    const header = mlb
      ? (cfg.title ? `<div class="header mlbhdr"><div class="title">${esc(cfg.title)}</div></div>` : "")
      : `
      <div class="header">
        <div class="title">${esc(cfg.title || attrs.league || "World Cup")}</div>
        <div class="sub">${esc(attrs.league || "")}${attrs.season ? " · " + esc(attrs.season) : ""}${attrs.live_count ? ` · ${attrs.live_count} live` : ""}</div>
      </div>`;

    const navRow = this._navRow(attrs);
    const rowFn = mlb
      ? (m) => this._mlbRow(m)
      : (m, feat) => this._row(m, feat);

    let body;
    if (meta && meta.loading) {
      body = `<div class="empty loading">Loading…</div>`;
    } else if (meta && meta.message) {
      body = `<div class="empty">${meta.message}</div>`;
    } else {
      const emptyMsg = cfg.featured_only
        ? (attrs.favorite_team
            ? `${esc(attrs.favorite_team)} has no match on this day.`
            : "No favorite team set — re-add the integration to choose one.")
        : "No matches scheduled.";
      body = matches.length || featured
        ? `${featured ? rowFn(featured, true) : ""}${matches.map((m) => rowFn(m, false)).join("")}`
        : `<div class="empty">${esc(emptyMsg)}</div>`;
    }

    this.shadowRoot.innerHTML = this._styles() +
      `<ha-card class="${mlb ? "mlbskin" : ""}">${header}${navRow}<div class="list${mlb ? " mlblist" : ""}">${body}</div></ha-card>`;
  }

  _styles() {
    return `<style>
      ha-card { padding: 12px 14px 14px; }
      .header { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:8px; }
      .title { font-size:1.15rem; font-weight:700; }
      .sub { font-size:0.78rem; color: var(--secondary-text-color); }
      .daynav { display:flex; align-items:center; justify-content:center; gap:10px; margin:0 0 10px; }
      .navbtn { -webkit-appearance:none; appearance:none; border:1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color); border-radius:8px; min-width:32px; height:28px; padding:0 8px; font-size:0.85rem; line-height:1; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
      .navbtn:hover:not([disabled]) { border-color: var(--primary-color); color: var(--primary-color); }
      .navbtn[disabled] { opacity:0.35; cursor:default; }
      .navbtn.today { font-size:1rem; }
      .navlabel { min-width:96px; text-align:center; font-size:0.85rem; font-weight:700; }
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
      .empty.loading { font-style:italic; }

      /* ── MLB-style layout (layout: "mlb") — mirrors the MLB Live Game card ── */
      ha-card.mlbskin { padding:10px 14px; }
      .mlbhdr { margin-bottom:6px; }
      .mlblist { gap:0; }
      .mlbmatch { padding:2px 0; }
      .mlbmatch + .mlbmatch { border-top:1px solid var(--divider-color); margin-top:8px; padding-top:8px; }
      .mscore { display:grid; grid-template-columns:minmax(0,1fr) auto; column-gap:10px; align-items:center; }
      .mteams { display:flex; flex-direction:column; }
      .mrow { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:1px 0; opacity:0.9; }
      .mrow.win { opacity:1; }
      .mleft { display:flex; align-items:center; gap:10px; min-width:0; }
      .mlogo { width:28px; height:28px; object-fit:contain; flex:0 0 28px; }
      .mlogo.ph { display:inline-flex; align-items:center; justify-content:center; border-radius:50%; background: var(--secondary-background-color); font-size:0.7rem; font-weight:700; }
      .mname { line-height:1.15; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:16px; font-weight:500; }
      .mright { display:flex; align-items:center; }
      .mscoreval { min-width:20px; text-align:right; font-variant-numeric:tabular-nums; font-size:1.05em; font-weight:500; }
      .mmarker { min-width:28px; text-align:center; line-height:1.15; font-size:0.95rem; color: var(--secondary-text-color); }
      .mmarker.live { color: var(--success-color, #43a047); }
      .mmarker.final { color: var(--primary-text-color); }
      .mnote { font-size:0.72rem; text-transform:uppercase; letter-spacing:.04em; color: var(--secondary-text-color); margin-bottom:4px; }
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
