// NAME: Playlist Plus
// AUTHOR: dimssen
// DESCRIPTION: Trim songs (custom start/end points) and run timed sessions built from several sub-playlists (e.g. warm-up / normal / cool-down).

// ---------------------------------------------------------------------------
// Core logic. Pure, no Spicetify access, so it can be unit tested in Node.
// ---------------------------------------------------------------------------
const PlaylistPlusCore = (() => {
  /** "1:30" -> 90000, "90" -> 90000, "1:02:03" -> 3723000. Empty -> null, invalid -> NaN. */
  function parseTime(input) {
    if (input == null) return null;
    const s = String(input).trim();
    if (!s) return null;
    if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return NaN;
    let secs = 0;
    for (const part of s.split(":")) secs = secs * 60 + parseFloat(part);
    return Math.round(secs * 1000);
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.round((ms || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  /** Accepts spotify:playlist:ID, spotify:user:x:playlist:ID or an open.spotify.com link. */
  function normalizePlaylistUri(input) {
    if (!input) return null;
    const s = String(input).trim();
    let m = s.match(/^spotify:(?:user:[^:]+:)?playlist:([A-Za-z0-9]+)$/);
    if (m) return `spotify:playlist:${m[1]}`;
    m = s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:user\/[^/]+\/)?playlist\/([A-Za-z0-9]+)/);
    if (m) return `spotify:playlist:${m[1]}`;
    return null;
  }

  /**
   * Split a session length between phases.
   * phase.mode: "minutes" (fixed), "percent" (of the total) or "rest" (share of what is left).
   * With no "rest" phase, any leftover time is added to the last phase.
   */
  function computeBudgets(totalMs, phases) {
    if (!(totalMs > 0)) throw new Error("Session length must be greater than 0.");
    if (!phases.length) throw new Error("Add at least one phase.");
    let fixedSum = 0;
    let restCount = 0;
    const budgets = phases.map((p) => {
      if (p.mode === "rest") {
        restCount++;
        return null;
      }
      const v = Number(p.value);
      if (!(v >= 0)) throw new Error(`"${p.name || "Phase"}" needs a non-negative amount.`);
      const ms = p.mode === "percent" ? (totalMs * v) / 100 : v * 60000;
      fixedSum += ms;
      return ms;
    });
    if (fixedSum > totalMs + 1000) {
      throw new Error(`Phases add up to ${formatTime(fixedSum)}, which is longer than the session (${formatTime(totalMs)}).`);
    }
    const leftover = Math.max(0, totalMs - fixedSum);
    if (restCount) {
      for (let i = 0; i < budgets.length; i++) if (budgets[i] === null) budgets[i] = leftover / restCount;
    } else {
      budgets[budgets.length - 1] += leftover;
    }
    return budgets.map((b) => Math.round(b));
  }

  /** Start/end of a track after applying its trim (if any). */
  function trackBounds(track, trims) {
    const trim = trims && trims[track.uri];
    const duration = track.duration;
    let start = (trim && trim.start) || 0;
    let end = trim && trim.end && trim.end <= duration ? trim.end : duration;
    if (end <= start) {
      start = 0;
      end = duration;
    }
    return { start, end, length: end - start };
  }

  function shuffled(arr, rng = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * Pick tracks from `tracks` until their (trimmed) length covers `budgetMs`.
   * The last track usually runs past the budget; the runner cuts it at the boundary.
   * smartFit: prefer tracks that still fit entirely in the remaining time.
   * Tracks repeat (re-shuffled) only if the playlist is shorter than the budget.
   */
  function planPhase(tracks, budgetMs, opts = {}) {
    const { shuffle = true, smartFit = true, rng = Math.random, trims = {}, prevUri = null } = opts;
    const usable = tracks.filter((t) => t && t.uri && t.duration > 0);
    if (!usable.length || !(budgetMs > 0)) return [];
    const items = [];
    let acc = 0;
    let pool = [];
    let last = prevUri;
    for (let guard = 0; acc < budgetMs && guard < 10000; guard++) {
      if (!pool.length) pool = shuffle ? shuffled(usable, rng) : usable.slice();
      const remaining = budgetMs - acc;
      const len = (t) => trackBounds(t, trims).length;
      let idx = -1;
      if (smartFit) idx = pool.findIndex((t) => t.uri !== last && len(t) <= remaining);
      if (idx < 0) idx = pool.findIndex((t) => t.uri !== last);
      if (idx < 0) idx = 0;
      const t = pool.splice(idx, 1)[0];
      const b = trackBounds(t, trims);
      items.push({ uri: t.uri, name: t.name || t.uri, artist: t.artist || "", duration: t.duration, start: b.start, end: b.end, length: b.length });
      acc += b.length;
      last = t.uri;
    }
    return items;
  }

  /**
   * Drives playback through the phases of a timed session.
   * `player` is a small adapter (Spicetify in the desktop extension, the Web API in the phone app,
   * a fake in tests). Time only counts while music is playing, so pausing pauses the session.
   *
   * Adapters with `playsUpcoming` hand Spotify the rest of the plan with each play() call, so
   * Spotify keeps following the plan by itself while the controller can't run (phone locked);
   * the runner then re-syncs to wherever Spotify got to.
   */
  class SessionRunner {
    constructor(player, phases, opts = {}) {
      this.player = player;
      // phases: [{ name, budget, pool: tracks[], items: planned items[] }]
      this.phases = phases;
      this.opts = { fadeMs: 3000, shuffle: true, smartFit: true, trims: {}, ...opts };
      this.active = false;
      this.phaseIdx = 0;
      this.itemIdx = 0;
      this.phaseElapsed = 0;
      this.expected = null;
      this.switching = false;
      this.switchWait = 0;
      this.baseVolume = null;
    }

    get phase() {
      return this.phases[this.phaseIdx];
    }

    get item() {
      return this.phase && this.phase.items[this.itemIdx];
    }

    start() {
      this.active = true;
      this.phaseIdx = 0;
      this.itemIdx = 0;
      this.phaseElapsed = 0;
      this._playItem();
    }

    stop() {
      if (!this.active) return;
      this.active = false;
      this._restoreVolume();
      this._emit("stop");
    }

    skipPhase() {
      if (this.active) this._nextPhase();
    }

    skipTrack() {
      if (this.active) this._advanceTrack();
    }

    status() {
      if (!this.active) return null;
      const phaseLeft = Math.max(0, this.phase.budget - this.phaseElapsed);
      let totalLeft = phaseLeft;
      for (let i = this.phaseIdx + 1; i < this.phases.length; i++) totalLeft += this.phases[i].budget;
      return {
        phaseName: this.phase.name,
        phaseIdx: this.phaseIdx,
        phaseCount: this.phases.length,
        phaseLeft,
        totalLeft,
        item: this.item,
      };
    }

    tick(dt) {
      if (!this.active) return;
      const p = this.player;
      const cur = p.currentUri();

      if (this.switching) {
        if (cur === this.expected) {
          this.switching = false;
          // Adapters that can start mid-song already did; otherwise jump to the trimmed start.
          if (this.item.start > 0 && p.progress() < this.item.start - 1500) p.seek(this.item.start);
        } else {
          this.switchWait += dt;
          // Spotify never switched (unplayable track?) - move on.
          if (this.switchWait > 8000) this._advanceTrack();
        }
        return;
      }

      if (cur !== this.expected) {
        // Spotify moved on to a later song of the plan by itself (natural end, or the user hit next).
        const ahead = this._findAhead(cur);
        if (ahead) this._syncTo(ahead, dt);
        // Something unplanned is playing: the user hit next, or Spotify autoplay took over.
        else this._advanceTrack();
        return;
      }

      if (!p.isPlaying()) return;

      this.phaseElapsed += dt;
      const phaseLeft = this.phase.budget - this.phaseElapsed;
      if (phaseLeft <= 0) {
        this._nextPhase();
        return;
      }

      const trackLeft = this.item.end - p.progress();
      const fadeMs = this.opts.fadeMs;
      if (fadeMs > 0 && phaseLeft < fadeMs && trackLeft > phaseLeft + 250) {
        // The phase boundary will cut this track: fade it out (if the device allows volume control).
        if (this.baseVolume == null) this.baseVolume = p.getVolume();
        if (this.baseVolume != null) p.setVolume(this.baseVolume * Math.max(0, phaseLeft / fadeMs));
      }

      // At a trimmed end we must cut; at a natural end Spotify moves on itself if it has the plan.
      const trimmedEnd = this.item.duration && this.item.end < this.item.duration;
      if (trackLeft <= 250 && (trimmedEnd || !p.playsUpcoming)) this._advanceTrack();
    }

    _findAhead(uri) {
      if (!uri) return null;
      for (let pi = this.phaseIdx; pi < this.phases.length; pi++) {
        const items = this.phases[pi].items;
        for (let i = pi === this.phaseIdx ? this.itemIdx + 1 : 0; i < items.length; i++) {
          if (items[i].uri === uri) return { pi, i };
        }
      }
      return null;
    }

    _syncTo({ pi, i }, dt) {
      this._restoreVolume();
      const phaseChanged = pi !== this.phaseIdx;
      this.phaseIdx = pi;
      this.itemIdx = i;
      if (phaseChanged) {
        // Estimate how far into this phase Spotify got from the planned songs before this one.
        let est = 0;
        for (let k = 0; k < i; k++) est += this.phase.items[k].length;
        this.phaseElapsed = est + Math.max(0, this.player.progress() - this.item.start);
        this._emit("phase");
      } else if (this.player.isPlaying()) {
        this.phaseElapsed += dt;
      }
      // Let the switching step apply this song's trimmed start.
      this.expected = this.item.uri;
      this.switching = true;
      this.switchWait = 0;
      this._emit("track");
    }

    /** URIs of the planned songs after the current one, for adapters that queue them. */
    _upcoming() {
      const out = [];
      for (let pi = this.phaseIdx; pi < this.phases.length; pi++) {
        const items = this.phases[pi].items;
        for (let i = pi === this.phaseIdx ? this.itemIdx + 1 : 0; i < items.length && out.length < 99; i++) out.push(items[i].uri);
      }
      return out;
    }

    _advanceTrack() {
      this.itemIdx++;
      if (this.itemIdx >= this.phase.items.length) {
        // Ran out of planned tracks (the user skipped some): plan more for the time left.
        const left = this.phase.budget - this.phaseElapsed;
        const prev = this.phase.items[this.phase.items.length - 1];
        const more = left > 1000 ? planPhase(this.phase.pool, left, { ...this.opts, prevUri: prev && prev.uri }) : [];
        if (!more.length) {
          this._nextPhase();
          return;
        }
        this.phase.items.push(...more);
      }
      this._playItem();
    }

    _nextPhase() {
      this.phaseIdx++;
      this.itemIdx = 0;
      this.phaseElapsed = 0;
      if (this.phaseIdx >= this.phases.length) {
        this._finish();
        return;
      }
      if (!this.phase.items.length) {
        this._nextPhase();
        return;
      }
      this._emit("phase");
      this._playItem();
    }

    _playItem() {
      this._restoreVolume();
      const item = this.item;
      this.expected = item.uri;
      this.switching = true;
      this.switchWait = 0;
      this.player.play(item.uri, item.start, this._upcoming());
      this._emit("track");
    }

    _finish() {
      this.active = false;
      this.player.pause();
      this._restoreVolume();
      this._emit("finish");
    }

    _restoreVolume() {
      if (this.baseVolume != null) {
        this.player.setVolume(this.baseVolume);
        this.baseVolume = null;
      }
    }

    _emit(type) {
      if (this.opts.onEvent) this.opts.onEvent(type, this);
    }
  }

  /** Applies trims during normal (non-session) listening. */
  class TrimWatcher {
    constructor(player, getTrims) {
      this.player = player;
      this.getTrims = getTrims;
      this.lastUri = null;
      this.lastProgress = 0;
      this.startHandled = false;
      this.endHandled = false;
    }

    tick() {
      const p = this.player;
      const uri = p.currentUri();
      if (!uri) return;
      const progress = p.progress();
      // New track, or the same track restarted (previous button / repeat-one).
      if (uri !== this.lastUri || (this.lastProgress > 3000 && progress < 1500)) {
        this.lastUri = uri;
        this.startHandled = false;
        this.endHandled = false;
      }
      this.lastProgress = progress;
      const trim = this.getTrims()[uri];
      if (!trim) return;
      if (!this.startHandled) {
        this.startHandled = true;
        if (trim.start > 0 && progress < trim.start - 1500) {
          p.seek(trim.start);
          this.lastProgress = trim.start;
        }
        return;
      }
      if (trim.end && progress >= trim.end && !this.endHandled) {
        this.endHandled = true;
        p.next();
      }
    }
  }

  return { parseTime, formatTime, normalizePlaylistUri, computeBudgets, trackBounds, shuffled, planPhase, SessionRunner, TrimWatcher };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PlaylistPlusCore;
if (typeof window !== "undefined") window.PlaylistPlusCore = PlaylistPlusCore;

// ---------------------------------------------------------------------------
// Spicetify integration + UI
// ---------------------------------------------------------------------------
(async function PlaylistPlus() {
  // The phone web app loads this file only for the core logic above.
  if (typeof window === "undefined" || window.PLAYLIST_PLUS_CORE_ONLY) return;
  const ready = () =>
    window.Spicetify &&
    Spicetify.Player &&
    Spicetify.Player.data !== undefined &&
    Spicetify.Platform &&
    Spicetify.ContextMenu &&
    Spicetify.PopupModal &&
    Spicetify.LocalStorage &&
    Spicetify.Topbar;
  while (!ready()) await new Promise((r) => setTimeout(r, 300));

  const { parseTime, formatTime, normalizePlaylistUri, computeBudgets, planPhase, SessionRunner, TrimWatcher } = PlaylistPlusCore;

  // ----- storage -----------------------------------------------------------
  const KEY = {
    trims: "playlist-plus:trims",
    templates: "playlist-plus:templates",
    settings: "playlist-plus:settings",
    activeTemplate: "playlist-plus:active-template",
  };
  const load = (k, fallback) => {
    try {
      const v = Spicetify.LocalStorage.get(k);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  };
  const save = (k, v) => Spicetify.LocalStorage.set(k, JSON.stringify(v));

  let trims = load(KEY.trims, {}); // uri -> { start, end, name, artist }
  let settings = { trimsEnabled: true, trimsInSessions: true, fadeSeconds: 3, ...load(KEY.settings, {}) };
  const defaultTemplate = () => ({
    id: String(Date.now()),
    name: "50-minute workout",
    totalMin: 50,
    shuffle: true,
    smartFit: true,
    phases: [
      { name: "Warm-up", playlistUri: "", mode: "minutes", value: 6 },
      { name: "Normal", playlistUri: "", mode: "minutes", value: 36 },
      { name: "Cool-down", playlistUri: "", mode: "rest", value: 0 },
    ],
  });
  let templates = load(KEY.templates, null) || [defaultTemplate()];
  let activeTemplateId = load(KEY.activeTemplate, templates[0].id);
  const saveTrims = () => save(KEY.trims, trims);
  const saveSettings = () => save(KEY.settings, settings);
  const saveTemplates = () => {
    save(KEY.templates, templates);
    save(KEY.activeTemplate, activeTemplateId);
  };

  // ----- player adapter ----------------------------------------------------
  const P = Spicetify.Player;
  const player = {
    currentUri: () => (P.data && ((P.data.item && P.data.item.uri) || (P.data.track && P.data.track.uri))) || null,
    progress: () => P.getProgress(),
    isPlaying: () => P.isPlaying(),
    play: (uri) => P.playUri(uri),
    // Spicetify treats values <= 1 as a fraction of the track, so never pass those.
    seek: (ms) => P.seek(Math.max(2, Math.round(ms))),
    next: () => P.next(),
    pause: () => P.pause(),
    getVolume: () => P.getVolume(),
    setVolume: (v) => P.setVolume(v),
  };

  const notify = (msg, isError = false) => Spicetify.showNotification(msg, isError);

  // ----- Spotify data ------------------------------------------------------
  async function listPlaylists() {
    try {
      const root = await Spicetify.Platform.RootlistAPI.getContents();
      const out = [];
      const walk = (items, prefix) => {
        for (const it of items || []) {
          if (it.type === "playlist") out.push({ uri: it.uri, name: prefix + it.name });
          else if (it.type === "folder") walk(it.items, prefix + it.name + " / ");
        }
      };
      walk(root.items, "");
      return out;
    } catch (e) {
      console.warn("[Playlist Plus] could not list playlists", e);
      return [];
    }
  }

  const isPlayableUri = (uri) => typeof uri === "string" && (uri.startsWith("spotify:track:") || uri.startsWith("spotify:episode:"));

  async function loadPlaylistTracks(uri) {
    try {
      const res = await Spicetify.Platform.PlaylistAPI.getContents(uri, { limit: 10000 });
      return (res.items || [])
        .filter((it) => isPlayableUri(it.uri) && it.isPlayable !== false)
        .map((it) => ({
          uri: it.uri,
          name: it.name,
          artist: (it.artists || []).map((a) => a.name).join(", "),
          duration: (it.duration && it.duration.milliseconds) || it.duration || 0,
        }))
        .filter((t) => t.duration > 0);
    } catch (e) {
      console.warn("[Playlist Plus] PlaylistAPI failed, trying Cosmos", e);
    }
    const res = await Spicetify.CosmosAsync.get(`sp://core-playlist/v1/playlist/${uri}/rows`, {
      policy: { link: true, name: true, length: true, playable: true, artists: { name: true } },
    });
    return (res.rows || [])
      .filter((r) => isPlayableUri(r.link) && r.playable !== false && r.length > 0)
      .map((r) => ({ uri: r.link, name: r.name, artist: (r.artists || []).map((a) => a.name).join(", "), duration: r.length * 1000 }));
  }

  async function getTrackInfo(uri) {
    if (player.currentUri() === uri && P.data.item) {
      const it = P.data.item;
      return { name: it.name, artist: (it.artists || []).map((a) => a.name).join(", "), duration: P.getDuration() };
    }
    try {
      const t = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${uri.split(":")[2]}`);
      return { name: t.name, artist: t.artists.map((a) => a.name).join(", "), duration: t.duration_ms };
    } catch {
      return { name: (trims[uri] && trims[uri].name) || uri, artist: "", duration: null };
    }
  }

  // ----- tiny DOM helper ---------------------------------------------------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "className") el.className = v;
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    el.append(...toNodes(children));
    return el;
  }

  // Nested arrays are flattened and null/false skipped, so `cond && h(...)` works.
  const toNodes = (children) => children.flat(Infinity).filter((c) => c != null && c !== false).map((c) => (c instanceof Node ? c : String(c)));
  const fill = (el, ...children) => el.replaceChildren(...toNodes(children));

  const style = document.createElement("style");
  style.textContent = `
    .pp { color: var(--spice-text, #fff); font-size: 14px; }
    .pp h3 { font-size: 16px; font-weight: 700; margin: 16px 0 8px; }
    .pp .pp-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
    .pp .pp-tab { background: transparent; border: 1px solid var(--spice-button-disabled, #555); color: inherit; border-radius: 16px; padding: 4px 14px; cursor: pointer; }
    .pp .pp-tab.on { background: var(--spice-button, #1db954); border-color: transparent; color: #000; }
    .pp input, .pp select { background: var(--spice-main-elevated, #333); color: inherit; border: 1px solid var(--spice-button-disabled, #555); border-radius: 4px; padding: 4px 6px; font: inherit; }
    .pp input[type=number] { width: 70px; }
    .pp input.pp-time { width: 80px; }
    .pp input.pp-name { width: 110px; }
    .pp select.pp-playlist { max-width: 220px; }
    .pp input.pp-link { width: 150px; }
    .pp .pp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; }
    .pp .pp-btn { background: var(--spice-button, #1db954); color: #000; border: 0; border-radius: 16px; padding: 6px 16px; font-weight: 700; cursor: pointer; }
    .pp .pp-btn.sec { background: transparent; color: inherit; border: 1px solid var(--spice-button-disabled, #777); font-weight: 400; }
    .pp .pp-btn.small { padding: 2px 10px; font-size: 12px; }
    .pp .pp-muted { color: var(--spice-subtext, #aaa); font-size: 12px; }
    .pp .pp-error { color: #f15e6c; margin: 8px 0; }
    .pp table { width: 100%; border-collapse: collapse; }
    .pp td, .pp th { text-align: left; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,.08); }
    .pp .pp-plan { max-height: 320px; overflow: auto; }
    .pp textarea { width: 100%; height: 120px; background: var(--spice-main-elevated, #333); color: inherit; font-family: monospace; }
    #pp-widget { position: fixed; right: 16px; bottom: 104px; z-index: 9999; background: var(--spice-main-elevated, #282828); color: var(--spice-text, #fff); border-radius: 8px; padding: 10px 14px; box-shadow: 0 4px 16px rgba(0,0,0,.5); font-size: 13px; min-width: 220px; }
    #pp-widget b { font-size: 14px; }
    #pp-widget .pp-row { display: flex; gap: 6px; margin-top: 8px; }
    #pp-widget button { background: transparent; color: inherit; border: 1px solid #777; border-radius: 12px; padding: 2px 10px; cursor: pointer; font-size: 12px; }
  `;
  document.head.append(style);

  // ----- trim editor -------------------------------------------------------
  async function openTrimEditor(uri) {
    const info = await getTrackInfo(uri);
    const existing = trims[uri] || {};
    const fmt = (ms) => (ms ? formatTime(ms) : "");
    const startIn = h("input", { className: "pp-time", placeholder: "0:00", value: fmt(existing.start) });
    const endIn = h("input", { className: "pp-time", placeholder: "end", value: fmt(existing.end) });
    const err = h("div", { className: "pp-error" });
    const isCurrent = () => player.currentUri() === uri;
    const nowBtn = (input) =>
      h("button", {
        className: "pp-btn sec small",
        title: "Use the current playback position",
        onClick: () => {
          if (!isCurrent()) return notify("Play this song first to use its current position.", true);
          input.value = formatTime(player.progress());
        },
      }, "Use current position");

    const read = () => {
      const start = parseTime(startIn.value) || 0;
      const end = parseTime(endIn.value);
      if (Number.isNaN(start) || Number.isNaN(end)) return { error: "Use m:ss, e.g. 1:05." };
      if (end != null && end <= start + 5000) return { error: "End must be at least 5 seconds after start." };
      if (info.duration && end != null && end > info.duration) return { error: `End is past the song's length (${formatTime(info.duration)}).` };
      if (info.duration && start >= info.duration) return { error: "Start is past the end of the song." };
      return { start, end };
    };

    const content = h("div", { className: "pp" },
      h("div", { className: "pp-muted" }, `${info.artist ? info.artist + " · " : ""}${info.duration ? "Length " + formatTime(info.duration) : ""}`),
      h("div", { className: "pp-row" }, h("span", { style: "width:50px" }, "Start"), startIn, nowBtn(startIn)),
      h("div", { className: "pp-row" }, h("span", { style: "width:50px" }, "End"), endIn, nowBtn(endIn)),
      h("div", { className: "pp-muted" }, "Leave End empty to play to the end of the song. Format m:ss (decimals allowed, e.g. 1:05.5)."),
      err,
      h("div", { className: "pp-row" },
        h("button", {
          className: "pp-btn",
          onClick: () => {
            const r = read();
            if (r.error) return (err.textContent = r.error);
            if (!r.start && r.end == null) delete trims[uri];
            else trims[uri] = { start: r.start, end: r.end, name: info.name, artist: info.artist };
            saveTrims();
            Spicetify.PopupModal.hide();
            notify(trims[uri] ? `Trimmed "${info.name}"` : `Removed trim from "${info.name}"`);
          },
        }, "Save"),
        h("button", {
          className: "pp-btn sec",
          onClick: async () => {
            const r = read();
            if (r.error) return (err.textContent = r.error);
            err.textContent = "";
            if (!isCurrent()) {
              await P.playUri(uri);
              for (let i = 0; i < 30 && !isCurrent(); i++) await new Promise((res) => setTimeout(res, 100));
            }
            player.seek(r.start || 0);
          },
        }, "Preview start"),
        h("button", {
          className: "pp-btn sec",
          onClick: () => {
            const r = read();
            if (r.error) return (err.textContent = r.error);
            if (r.end == null) return (err.textContent = "No end point set.");
            if (!isCurrent()) return notify("Play this song first.", true);
            player.seek(Math.max(r.start || 0, r.end - 5000));
          },
        }, "Preview end"),
        trims[uri] &&
          h("button", {
            className: "pp-btn sec",
            onClick: () => {
              delete trims[uri];
              saveTrims();
              Spicetify.PopupModal.hide();
              notify(`Removed trim from "${info.name}"`);
            },
          }, "Remove trim"),
      ),
    );
    Spicetify.PopupModal.display({ title: `Trim: ${info.name}`, content, isLarge: true });
  }

  // ----- main panel --------------------------------------------------------
  let runner = null;
  let panelTab = "session";

  async function openPanel(tab) {
    if (tab) panelTab = tab;
    const playlists = await listPlaylists();
    const body = h("div");
    const tabs = h("div", { className: "pp-tabs" });
    const render = () => {
      fill(
        tabs,
        ...[["session", "Timed session"], ["trims", "Trimmed songs"], ["settings", "Settings"]].map(([id, label]) =>
          h("button", { className: "pp-tab" + (panelTab === id ? " on" : ""), onClick: () => ((panelTab = id), render()) }, label),
        ),
      );
      fill(body, panelTab === "session" ? sessionTab(playlists) : panelTab === "trims" ? trimsTab(render) : settingsTab());
    };
    render();
    Spicetify.PopupModal.display({ title: "Playlist Plus", content: h("div", { className: "pp" }, tabs, body), isLarge: true });
  }

  function sessionTab(playlists) {
    let tpl = templates.find((t) => t.id === activeTemplateId) || templates[0];
    const root = h("div");
    const err = h("div", { className: "pp-error" });
    const planBox = h("div", { className: "pp-plan" });

    const persist = () => saveTemplates();

    const render = () => {
      const tplSelect = h("select", {
        onChange: (e) => {
          activeTemplateId = e.target.value;
          persist();
          tpl = templates.find((t) => t.id === activeTemplateId);
          render();
        },
      }, templates.map((t) => h("option", { value: t.id, selected: t.id === tpl.id }, t.name)));

      const phaseRows = tpl.phases.map((ph, i) => {
        const known = playlists.some((p) => p.uri === ph.playlistUri);
        const plSelect = h("select", {
          className: "pp-playlist",
          onChange: (e) => ((ph.playlistUri = e.target.value), persist()),
        },
          h("option", { value: "" }, "Choose playlist…"),
          !known && ph.playlistUri && h("option", { value: ph.playlistUri, selected: true }, ph.playlistUri),
          playlists.map((p) => h("option", { value: p.uri, selected: p.uri === ph.playlistUri }, p.name)),
        );
        const link = h("input", {
          className: "pp-link",
          placeholder: "…or paste link",
          onChange: (e) => {
            const uri = normalizePlaylistUri(e.target.value);
            if (!uri) return notify("That doesn't look like a playlist link.", true);
            ph.playlistUri = uri;
            persist();
            render();
          },
        });
        const valueIn = h("input", {
          type: "number",
          min: "0",
          step: "0.5",
          value: ph.value,
          disabled: ph.mode === "rest",
          onChange: (e) => ((ph.value = Number(e.target.value)), persist()),
        });
        const modeSel = h("select", {
          onChange: (e) => {
            ph.mode = e.target.value;
            persist();
            render();
          },
        },
          h("option", { value: "minutes", selected: ph.mode === "minutes" }, "minutes"),
          h("option", { value: "percent", selected: ph.mode === "percent" }, "% of total"),
          h("option", { value: "rest", selected: ph.mode === "rest" }, "remaining time"),
        );
        return h("div", { className: "pp-row" },
          h("input", { className: "pp-name", value: ph.name, onChange: (e) => ((ph.name = e.target.value), persist()) }),
          plSelect,
          link,
          valueIn,
          modeSel,
          h("button", { className: "pp-btn sec small", title: "Move up", disabled: i === 0, onClick: () => {
            [tpl.phases[i - 1], tpl.phases[i]] = [tpl.phases[i], tpl.phases[i - 1]];
            persist();
            render();
          } }, "↑"),
          h("button", { className: "pp-btn sec small", title: "Remove phase", onClick: () => {
            tpl.phases.splice(i, 1);
            persist();
            render();
          } }, "✕"),
        );
      });

      fill(
        root,
        h("div", { className: "pp-row" },
          h("span", null, "Template"),
          tplSelect,
          h("button", { className: "pp-btn sec small", onClick: () => {
            const name = prompt("Name for the new template", tpl.name + " (copy)");
            if (!name) return;
            const copy = { ...JSON.parse(JSON.stringify(tpl)), id: String(Date.now()), name };
            templates.push(copy);
            activeTemplateId = copy.id;
            tpl = copy;
            persist();
            render();
          } }, "Duplicate"),
          h("button", { className: "pp-btn sec small", onClick: () => {
            const name = prompt("Rename template", tpl.name);
            if (!name) return;
            tpl.name = name;
            persist();
            render();
          } }, "Rename"),
          h("button", { className: "pp-btn sec small", disabled: templates.length < 2, onClick: () => {
            if (!confirm(`Delete template "${tpl.name}"?`)) return;
            templates = templates.filter((t) => t !== tpl);
            tpl = templates[0];
            activeTemplateId = tpl.id;
            persist();
            render();
          } }, "Delete"),
        ),
        h("div", { className: "pp-row" },
          h("span", null, "Session length"),
          h("input", { type: "number", min: "1", value: tpl.totalMin, onChange: (e) => ((tpl.totalMin = Number(e.target.value)), persist()) }),
          h("span", null, "minutes"),
        ),
        h("h3", null, "Phases (played in order)"),
        phaseRows,
        h("div", { className: "pp-row" },
          h("button", { className: "pp-btn sec small", onClick: () => {
            tpl.phases.push({ name: `Phase ${tpl.phases.length + 1}`, playlistUri: "", mode: "minutes", value: 5 });
            persist();
            render();
          } }, "+ Add phase"),
        ),
        h("div", { className: "pp-muted" }, "“remaining time” phases share whatever the other phases don't use. Without one, leftover time goes to the last phase."),
        h("h3", null, "Options"),
        h("div", { className: "pp-row" },
          h("label", null, h("input", { type: "checkbox", checked: tpl.shuffle, onChange: (e) => ((tpl.shuffle = e.target.checked), persist()) }), " Shuffle within each phase"),
        ),
        h("div", { className: "pp-row" },
          h("label", null, h("input", { type: "checkbox", checked: tpl.smartFit, onChange: (e) => ((tpl.smartFit = e.target.checked), persist()) }), " Smart fit (prefer songs that finish before the phase ends)"),
        ),
        err,
        h("div", { className: "pp-row" },
          h("button", { className: "pp-btn", onClick: () => run(false) }, runner && runner.active ? "Restart session" : "Start session"),
          h("button", { className: "pp-btn sec", onClick: () => run(true) }, "Preview plan"),
          runner && runner.active && h("button", { className: "pp-btn sec", onClick: () => (stopSession(), render()) }, "Stop current session"),
        ),
        planBox,
      );
    };

    async function buildPlan() {
      const totalMs = Number(tpl.totalMin) * 60000;
      const budgets = computeBudgets(totalMs, tpl.phases);
      const trimMap = settings.trimsInSessions ? trims : {};
      const cache = {};
      const phases = [];
      for (let i = 0; i < tpl.phases.length; i++) {
        const ph = tpl.phases[i];
        if (budgets[i] <= 0) continue;
        if (!ph.playlistUri) throw new Error(`Choose a playlist for "${ph.name}".`);
        let pool = cache[ph.playlistUri];
        if (!pool) {
          try {
            pool = cache[ph.playlistUri] = await loadPlaylistTracks(ph.playlistUri);
          } catch (e) {
            throw new Error(`Couldn't load the playlist for "${ph.name}".`);
          }
        }
        if (!pool.length) throw new Error(`The playlist for "${ph.name}" has no playable songs.`);
        const prev = phases.length ? phases[phases.length - 1].items.slice(-1)[0] : null;
        const items = planPhase(pool, budgets[i], { shuffle: tpl.shuffle, smartFit: tpl.smartFit, trims: trimMap, prevUri: prev && prev.uri });
        phases.push({ name: ph.name, budget: budgets[i], pool, items });
      }
      if (!phases.length) throw new Error("No phase has any time assigned.");
      return phases;
    }

    function showPlan(phases) {
      fill(
        planBox,
        h("h3", null, "Plan"),
        phases.map((ph) => {
          let t = 0;
          const rows = [];
          for (const it of ph.items) {
            if (t >= ph.budget) break;
            const plays = Math.min(it.length, ph.budget - t);
            rows.push(h("tr", null,
              h("td", { className: "pp-muted" }, formatTime(t)),
              h("td", null, it.name, h("span", { className: "pp-muted" }, it.artist ? " · " + it.artist : "")),
              h("td", { className: "pp-muted" }, plays < it.length ? `${formatTime(plays)} (cut)` : formatTime(plays)),
            ));
            t += it.length;
          }
          return h("div", null, h("b", null, `${ph.name} — ${formatTime(ph.budget)}`), h("table", null, rows));
        }),
        h("div", { className: "pp-row" }, h("button", { className: "pp-btn", onClick: () => startSession(phases) }, "Start this plan")),
      );
    }

    async function run(previewOnly) {
      err.textContent = "";
      fill(planBox, h("div", { className: "pp-muted" }, "Loading playlists…"));
      try {
        const phases = await buildPlan();
        if (previewOnly) showPlan(phases);
        else startSession(phases);
      } catch (e) {
        fill(planBox);
        err.textContent = e.message;
      }
    }

    render();
    return root;
  }

  function trimsTab(rerender) {
    const entries = Object.entries(trims);
    const io = h("textarea", { placeholder: "Paste exported trims here to import" });
    return h("div", null,
      h("div", { className: "pp-muted" }, "Right-click any song → “Trim song…” to add one."),
      entries.length
        ? h("table", null,
            h("tr", null, h("th", null, "Song"), h("th", null, "Plays"), h("th")),
            entries.map(([uri, t]) =>
              h("tr", null,
                h("td", null, t.name || uri, h("span", { className: "pp-muted" }, t.artist ? " · " + t.artist : "")),
                h("td", null, `${formatTime(t.start || 0)} – ${t.end ? formatTime(t.end) : "end"}`),
                h("td", null,
                  h("button", { className: "pp-btn sec small", onClick: () => openTrimEditor(uri) }, "Edit"), " ",
                  h("button", { className: "pp-btn sec small", onClick: () => (delete trims[uri], saveTrims(), rerender()) }, "Remove"),
                ),
              ),
            ),
          )
        : h("p", null, "No trimmed songs yet."),
      h("h3", null, "Backup"),
      io,
      h("div", { className: "pp-row" },
        h("button", { className: "pp-btn sec small", onClick: () => {
          io.value = JSON.stringify(trims, null, 1);
          io.select();
        } }, "Export"),
        h("button", { className: "pp-btn sec small", onClick: () => {
          try {
            const data = JSON.parse(io.value);
            if (typeof data !== "object" || Array.isArray(data)) throw new Error();
            Object.assign(trims, data);
            saveTrims();
            notify("Trims imported");
            rerender();
          } catch {
            notify("That isn't valid trim data.", true);
          }
        } }, "Import (merge)"),
      ),
    );
  }

  function settingsTab() {
    const cb = (key, label) =>
      h("div", { className: "pp-row" },
        h("label", null, h("input", { type: "checkbox", checked: settings[key], onChange: (e) => ((settings[key] = e.target.checked), saveSettings()) }), " " + label),
      );
    return h("div", null,
      cb("trimsEnabled", "Apply song trims during normal listening"),
      cb("trimsInSessions", "Apply song trims during timed sessions"),
      h("div", { className: "pp-row" },
        h("span", null, "Fade out when a phase cuts a song short"),
        h("input", { type: "number", min: "0", max: "15", value: settings.fadeSeconds, onChange: (e) => ((settings.fadeSeconds = Math.max(0, Number(e.target.value) || 0)), saveSettings()) }),
        h("span", null, "seconds"),
      ),
    );
  }

  // ----- session lifecycle -------------------------------------------------
  const widget = h("div", { id: "pp-widget", style: "display:none" });
  document.body.append(widget);

  function renderWidget() {
    const s = runner && runner.status();
    if (!s) {
      widget.style.display = "none";
      return;
    }
    widget.style.display = "";
    fill(
      widget,
      h("div", null, h("b", null, s.phaseName), h("span", { className: "pp-muted" }, `  (${s.phaseIdx + 1}/${s.phaseCount})`)),
      h("div", null, `${formatTime(s.phaseLeft)} left in phase`),
      h("div", null, `${formatTime(s.totalLeft)} left in session`),
      h("div", { className: "pp-row" },
        h("button", { onClick: () => runner.skipTrack() }, "Next song"),
        s.phaseIdx + 1 < s.phaseCount && h("button", { onClick: () => runner.skipPhase() }, "Next phase"),
        h("button", { onClick: stopSession }, "Stop"),
      ),
    );
  }

  function startSession(phases) {
    if (runner) runner.stop();
    Spicetify.PopupModal.hide();
    runner = new SessionRunner(player, phases, {
      fadeMs: settings.fadeSeconds * 1000,
      trims: settings.trimsInSessions ? trims : {},
      onEvent: (type, r) => {
        if (type === "phase") notify(`Now: ${r.phase.name}`);
        if (type === "finish") notify("Session complete 🎉");
        renderWidget();
      },
    });
    runner.start();
    notify(`Session started: ${phases[0].name}`);
    renderWidget();
  }

  function stopSession() {
    if (!runner) return;
    runner.stop();
    runner = null;
    renderWidget();
    notify("Session stopped");
  }

  // ----- main loop ---------------------------------------------------------
  const trimWatcher = new TrimWatcher(player, () => trims);
  let lastTick = Date.now();
  let lastWidget = 0;
  function tick() {
    const now = Date.now();
    // Clamp so a long timer stall (sleep, throttling) doesn't eat a whole phase at once.
    const dt = Math.min(now - lastTick, 5000);
    lastTick = now;
    try {
      if (runner && runner.active) runner.tick(dt);
      else if (settings.trimsEnabled) trimWatcher.tick();
    } catch (e) {
      console.error("[Playlist Plus]", e);
    }
    if (now - lastWidget > 500) {
      lastWidget = now;
      renderWidget();
    }
  }
  setInterval(tick, 200);
  P.addEventListener("songchange", tick);

  // ----- entry points ------------------------------------------------------
  const isTrack = (uri) => typeof uri === "string" && uri.startsWith("spotify:track:");
  new Spicetify.ContextMenu.Item(
    "Trim song…",
    (uris) => openTrimEditor(uris[0]),
    (uris) => uris.length === 1 && isTrack(uris[0]),
    "edit",
  ).register();

  new Spicetify.Topbar.Button(
    "Playlist Plus",
    `<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z"/><path d="M7.25 3.5h1.5v4.19l2.78 2.78-1.06 1.06L7.25 8.31V3.5z"/></svg>`,
    () => openPanel(),
  );

  console.log("[Playlist Plus] loaded");
})();
