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
   * smartFit: prefer tracks that still fit entirely in the remaining time, and avoid leaving
   * gaps so short that the phase would end with a few-second fragment of a song.
   * Tracks repeat (re-shuffled) only if the playlist is shorter than the budget.
   */
  const MIN_TAIL = 45000;

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
      if (smartFit) {
        const ok = (t) => t.uri !== last;
        // A gap is fine if it's (almost) zero, or long enough for some other song to either
        // fill it cleanly or be cut after playing a decent part of it.
        const cleanGap = (gap) => gap < 1000 || gap >= MIN_TAIL;
        const fillable = (gap, t) =>
          gap < 1000 || (gap >= MIN_TAIL && usable.some((u) => u !== t && (len(u) > gap || cleanGap(gap - len(u)))));
        // Best: a song that fits and leaves a gap that can be filled well.
        idx = pool.findIndex((t) => ok(t) && len(t) <= remaining && fillable(remaining - len(t), t));
        // Next best: a song that runs past the boundary (cut near its end), rather than
        // one that leaves a gap only a few seconds of the next song would fill.
        if (idx < 0) idx = pool.findIndex((t) => ok(t) && len(t) > remaining);
        if (idx < 0) idx = pool.findIndex((t) => ok(t) && len(t) <= remaining && cleanGap(remaining - len(t)));
      }
      if (idx < 0) idx = pool.findIndex((t) => t.uri !== last);
      if (idx < 0) idx = 0;
      const t = pool.splice(idx, 1)[0];
      const b = trackBounds(t, trims);
      items.push({ uri: t.uri, name: t.name || t.uri, artist: t.artist || "", art: t.art || null, duration: t.duration, start: b.start, end: b.end, length: b.length });
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

  // 24px icon paths shared by the desktop and phone UIs (objects are filled, strings stroked).
  const ICONS = {
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
    scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    play: { fill: '<path d="M7 4.6v14.8a.6.6 0 0 0 .92.5l11.4-7.4a.6.6 0 0 0 0-1L7.92 4.1A.6.6 0 0 0 7 4.6z"/>' },
    pause: { fill: '<rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/>' },
    next: { fill: '<path d="M5 5.6v12.8a.6.6 0 0 0 .93.5L15 12.9V18a1 1 0 0 0 2 0V6a1 1 0 0 0-2 0v5.1L5.93 5.1A.6.6 0 0 0 5 5.6z"/>' },
    forward: { fill: '<path d="M3 6.6v10.8a.6.6 0 0 0 .95.48L11.5 12.5v4.9a.6.6 0 0 0 .95.48l7.6-5.4a.6.6 0 0 0 0-.96l-7.6-5.4a.6.6 0 0 0-.95.48v4.9L3.95 6.12A.6.6 0 0 0 3 6.6z"/>' },
    stop: { fill: '<rect x="6" y="6" width="12" height="12" rx="2"/>' },
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    more: { fill: '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>' },
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    fit: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
    computer: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    speaker: '<rect x="5" y="2" width="14" height="20" rx="2.5"/><circle cx="12" cy="14" r="4"/><path d="M12 6.5h.01"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    share: '<path d="M12 3v13M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
    download: '<path d="M12 3v13M7 11l5 5 5-5M5 21h14"/>',
    logout: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M15 8l2 2"/>',
    note: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  };

  // Phase colours, in the spirit of Spotify's browse cards.
  const PHASE_COLORS = ["#e13300", "#8d67ab", "#509bf5", "#e8115b", "#27856a", "#ba5d07", "#477d95", "#148a08"];
  const phaseColor = (i) => PHASE_COLORS[i % PHASE_COLORS.length];

  return { parseTime, formatTime, normalizePlaylistUri, computeBudgets, trackBounds, shuffled, planPhase, SessionRunner, TrimWatcher, phaseColor, ICONS };
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

  const { parseTime, formatTime, normalizePlaylistUri, computeBudgets, planPhase, SessionRunner, TrimWatcher, phaseColor, ICONS } = PlaylistPlusCore;

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
  // Spotify's client mixes https image URLs and spotify:image:<id> URIs.
  const imageUrl = (u) => (typeof u === "string" ? u.replace(/^spotify:image:/, "https://i.scdn.co/image/") : null);
  const firstImage = (images) => (images && images.length ? imageUrl(images[0].url) : null);
  async function listPlaylists() {
    try {
      const root = await Spicetify.Platform.RootlistAPI.getContents();
      const out = [];
      const walk = (items, prefix) => {
        for (const it of items || []) {
          if (it.type === "playlist") out.push({ uri: it.uri, name: prefix + it.name, art: firstImage(it.images) });
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
          art: firstImage((it.album && it.album.images) || it.images),
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
      const art = firstImage((it.album && it.album.images) || it.images) || imageUrl(it.metadata && it.metadata.image_url);
      return { name: it.name, artist: (it.artists || []).map((a) => a.name).join(", "), duration: P.getDuration(), art };
    }
    try {
      const t = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${uri.split(":")[2]}`);
      return { name: t.name, artist: t.artists.map((a) => a.name).join(", "), duration: t.duration_ms, art: firstImage(t.album && t.album.images) };
    } catch {
      const t = trims[uri] || {};
      return { name: t.name || uri, artist: t.artist || "", duration: null, art: t.art || null };
    }
  }

  // ----- tiny DOM helper ---------------------------------------------------
  const toNodes = (children) => children.flat(Infinity).filter((c) => c != null && c !== false).map((c) => (c instanceof Node ? c : String(c)));
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
  const fill = (el, ...children) => el.replaceChildren(...toNodes(children));

  function icon(name, size = 16) {
    const d = ICONS[name];
    const filled = typeof d === "object";
    const wrap = document.createElement("div");
    wrap.innerHTML = filled
      ? `<svg class="pp-i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${d.fill}</svg>`
      : `<svg class="pp-i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    return wrap.firstChild;
  }

  function art(url, size, className = "") {
    const el = h("div", { className: `pp-art ${className}`, style: `width:${size}px;height:${size}px` }, url ? null : icon("note", Math.round(size * 0.45)));
    if (url) el.style.backgroundImage = `url("${String(url).replace(/"/g, "%22")}")`;
    return el;
  }

  const toggle = (checked, onChange) =>
    h("label", { className: "pp-switch" }, h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.target.checked) }), h("span"));

  const style = document.createElement("style");
  style.textContent = `
    .pp { --pp-green: var(--spice-button, #1ed760); --pp-sub: var(--spice-subtext, #b3b3b3); --pp-fill: rgba(255,255,255,.1); color: var(--spice-text, #fff); font-size: 14px; }
    .pp-i { display: block; flex: none; }
    .pp h2 { font-size: 28px; font-weight: 900; letter-spacing: -.04em; margin: 2px 0 4px; line-height: 1.1; }
    .pp h3 { font-size: 18px; font-weight: 800; letter-spacing: -.02em; margin: 26px 0 10px; }
    .pp .pp-eyebrow { font-size: 12px; font-weight: 700; color: var(--pp-sub); }
    .pp .pp-muted { color: var(--pp-sub); font-size: 13px; }
    .pp .pp-error { color: #f3727f; font-weight: 600; margin: 10px 0; }
    .pp .pp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; }
    .pp .pp-grow { flex: 1; min-width: 0; }
    .pp .pp-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pp .pp-tabs { display: flex; gap: 8px; margin-bottom: 20px; }
    .pp .pp-tab { height: 32px; padding: 0 14px; border: 0; border-radius: 999px; background: var(--pp-fill); color: inherit; font: inherit; font-weight: 600; cursor: pointer; transition: background .15s; }
    .pp .pp-tab:hover { background: rgba(255,255,255,.16); }
    .pp .pp-tab.on { background: #fff; color: #000; }
    .pp input:not([type=checkbox]):not([type=range]), .pp select, .pp textarea {
      height: 36px; padding: 0 10px; border: 0; border-radius: 4px; background: var(--pp-fill); color: inherit; font: inherit; outline: 0;
      box-shadow: inset 0 0 0 1px transparent; transition: box-shadow .15s;
    }
    .pp input:focus, .pp select:focus, .pp textarea:focus { box-shadow: inset 0 0 0 2px #fff; }
    .pp select option { background: #282828; }
    .pp input[type=number] { width: 64px; }
    .pp textarea { width: 100%; height: 110px; padding: 10px; font: 12px/1.4 ui-monospace, monospace; resize: vertical; }
    .pp .pp-btn { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 24px; border: 0; border-radius: 999px; background: var(--pp-green); color: #000; font: inherit; font-weight: 700; cursor: pointer; transition: transform .1s, filter .15s; }
    .pp .pp-btn:hover { transform: scale(1.04); filter: brightness(1.08); }
    .pp .pp-btn.sec { background: transparent; color: inherit; box-shadow: inset 0 0 0 1px #7c7c7c; }
    .pp .pp-btn.sec:hover { box-shadow: inset 0 0 0 1px #fff; }
    .pp .pp-btn.small { height: 32px; padding: 0 14px; font-size: 13px; }
    .pp .pp-btn.danger { background: transparent; color: #f3727f; padding: 0 8px; }
    .pp .pp-icon-btn { width: 32px; height: 32px; border: 0; border-radius: 50%; display: grid; place-items: center; background: transparent; color: var(--pp-sub); cursor: pointer; transition: color .15s, background .15s; }
    .pp .pp-icon-btn:hover:not(:disabled) { color: #fff; background: var(--pp-fill); }
    .pp .pp-icon-btn.on { color: var(--pp-green); }
    .pp .pp-icon-btn:disabled { opacity: .3; cursor: default; }
    .pp .pp-fab { width: 56px; height: 56px; border: 0; border-radius: 50%; background: var(--pp-green); color: #000; display: grid; place-items: center; cursor: pointer; box-shadow: 0 8px 8px rgba(0,0,0,.3); transition: transform .1s; }
    .pp .pp-fab:hover { transform: scale(1.04); }
    .pp .pp-art { flex: none; border-radius: 4px; background: #282828 center/cover no-repeat; display: grid; place-items: center; color: #7f7f7f; box-shadow: 0 4px 12px rgba(0,0,0,.35); }
    .pp .pp-hero { margin: -8px -8px 0; padding: 20px 20px 24px; border-radius: 8px; background: linear-gradient(180deg, color-mix(in srgb, var(--c) 70%, transparent), transparent); display: flex; align-items: flex-end; gap: 16px; }
    .pp .pp-phase { position: relative; border-radius: 8px; padding: 12px 12px 12px 18px; margin: 8px 0; background: linear-gradient(90deg, color-mix(in srgb, var(--c) 26%, #1f1f1f), #1f1f1f 70%); overflow: hidden; display: grid; grid-template-columns: 140px minmax(0, 1fr) 196px 72px; gap: 10px; align-items: center; }
    .pp .pp-phase::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--c); }
    .pp .pp-phase input.pp-name { background: transparent !important; font-size: 15px; font-weight: 800; padding: 0 4px; }
    .pp .pp-phase .pp-pl { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .pp .pp-phase .pp-pl select { flex: 1; min-width: 0; }
    .pp .pp-seg { display: inline-flex; background: rgba(0,0,0,.3); border-radius: 999px; padding: 3px; }
    .pp .pp-seg button { height: 28px; padding: 0 10px; border: 0; border-radius: 999px; background: transparent; color: var(--pp-sub); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
    .pp .pp-seg button.on { background: #fff; color: #000; }
    .pp .pp-amount { display: flex; align-items: center; gap: 6px; }
    .pp .pp-amount input { width: 56px !important; }
    .pp .pp-timeline { display: flex; gap: 3px; height: 8px; margin: 14px 0 8px; }
    .pp .pp-timeline > div { position: relative; border-radius: 4px; background: color-mix(in srgb, var(--c) 35%, #333); overflow: hidden; min-width: 4px; }
    .pp .pp-timeline > div > i { position: absolute; inset: 0 auto 0 0; width: var(--p, 100%); background: var(--c); border-radius: 4px; }
    .pp .pp-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; }
    .pp .pp-legend span { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--pp-sub); font-weight: 600; }
    .pp .pp-legend span::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
    .pp .pp-add { width: 100%; height: 44px; border: 1.5px dashed #555; border-radius: 8px; background: transparent; color: var(--pp-sub); font: inherit; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .pp .pp-add:hover { border-color: #fff; color: #fff; }
    .pp .pp-list { display: flex; flex-direction: column; }
    .pp .pp-item { display: flex; align-items: center; gap: 12px; padding: 6px 8px; border-radius: 4px; }
    .pp .pp-item:hover { background: var(--pp-fill); }
    .pp .pp-item .t { font-weight: 600; }
    .pp .pp-item .s { font-size: 13px; color: var(--pp-sub); display: flex; align-items: center; gap: 4px; }
    .pp .pp-item .e { color: var(--pp-sub); font-size: 13px; font-variant-numeric: tabular-nums; }
    .pp .pp-green { color: var(--pp-green) !important; }
    .pp .pp-plan { max-height: 340px; overflow: auto; margin-top: 8px; }
    .pp .pp-setting { display: flex; align-items: center; gap: 16px; padding: 12px 0; }
    .pp .pp-setting .t { font-weight: 700; }
    .pp .pp-switch { position: relative; width: 40px; height: 22px; flex: none; cursor: pointer; }
    .pp .pp-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
    .pp .pp-switch span { position: absolute; inset: 0; background: #727272; border-radius: 999px; transition: background .2s; }
    .pp .pp-switch span::after { content: ""; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .2s; }
    .pp .pp-switch input:checked + span { background: var(--pp-green); }
    .pp .pp-switch input:checked + span::after { transform: translateX(18px); }
    .pp .pp-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; text-align: center; margin: 18px 0 8px; }
    .pp .pp-stats .v { font-size: 26px; font-weight: 800; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
    .pp .pp-stats input.v { width: 100%; height: auto; background: transparent; text-align: center; padding: 0 0 2px; border-radius: 0; box-shadow: inset 0 -1px 0 #555; font-size: 26px; font-weight: 800; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
    .pp .pp-stats input.v:focus { box-shadow: inset 0 -2px 0 var(--pp-green); }
    .pp .pp-stats .k { font-size: 11px; color: var(--pp-sub); font-weight: 700; text-transform: uppercase; letter-spacing: .1em; margin-top: 2px; }
    .pp .pp-trim { position: relative; height: 56px; margin: 8px 0 4px; }
    .pp .pp-trim .bars { position: absolute; inset: 8px 0; display: flex; gap: 2px; }
    .pp .pp-trim .bars i { flex: 1; border-radius: 2px; background: #4d4d4d; }
    .pp .pp-trim .bars i.in { background: var(--pp-green); }
    .pp .pp-trim .head { position: absolute; top: 2px; bottom: 2px; width: 2px; background: #fff; box-shadow: 0 0 6px #000; display: none; }
    .pp .pp-trim input[type=range] { -webkit-appearance: none; appearance: none; position: absolute; inset: 0; width: 100%; height: 56px; margin: 0; background: transparent; pointer-events: none; }
    .pp .pp-trim input[type=range]::-webkit-slider-runnable-track { height: 56px; background: transparent; }
    .pp .pp-trim input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; pointer-events: auto; width: 14px; height: 56px; border-radius: 6px; background: #fff; box-shadow: 0 0 0 3px rgba(0,0,0,.5); cursor: ew-resize; }
    .pp .pp-chip { height: 32px; padding: 0 12px; border: 0; border-radius: 999px; background: var(--pp-fill); color: inherit; font: inherit; font-size: 13px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
    .pp .pp-chip:hover { background: rgba(255,255,255,.16); }
    .pp details summary { cursor: pointer; color: var(--pp-sub); font-weight: 700; padding: 8px 0; }

    #pp-widget {
      position: fixed; right: 16px; bottom: 104px; z-index: 9999; width: 300px; padding: 16px; border-radius: 8px; overflow: hidden;
      background: linear-gradient(160deg, color-mix(in srgb, var(--c) 60%, #121212) 0%, #181818 75%);
      box-shadow: 0 16px 48px rgba(0,0,0,.6); font-size: 13px; transition: background .6s;
    }
    #pp-widget .pp-eyebrow { color: rgba(255,255,255,.75); }
    #pp-widget .pp-count { font-size: 44px; font-weight: 900; letter-spacing: -.05em; line-height: 1; margin: 6px 0 2px; font-variant-numeric: tabular-nums; }
    #pp-widget .pp-now { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
    #pp-widget .pp-ctrl { display: flex; justify-content: space-between; margin-top: 10px; }
  `;
  document.head.append(style);

  // ----- trim editor -------------------------------------------------------
  async function openTrimEditor(uri) {
    const info = await getTrackInfo(uri);
    const dur = info.duration;
    if (!dur) return notify("Couldn't load this song's length.", true);
    const existing = trims[uri] || {};
    let start = existing.start || 0;
    let end = existing.end || dur;
    const isCurrent = () => player.currentUri() === uri;

    const BARS = 60;
    const bars = Array.from({ length: BARS }, () => h("i"));
    const head = h("div", { className: "head" });
    const rs = h("input", { type: "range", min: "0", max: String(dur), step: "500", "aria-label": "Start" });
    const re = h("input", { type: "range", min: "0", max: String(dur), step: "500", "aria-label": "End" });
    const startIn = h("input", { className: "v", "aria-label": "Start time" });
    const endIn = h("input", { className: "v", "aria-label": "End time" });
    const plays = h("div", { className: "v" });

    const update = () => {
      bars.forEach((b, i) => b.classList.toggle("in", ((i + 0.5) / BARS) * dur >= start && ((i + 0.5) / BARS) * dur <= end));
      rs.value = String(start);
      re.value = String(end);
      if (document.activeElement !== startIn) startIn.value = formatTime(start);
      if (document.activeElement !== endIn) endIn.value = formatTime(end);
      plays.textContent = formatTime(end - start);
    };
    rs.addEventListener("input", () => ((start = Math.min(Number(rs.value), end - 5000)), update()));
    re.addEventListener("input", () => ((end = Math.max(Number(re.value), start + 5000)), update()));
    const fromField = (input, which) => () => {
      const v = parseTime(input.value);
      if (v != null && !Number.isNaN(v)) {
        if (which === "start") start = Math.max(0, Math.min(v, end - 5000));
        else end = Math.min(dur, Math.max(v, start + 5000));
      }
      update();
    };
    startIn.addEventListener("change", fromField(startIn, "start"));
    endIn.addEventListener("change", fromField(endIn, "end"));

    const here = (label, which) =>
      h("button", { className: "pp-chip", onClick: () => {
        if (!isCurrent()) return notify("Play this song first, then use its position.", true);
        const p = Math.round(player.progress() / 500) * 500;
        if (which === "start") start = Math.max(0, Math.min(p, end - 5000));
        else end = Math.min(dur, Math.max(p, start + 5000));
        update();
      } }, icon("timer", 14), label);
    const playFrom = async (ms) => {
      if (!isCurrent()) {
        await P.playUri(uri);
        for (let i = 0; i < 30 && !isCurrent(); i++) await new Promise((res) => setTimeout(res, 100));
      }
      player.seek(ms);
    };

    const content = h("div", { className: "pp" },
      h("div", { className: "pp-row", style: "gap:16px" },
        art(info.art, 72),
        h("div", { className: "pp-grow" },
          h("div", { className: "pp-eyebrow" }, "Trim song"),
          h("div", { className: "pp-ellipsis", style: "font-size:22px;font-weight:800;letter-spacing:-.02em" }, info.name),
          h("div", { className: "pp-muted pp-ellipsis" }, info.artist),
        ),
      ),
      h("div", { className: "pp-stats" },
        h("div", null, startIn, h("div", { className: "k" }, "Start")),
        h("div", null, plays, h("div", { className: "k" }, "Plays")),
        h("div", null, endIn, h("div", { className: "k" }, "End")),
      ),
      h("div", { className: "pp-trim" }, h("div", { className: "bars" }, bars), head, rs, re),
      h("div", { className: "pp-row pp-muted", style: "justify-content:space-between;margin:0" }, h("span", null, "0:00"), h("span", null, formatTime(dur))),
      h("div", { className: "pp-row", style: "margin-top:14px" },
        here("Start here", "start"),
        here("End here", "end"),
        h("button", { className: "pp-chip", onClick: () => playFrom(start) }, icon("play", 14), "Play from start"),
        h("button", { className: "pp-chip", onClick: () => playFrom(Math.max(start, end - 5000)) }, icon("play", 14), "Hear the end"),
      ),
      h("div", { className: "pp-row", style: "margin-top:20px" },
        h("button", { className: "pp-btn", onClick: () => {
          const full = start === 0 && end >= dur;
          if (full) delete trims[uri];
          else trims[uri] = { start, end: end >= dur ? null : end, name: info.name, artist: info.artist, art: info.art || null };
          saveTrims();
          Spicetify.PopupModal.hide();
          notify(full ? `"${info.name}" plays in full` : `Trimmed "${info.name}"`);
        } }, icon("check"), "Save trim"),
        trims[uri] && h("button", { className: "pp-btn danger", onClick: () => {
          delete trims[uri];
          saveTrims();
          Spicetify.PopupModal.hide();
          notify(`Removed trim from "${info.name}"`);
        } }, "Remove trim"),
      ),
    );
    const headTimer = setInterval(() => {
      if (!content.isConnected) return clearInterval(headTimer);
      head.style.display = isCurrent() ? "block" : "none";
      head.style.left = `${Math.min(100, (player.progress() / dur) * 100)}%`;
    }, 250);
    update();
    Spicetify.PopupModal.display({ title: "Playlist Plus", content, isLarge: true });
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
        [["session", "Timed session"], ["trims", "Trimmed songs"], ["settings", "Settings"]].map(([id, label]) =>
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
    const timeline = h("div");
    const persist = () => saveTemplates();

    const updateTimeline = () => {
      try {
        const budgets = computeBudgets(Number(tpl.totalMin) * 60000, tpl.phases);
        err.textContent = "";
        fill(timeline,
          h("div", { className: "pp-timeline" }, tpl.phases.map((ph, i) => h("div", { style: `--c:${phaseColor(i)};flex:${Math.max(budgets[i], 1)}` }, h("i")))),
          h("div", { className: "pp-legend" }, tpl.phases.map((ph, i) => h("span", { style: `--c:${phaseColor(i)}` }, `${ph.name} ${formatTime(budgets[i])}`))),
        );
      } catch (e) {
        fill(timeline);
        err.textContent = e.message;
      }
    };

    const render = () => {
      const phaseCards = tpl.phases.map((ph, i) => {
        const known = playlists.find((p) => p.uri === ph.playlistUri);
        const setMode = (m) => () => {
          ph.mode = m;
          if (m === "percent" && !(ph.value > 0 && ph.value <= 100)) ph.value = 20;
          persist();
          render();
        };
        return h("div", { className: "pp-phase", style: `--c:${phaseColor(i)}` },
          h("input", { className: "pp-name", value: ph.name, "aria-label": "Phase name", onChange: (e) => ((ph.name = e.target.value || `Phase ${i + 1}`), persist(), updateTimeline()) }),
          h("div", { className: "pp-pl" },
            art(known && known.art, 36),
            h("select", { "aria-label": "Playlist", onChange: (e) => ((ph.playlistUri = e.target.value), persist(), render()) },
              h("option", { value: "" }, "Choose a playlist…"),
              !known && ph.playlistUri && h("option", { value: ph.playlistUri, selected: true }, "Pasted playlist"),
              playlists.map((p) => h("option", { value: p.uri, selected: p.uri === ph.playlistUri }, p.name)),
            ),
            h("button", { className: "pp-icon-btn", title: "Paste a playlist link", onClick: () => {
              const link = prompt("Paste a Spotify playlist link");
              if (!link) return;
              const uri = normalizePlaylistUri(link);
              if (!uri) return notify("That doesn't look like a playlist link.", true);
              ph.playlistUri = uri;
              persist();
              render();
            } }, icon("link")),
          ),
          h("div", { className: "pp-amount" },
            h("div", { className: "pp-seg" },
              h("button", { className: ph.mode === "minutes" ? "on" : "", onClick: setMode("minutes") }, "Min"),
              h("button", { className: ph.mode === "percent" ? "on" : "", onClick: setMode("percent") }, "%"),
              h("button", { className: ph.mode === "rest" ? "on" : "", onClick: setMode("rest") }, "Rest"),
            ),
            ph.mode !== "rest" && h("input", { type: "number", min: "0", step: ph.mode === "percent" ? "5" : "0.5", value: ph.value, "aria-label": "Amount", onChange: (e) => ((ph.value = Math.max(0, Number(e.target.value) || 0)), persist(), updateTimeline()) }),
          ),
          h("div", { style: "display:flex" },
            h("button", { className: "pp-icon-btn", title: "Move up", disabled: i === 0, onClick: () => {
              [tpl.phases[i - 1], tpl.phases[i]] = [tpl.phases[i], tpl.phases[i - 1]];
              persist();
              render();
            } }, icon("up")),
            h("button", { className: "pp-icon-btn", title: "Remove phase", onClick: () => {
              tpl.phases.splice(i, 1);
              persist();
              render();
            } }, icon("trash")),
          ),
        );
      });

      fill(
        root,
        h("div", { className: "pp-hero", style: `--c:${phaseColor(0)}` },
          h("div", { className: "pp-grow" },
            h("div", { className: "pp-eyebrow" }, "Timed session"),
            h("h2", { className: "pp-ellipsis" }, tpl.name),
            h("div", { className: "pp-muted" }, `${tpl.phases.length} phases · ${tpl.totalMin} min`),
          ),
          h("button", { className: "pp-icon-btn" + (tpl.shuffle ? " on" : ""), title: tpl.shuffle ? "Shuffle on" : "Shuffle off", onClick: () => ((tpl.shuffle = !tpl.shuffle), persist(), render()) }, icon("shuffle", 20)),
          h("button", { className: "pp-icon-btn" + (tpl.smartFit ? " on" : ""), title: tpl.smartFit ? "Smart fit on: prefers songs that end before the phase does" : "Smart fit off", onClick: () => ((tpl.smartFit = !tpl.smartFit), persist(), render()) }, icon("fit", 20)),
          h("button", { className: "pp-icon-btn", title: "Preview plan", onClick: () => run(true) }, icon("list", 20)),
          h("button", { className: "pp-fab", title: runner && runner.active ? "Restart session" : "Start session", onClick: () => run(false) }, icon("play", 26)),
        ),
        h("div", { className: "pp-row", style: "margin-top:16px" },
          templates.map((t) => h("button", { className: "pp-tab" + (t === tpl ? " on" : ""), onClick: () => {
            activeTemplateId = t.id;
            tpl = t;
            persist();
            render();
          } }, t.name)),
          h("button", { className: "pp-icon-btn", title: "New session", onClick: () => {
            const t = { ...defaultTemplate(), name: "New session" };
            templates.push(t);
            activeTemplateId = t.id;
            tpl = t;
            persist();
            render();
          } }, icon("plus")),
          h("div", { className: "pp-grow" }),
          h("button", { className: "pp-icon-btn", title: "Rename", onClick: () => {
            const name = prompt("Rename session", tpl.name);
            if (!name) return;
            tpl.name = name;
            persist();
            render();
          } }, icon("edit")),
          h("button", { className: "pp-icon-btn", title: "Duplicate", onClick: () => {
            const copy = { ...JSON.parse(JSON.stringify(tpl)), id: String(Date.now()), name: `${tpl.name} (copy)` };
            templates.push(copy);
            activeTemplateId = copy.id;
            tpl = copy;
            persist();
            render();
          } }, icon("copy")),
          h("button", { className: "pp-icon-btn", title: "Delete", disabled: templates.length < 2, onClick: () => {
            if (!confirm(`Delete "${tpl.name}"?`)) return;
            templates = templates.filter((t) => t !== tpl);
            tpl = templates[0];
            activeTemplateId = tpl.id;
            persist();
            render();
          } }, icon("trash")),
        ),
        h("h3", null, "Length"),
        h("div", { className: "pp-row" },
          h("input", { type: "number", min: "1", value: tpl.totalMin, "aria-label": "Session length in minutes", onChange: (e) => ((tpl.totalMin = Math.max(1, Number(e.target.value) || 1)), persist(), render()) }),
          h("span", { className: "pp-muted" }, "minutes"),
        ),
        timeline,
        err,
        h("h3", null, "Phases"),
        phaseCards,
        h("button", { className: "pp-add", onClick: () => {
          tpl.phases.push({ name: `Phase ${tpl.phases.length + 1}`, playlistUri: "", mode: "minutes", value: 5 });
          persist();
          render();
        } }, icon("plus"), "Add phase"),
        h("p", { className: "pp-muted" }, "Phases play in order. “Rest” phases share the time the others don't use; without one, leftover time goes to the last phase."),
        runner && runner.active && h("button", { className: "pp-btn sec small", onClick: () => (stopSession(), render()) }, icon("stop", 14), "Stop current session"),
        planBox,
      );
      updateTimeline();
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
        phases.push({ name: ph.name, color: phaseColor(i), budget: budgets[i], pool, items });
      }
      if (!phases.length) throw new Error("No phase has any time assigned.");
      return phases;
    }

    function showPlan(phases) {
      fill(
        planBox,
        h("div", { className: "pp-row", style: "margin-top:24px" },
          h("h3", { className: "pp-grow", style: "margin:0" }, "Plan"),
          h("button", { className: "pp-btn", onClick: () => startSession(phases) }, icon("play"), "Start this plan"),
        ),
        phases.map((ph) => {
          let t = 0;
          const rows = [];
          for (const it of ph.items) {
            if (t >= ph.budget) break;
            const plays = Math.min(it.length, ph.budget - t);
            const cut = plays < it.length;
            rows.push(h("div", { className: "pp-item" },
              art(it.art, 40),
              h("div", { className: "pp-grow" },
                h("div", { className: "t pp-ellipsis" }, it.name),
                h("div", { className: "s pp-ellipsis" }, it.length < it.duration && h("span", { className: "pp-green" }, icon("scissors", 12)), it.artist),
              ),
              h("div", { className: "e" + (cut ? " pp-green" : "") }, cut ? `${formatTime(plays)} ✂` : formatTime(plays)),
            ));
            t += it.length;
          }
          return h("div", { style: "margin-top:12px" },
            h("div", { className: "pp-legend", style: "margin:0 8px 4px" }, h("span", { style: `--c:${ph.color};color:#fff;font-size:14px` }, `${ph.name} · ${formatTime(ph.budget)}`)),
            h("div", { className: "pp-list" }, rows),
          );
        }),
      );
    }

    async function run(previewOnly) {
      err.textContent = "";
      fill(planBox, h("div", { className: "pp-muted", style: "margin-top:16px" }, "Loading playlists…"));
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
    const entries = Object.entries(trims).sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));
    const io = h("textarea", { placeholder: "Paste exported trims here to import them" });
    return h("div", null,
      h("div", { className: "pp-hero", style: "--c:#e8115b" },
        h("div", { className: "pp-grow" },
          h("div", { className: "pp-eyebrow" }, "Your library"),
          h("h2", null, "Trimmed songs"),
          h("div", { className: "pp-muted" }, "Right-click any song and choose “Trim song…” to add one."),
        ),
      ),
      entries.length
        ? h("div", { className: "pp-list", style: "margin-top:12px" },
            entries.map(([uri, t]) =>
              h("div", { className: "pp-item" },
                art(t.art, 40),
                h("div", { className: "pp-grow" },
                  h("div", { className: "t pp-ellipsis" }, t.name || uri),
                  h("div", { className: "s pp-ellipsis" }, t.artist || ""),
                ),
                h("span", { className: "e pp-green", style: "display:flex;align-items:center;gap:4px" }, icon("scissors", 12), `${formatTime(t.start || 0)} – ${t.end ? formatTime(t.end) : "end"}`),
                h("button", { className: "pp-icon-btn", title: "Edit", onClick: () => openTrimEditor(uri) }, icon("edit")),
                h("button", { className: "pp-icon-btn", title: "Remove", onClick: () => (delete trims[uri], saveTrims(), rerender()) }, icon("trash")),
              ),
            ),
          )
        : h("p", { className: "pp-muted", style: "margin:24px 0;text-align:center" }, "No trimmed songs yet."),
      h("h3", null, "Copy trims between devices"),
      h("p", { className: "pp-muted" }, "Export here, then import on your phone (or the other way round)."),
      io,
      h("div", { className: "pp-row" },
        h("button", { className: "pp-btn sec small", onClick: () => {
          io.value = JSON.stringify(trims);
          io.select();
          try {
            navigator.clipboard.writeText(io.value);
            notify("Trims copied to clipboard");
          } catch {
            /* the text is selected for manual copying */
          }
        } }, "Export"),
        h("button", { className: "pp-btn sec small", onClick: () => {
          try {
            const data = JSON.parse(io.value);
            if (typeof data !== "object" || !data || Array.isArray(data)) throw new Error();
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
    const row = (title, desc, control) =>
      h("div", { className: "pp-setting" },
        h("div", { className: "pp-grow" }, h("div", { className: "t" }, title), desc && h("div", { className: "pp-muted" }, desc)),
        control,
      );
    return h("div", null,
      row("Trim songs while listening", "Apply your trims whenever a trimmed song plays.", toggle(settings.trimsEnabled, (v) => ((settings.trimsEnabled = v), saveSettings()))),
      row("Trim songs in timed sessions", null, toggle(settings.trimsInSessions, (v) => ((settings.trimsInSessions = v), saveSettings()))),
      row("Fade out cut songs", "Seconds to fade when a phase ends mid-song.",
        h("input", { type: "number", min: "0", max: "15", value: settings.fadeSeconds, "aria-label": "Fade seconds", onChange: (e) => ((settings.fadeSeconds = Math.max(0, Math.min(15, Number(e.target.value) || 0))), saveSettings()) }),
      ),
    );
  }

  // ----- session lifecycle -------------------------------------------------
  const widget = h("div", { id: "pp-widget", className: "pp", style: "display:none" });
  document.body.append(widget);
  const w = { key: null };

  function renderWidget() {
    const s = runner && runner.status();
    if (!s) {
      widget.style.display = "none";
      w.key = null;
      return;
    }
    widget.style.display = "";
    const item = s.item;
    const key = `${s.phaseIdx}|${runner.itemIdx}|${player.isPlaying()}`;
    if (w.key !== key) {
      w.key = key;
      widget.style.setProperty("--c", runner.phase.color || phaseColor(s.phaseIdx));
      w.segs = runner.phases.map((p, i) => h("div", { style: `--c:${p.color || phaseColor(i)};flex:${p.budget}` }, h("i")));
      fill(
        widget,
        h("div", { className: "pp-row", style: "margin:0" },
          h("div", { className: "pp-eyebrow pp-grow" }, `Phase ${s.phaseIdx + 1} of ${s.phaseCount}`),
          h("button", { className: "pp-icon-btn", title: "Open Playlist Plus", onClick: () => openPanel("session") }, icon("sliders")),
        ),
        h("div", { style: "font-size:20px;font-weight:800;letter-spacing:-.02em" }, s.phaseName),
        (w.count = h("div", { className: "pp-count" })),
        (w.sub = h("div", { className: "pp-muted" })),
        h("div", { className: "pp-timeline" }, w.segs),
        item && h("div", { className: "pp-now" },
          art(item.art, 40),
          h("div", { className: "pp-grow" },
            h("div", { className: "pp-ellipsis", style: "font-weight:700" }, item.name),
            h("div", { className: "pp-muted pp-ellipsis" }, item.artist),
          ),
          item.length < item.duration && h("span", { className: "pp-green", title: "Trimmed" }, icon("scissors", 14)),
        ),
        h("div", { className: "pp-ctrl" },
          h("button", { className: "pp-icon-btn", title: "Stop session", onClick: stopSession }, icon("stop", 18)),
          h("button", { className: "pp-icon-btn", title: player.isPlaying() ? "Pause" : "Play", onClick: () => P.togglePlay() }, icon(player.isPlaying() ? "pause" : "play", 20)),
          h("button", { className: "pp-icon-btn", title: "Next song", onClick: () => runner.skipTrack() }, icon("next", 18)),
          h("button", { className: "pp-icon-btn", title: "Next phase", disabled: s.phaseIdx + 1 >= s.phaseCount, onClick: () => runner.skipPhase() }, icon("forward", 18)),
        ),
      );
    }
    w.count.textContent = formatTime(s.phaseLeft);
    w.sub.textContent = `left in phase · ${formatTime(s.totalLeft)} in session`;
    runner.phases.forEach((p, i) => {
      const pct = i < s.phaseIdx ? 100 : i > s.phaseIdx ? 0 : Math.min(100, ((p.budget - s.phaseLeft) / p.budget) * 100);
      w.segs[i].firstChild.style.setProperty("--p", `${pct}%`);
    });
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
        w.key = null;
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
