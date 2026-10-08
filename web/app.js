// Playlist Plus for phones: controls the Spotify app on this phone (or any Spotify device)
// through the Spotify Web API. Shares its playback logic with the desktop extension.
(() => {
  const { parseTime, formatTime, normalizePlaylistUri, computeBudgets, planSession, SessionRunner, TrimWatcher, phaseColor, SyncStore, createGistClient, createSyncer } = window.PlaylistPlusCore;

  // ----- storage (same keys and formats as the desktop extension) -----------
  const KEY = {
    trims: "playlist-plus:trims",
    templates: "playlist-plus:templates",
    settings: "playlist-plus:settings",
    activeTemplate: "playlist-plus:active-template",
    clientId: "playlist-plus:client-id",
    auth: "playlist-plus:auth",
    verifier: "playlist-plus:pkce-verifier",
    session: "playlist-plus:session",
    tombstones: "playlist-plus:tombstones",
    syncToken: "playlist-plus:sync-token",
    gistId: "playlist-plus:sync-gist",
    syncLogin: "playlist-plus:sync-login",
  };
  const load = (k, fallback) => {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  };
  const save = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {
      console.warn("Could not save", k, e);
    }
  };

  let settings = { trimsEnabled: true, trimsInSessions: true, fadeSeconds: 3, crossfadeSeconds: 0, ...load(KEY.settings, {}) };
  // The built-in template has a fixed id, so it's the same template on every synced device.
  const defaultTemplate = (id = "default-workout") => ({
    id,
    name: "50-minute workout",
    totalMin: 50,
    shuffle: true,
    smartFit: true,
    transitions: "smooth",
    phases: [
      { name: "Warm-up", playlistUri: "", mode: "minutes", value: 6 },
      { name: "Normal", playlistUri: "", mode: "minutes", value: 36 },
      { name: "Cool-down", playlistUri: "", mode: "rest", value: 0 },
    ],
  });
  // Trims and templates live in a SyncStore, which tracks changes for syncing between devices.
  const store = new SyncStore({ load, save }, {
    keys: { trims: KEY.trims, templates: KEY.templates, tombstones: KEY.tombstones },
    defaultTemplates: () => [{ ...defaultTemplate(), updatedAt: 0 }],
  });
  const trims = store.trims;
  const templates = store.templates;
  let activeTemplateId = load(KEY.activeTemplate, templates[0].id);
  const saveSettings = () => save(KEY.settings, settings);
  const saveActiveTemplate = () => save(KEY.activeTemplate, activeTemplateId);

  // ----- Spotify auth (Authorization Code + PKCE, no server needed) ----------
  const SCOPES = "user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative";
  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, "");
  let clientId = load(KEY.clientId, "");
  let auth = load(KEY.auth, null); // { access, refresh, expires }

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  async function login() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    save(KEY.verifier, verifier);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: SCOPES,
      redirect_uri: redirectUri(),
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    location.href = `https://accounts.spotify.com/authorize?${q}`;
  }

  async function tokenRequest(params) {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, ...params }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error_description || data.error || `Login failed (${res.status})`);
    auth = {
      access: data.access_token,
      refresh: data.refresh_token || (auth && auth.refresh),
      expires: Date.now() + (data.expires_in - 60) * 1000,
    };
    save(KEY.auth, auth);
  }

  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.has("code") && !q.has("error")) return;
    history.replaceState(null, "", redirectUri());
    if (q.has("error")) throw new Error(`Spotify login was cancelled (${q.get("error")}).`);
    await tokenRequest({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: redirectUri(), code_verifier: load(KEY.verifier, "") });
  }

  let refreshing = null;
  async function accessToken() {
    if (!auth) throw new Error("Not logged in");
    if (Date.now() < auth.expires) return auth.access;
    refreshing = refreshing || tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refresh }).finally(() => (refreshing = null));
    await refreshing;
    return auth.access;
  }

  function logout() {
    auth = null;
    localStorage.removeItem(KEY.auth);
    render();
  }

  // ----- Web API -------------------------------------------------------------
  class ApiError extends Error {
    constructor(status, message, reason) {
      super(message);
      this.status = status;
      this.reason = reason;
    }
  }

  async function api(method, path, body, retried = false) {
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) {
      auth.expires = 0;
      return api(method, path, body, true);
    }
    if (res.status === 429 && !retried) {
      const wait = Number(res.headers.get("Retry-After") || 2);
      await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
      return api(method, path, body, true);
    }
    // Player commands (play, pause, seek…) answer with a plain-text id, not JSON, so only
    // parse bodies that are JSON.
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const err = (data && data.error) || {};
      throw new ApiError(res.status, err.message || (text && !data ? text.slice(0, 200) : `Spotify error ${res.status}`), err.reason);
    }
    return data;
  }

  async function getAll(path) {
    const out = [];
    let next = path;
    while (next) {
      const page = await api("GET", next.replace("https://api.spotify.com/v1", ""));
      out.push(...(page.items || []));
      next = page.next;
    }
    return out;
  }

  // Spotify lists images largest first.
  const bigArt = (images) => (images && images.length ? images[0].url : null);
  const smallArt = (images) => (images && images.length ? (images.find((i) => i.width && i.width <= 300) || images[images.length - 1]).url : null);
  const trackArt = (t) => smallArt((t.album && t.album.images) || t.images);

  let me = null;
  let playlistsCache = null;
  async function listPlaylists(force) {
    if (playlistsCache && !force) return playlistsCache;
    me = me || (await api("GET", "/me"));
    const all = await getAll("/me/playlists?limit=50");
    // Spotify only lets apps read the songs of playlists you own or collaborate on.
    playlistsCache = all
      .filter(Boolean)
      .map((p) => ({
        uri: p.uri,
        id: p.id,
        name: p.name,
        art: smallArt(p.images),
        total: (p.items && p.items.total) ?? (p.tracks && p.tracks.total) ?? null,
        readable: p.collaborative || (p.owner && p.owner.id === me.id),
      }));
    return playlistsCache;
  }

  const isPlayableUri = (uri) => typeof uri === "string" && (uri.startsWith("spotify:track:") || uri.startsWith("spotify:episode:"));
  const trackCache = {};
  async function loadPlaylistTracks(uri) {
    if (trackCache[uri]) return trackCache[uri];
    const id = uri.split(":").pop();
    let rows;
    try {
      rows = await getAll(`/playlists/${id}/items?limit=50&additional_types=track,episode`);
    } catch (e) {
      if (e.status === 403 || e.status === 404) throw new Error("Spotify won't share this playlist's songs. Use a playlist you created (you can copy songs into a new one).");
      throw e;
    }
    const tracks = rows
      .map((r) => r.item || r.track)
      .filter((t) => t && isPlayableUri(t.uri) && !t.is_local && t.duration_ms > 0)
      .map((t) => ({ uri: t.uri, name: t.name, artist: (t.artists || []).map((a) => a.name).join(", "), duration: t.duration_ms, art: trackArt(t) }));
    trackCache[uri] = tracks;
    return tracks;
  }

  // ----- player adapter over the Web API -------------------------------------
  // The runner and trim watcher read state synchronously, so we poll /me/player and
  // extrapolate the position between polls. Commands are fire-and-forget.
  const player = {
    playsUpcoming: true,
    state: null, // { uri, name, artist, duration, progress, playing, device }
    fetchedAt: 0,
    chosenDevice: null,
    lastError: null,

    currentUri() {
      return this.state && this.state.uri;
    },
    progress() {
      const s = this.state;
      if (!s) return 0;
      return s.playing ? s.progress + (Date.now() - this.fetchedAt) : s.progress;
    },
    isPlaying() {
      return !!(this.state && this.state.playing);
    },
    fresh() {
      return Date.now() - this.fetchedAt < 3000;
    },
    deviceQuery() {
      const id = (this.state && this.state.device && this.state.device.id) || this.chosenDevice;
      return id ? `?device_id=${encodeURIComponent(id)}` : "";
    },

    async poll() {
      if (this.polling) return this.polling;
      this.polling = (async () => {
        try {
          const t0 = Date.now();
          const d = await api("GET", "/me/player?additional_types=episode");
          const t1 = Date.now();
          // A reply that was in flight while we sent a command describes the old state: ignore it.
          if (t0 < this.lastCommandAt) return;
          // The position was measured somewhere between sending and receiving.
          this.fetchedAt = Math.round((t0 + t1) / 2);
          this.state =
            d && d.item
              ? {
                  uri: d.item.uri,
                  name: d.item.name,
                  artist: (d.item.artists || []).map((a) => a.name).join(", "),
                  duration: d.item.duration_ms,
                  art: trackArt(d.item),
                  bigArt: bigArt((d.item.album && d.item.album.images) || d.item.images),
                  progress: d.progress_ms || 0,
                  playing: d.is_playing,
                  device: d.device,
                }
              : null;
          if (this.state && this.state.device) this.chosenDevice = this.state.device.id;
          this.lastError = null;
        } catch (e) {
          this.lastError = e.message;
        } finally {
          this.polling = null;
        }
      })();
      return this.polling;
    },
    pollSoon() {
      setTimeout(() => this.poll(), 350);
    },

    // Commands run one at a time, in order, so e.g. "pause" never overtakes "restore volume".
    queue: Promise.resolve(),
    lastCommandAt: 0,
    rtt: 400,
    // How early to send a command so it lands on time.
    get leadMs() {
      return Math.max(150, Math.min(1500, Math.round(this.rtt * 0.6 + 80)));
    },
    command(method, path, body) {
      this.lastCommandAt = Date.now();
      this.queue = this.queue
        .then(async () => {
          const t0 = Date.now();
          await api(method, path, body);
          this.rtt = this.rtt * 0.7 + (Date.now() - t0) * 0.3;
          this.lastCommandAt = Date.now();
        })
        .catch((e) => {
          if (e.reason === "NO_ACTIVE_DEVICE" || e.status === 404) toast("Spotify isn't open on any device. Open Spotify, then try again.", true);
          else if (e.reason !== "VOLUME_CONTROL_DISALLOW") toast(e.message, true);
        })
        .finally(() => this.pollSoon());
      return this.queue;
    },

    play(uri, start, upcoming) {
      const uris = [uri, ...(upcoming || [])].slice(0, 100);
      return this.command("PUT", `/me/player/play${this.deviceQuery()}`, { uris, position_ms: Math.round(start || 0) });
    },
    seek(ms) {
      if (this.state) {
        this.state.progress = ms;
        this.fetchedAt = Date.now();
      }
      this.command("PUT", `/me/player/seek?position_ms=${Math.round(ms)}${this.deviceQuery().replace("?", "&")}`);
    },
    next() {
      this.command("POST", `/me/player/next${this.deviceQuery()}`);
    },
    pause() {
      if (this.state) this.state.playing = false;
      this.command("PUT", `/me/player/pause${this.deviceQuery()}`);
    },
    togglePlay() {
      if (this.isPlaying()) return this.pause();
      if (this.state) {
        this.state.playing = true;
        this.fetchedAt = Date.now();
      }
      this.command("PUT", `/me/player/play${this.deviceQuery()}`);
    },
    // iPhones don't allow remote volume control, so fades only work on devices that do.
    getVolume() {
      const d = this.state && this.state.device;
      return d && d.supports_volume && d.volume_percent != null ? d.volume_percent / 100 : null;
    },
    setVolume(v) {
      this.pendingVolume = Math.round(Math.max(0, Math.min(1, v)) * 100);
      if (this.volumeTimer) return;
      this.volumeTimer = setTimeout(() => {
        this.volumeTimer = null;
        this.command("PUT", `/me/player/volume?volume_percent=${this.pendingVolume}${this.deviceQuery().replace("?", "&")}`);
      }, 400);
    },
  };

  async function getTrack(uri) {
    const [, type, id] = uri.split(":");
    const t = await api("GET", `/${type === "episode" ? "episodes" : "tracks"}/${id}`);
    return { uri, name: t.name, artist: (t.artists || []).map((a) => a.name).join(", "), duration: t.duration_ms, art: trackArt(t) };
  }

  const playlistMeta = {};
  async function getPlaylistMeta(uri) {
    const cached = (playlistsCache || []).find((p) => p.uri === uri);
    if (cached) return cached;
    if (!playlistMeta[uri]) {
      playlistMeta[uri] = api("GET", `/playlists/${uri.split(":").pop()}?fields=name,images`)
        .then((p) => ({ uri, name: p.name, art: smallArt(p.images) }))
        .catch(() => ({ uri, name: "Pasted playlist", art: null }));
    }
    return playlistMeta[uri];
  }

  // ----- DOM helpers -----------------------------------------------------------
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

  const { ICONS } = window.PlaylistPlusCore;
  function icon(name) {
    const d = ICONS[name];
    const filled = typeof d === "object";
    const wrap = document.createElement("div");
    wrap.innerHTML = filled
      ? `<svg class="i" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${d.fill}</svg>`
      : `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    return wrap.firstChild;
  }

  function art(url, size, extra = {}) {
    const el = h("div", { className: "art" + (extra.className ? " " + extra.className : ""), style: size ? `width:${size}px;height:${size}px` : null }, url ? null : icon("note"));
    if (url) el.style.backgroundImage = `url("${url.replace(/"/g, "%22")}")`;
    return el;
  }

  const setHero = (color) => document.documentElement.style.setProperty("--hero", color);
  const setMini = (color) => document.documentElement.style.setProperty("--mini", color);

  function toggle(checked, onChange) {
    return h("label", { className: "switch" }, h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.target.checked) }), h("span"));
  }

  let toastEl = null;
  function toast(msg, isError) {
    if (!toastEl) {
      toastEl = h("div", { id: "toast", role: "status" });
      document.body.append(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = isError ? "error" : "";
    requestAnimationFrame(() => toastEl.classList.add("show"));
    clearTimeout(toast.t);
    toast.t = setTimeout(() => toastEl.classList.remove("show"), 3200);
  }

  // Bottom sheet. Returns a close() function.
  function openSheet(content, { onClose } = {}) {
    const backdrop = h("div", { className: "sheet-backdrop" });
    const sheet = h("div", { className: "sheet", role: "dialog" }, h("div", { className: "sheet-handle" }), content);
    const wrap = h("div", { className: "sheet-wrap" }, backdrop, sheet);
    document.body.append(wrap);
    document.body.classList.add("locked");
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add("open")));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      wrap.classList.remove("open");
      setTimeout(() => {
        wrap.remove();
        if (!document.querySelector(".sheet-wrap")) document.body.classList.remove("locked");
      }, 300);
      if (onClose) onClose();
    };
    backdrop.addEventListener("click", close);
    return close;
  }

  function actionSheet(title, actions) {
    const close = openSheet(h("div", null,
      title && h("h3", null, title),
      actions.filter(Boolean).map((a) =>
        h("button", { className: "action" + (a.danger ? " danger" : ""), onClick: () => (close(), a.run()) }, icon(a.icon), a.label),
      ),
    ));
  }

  function promptSheet(title, value, okLabel = "Save") {
    return new Promise((resolve) => {
      const input = h("input", { className: "field", value, autocomplete: "off" });
      let result = null;
      const close = openSheet(h("div", null,
        h("h3", null, title),
        input,
        h("div", { className: "spacer" }),
        h("button", { className: "btn block", onClick: () => {
          result = input.value.trim() || null;
          close();
        } }, okLabel),
      ), { onClose: () => resolve(result) });
      setTimeout(() => input.focus(), 320);
    });
  }

  function confirmSheet(title, message, okLabel) {
    return new Promise((resolve) => {
      let ok = false;
      const close = openSheet(h("div", null,
        h("h3", null, title),
        message && h("p", { className: "sub" }, message),
        h("div", { className: "spacer" }),
        h("button", { className: "btn block", onClick: () => ((ok = true), close()) }, okLabel),
        h("div", { className: "spacer" }),
        h("button", { className: "btn outline block", onClick: () => close() }, "Cancel"),
      ), { onClose: () => resolve(ok) });
    });
  }

  // ----- screens ---------------------------------------------------------------
  const app = document.getElementById("app");
  let tab = "session";
  let fatal = null;
  const main = h("main", { id: "main" });
  const mini = h("div", { id: "mini" });
  const nav = h("nav");
  const dock = h("div", { id: "dock" }, mini, nav);
  const TABS = [
    ["session", "Session", "timer"],
    ["trims", "Trims", "scissors"],
    ["settings", "Settings", "sliders"],
  ];

  function render() {
    if (!clientId) {
      setHero("#1e3264");
      return fill(app, setupScreen());
    }
    if (!auth) {
      setHero("#1e3264");
      return fill(app, loginScreen());
    }
    fill(nav, TABS.map(([id, label, ic]) =>
      h("button", { className: tab === id ? "on" : "", onClick: () => {
        if (tab === id) return window.scrollTo({ top: 0, behavior: "smooth" });
        tab = id;
        render();
        window.scrollTo({ top: 0 });
      } }, icon(ic), label),
    ));
    fill(app, main, dock);
    renderTab();
  }

  function renderTab() {
    live.key = null;
    fill(main, tab === "session" ? sessionTab() : tab === "trims" ? trimsTab() : settingsTab());
    main.style.animation = "none";
    void main.offsetWidth;
    main.style.animation = "";
    updateLive();
  }

  function setupScreen() {
    const input = h("input", { className: "field", placeholder: "Paste your Client ID", autocapitalize: "off", autocomplete: "off", spellcheck: "false" });
    const step = (n, ...content) => h("div", { className: "step" }, h("span", { className: "n" }, n), h("div", null, ...content));
    return h("div", { className: "welcome" },
      h("img", { className: "logo", src: "icon-180.png", alt: "" }),
      h("h1", null, "Playlist Plus"),
      h("p", { className: "sub" }, "One-time setup, about 3 minutes. Spotify asks every app to have its own free key. Easiest on a computer."),
      fatal && h("div", { className: "err" }, fatal),
      h("div", { className: "steps" },
        step(1, "Open ", h("a", { href: "https://developer.spotify.com/dashboard", target: "_blank", rel: "noopener" }, "developer.spotify.com/dashboard"), " and log in."),
        step(2, "Tap ", h("b", null, "Create app"), ". Any name and description will do."),
        step(3, "Add this ", h("b", null, "Redirect URI"), ":", h("br"), h("code", null, redirectUri())),
        step(4, "Tick ", h("b", null, "Web API"), " and save."),
        step(5, "Copy the app's ", h("b", null, "Client ID"), " and paste it below."),
      ),
      input,
      h("div", { className: "spacer" }),
      h("button", { className: "btn block", onClick: () => {
        const v = input.value.trim();
        if (!/^[0-9a-f]{32}$/i.test(v)) return toast("A Client ID is 32 letters and numbers.", true);
        clientId = v;
        save(KEY.clientId, v);
        render();
      } }, "Continue"),
    );
  }

  function loginScreen() {
    return h("div", { className: "welcome" },
      h("img", { className: "logo", src: "icon-180.png", alt: "" }),
      h("h1", null, "Trim songs.", h("br"), "Time your playlists."),
      h("p", { className: "sub" }, "Playlist Plus controls the Spotify app on your phone. Spotify Premium required."),
      fatal && h("div", { className: "err" }, fatal),
      h("div", { className: "spacer" }),
      h("div", { className: "spacer" }),
      h("button", { className: "btn block", onClick: login }, "Continue with Spotify"),
      h("div", { className: "spacer" }),
      h("button", { className: "btn danger small", style: "color:var(--sub)", onClick: () => {
        clientId = "";
        localStorage.removeItem(KEY.clientId);
        render();
      } }, "Use a different Client ID"),
    );
  }

  // ----- live parts: mini player + running session --------------------------------
  // Rebuilt when the song or phase changes; numbers and bars update in place.
  const live = { key: null, refs: {} };

  function updateLive() {
    if (!auth || !app.contains(main)) return;
    const s = player.state;
    const st = runner && runner.status();
    const showRunning = tab === "session" && st;

    // Mini player (hidden on the running-session screen, which shows the same thing big).
    const miniKey = showRunning ? "hidden" : s ? `${s.uri}|${s.playing}|${s.device && s.device.name}` : `none|${player.lastError || ""}|${player.fetchedAt > 0}`;
    if (mini.dataset.key !== miniKey) {
      mini.dataset.key = miniKey;
      mini.style.display = showRunning ? "none" : "";
      if (s) {
        fill(mini,
          art(s.art, 40),
          h("div", { className: "grow" },
            h("div", { className: "t ellipsis" }, s.name),
            s.device ? h("div", { className: "s dev ellipsis" }, icon(s.device.type === "Computer" ? "computer" : s.device.type === "Smartphone" ? "phone" : "speaker"), s.device.name) : h("div", { className: "s ellipsis" }, s.artist),
          ),
          trims[s.uri] && h("span", { className: "green", title: "Trimmed" }, icon("scissors")),
          h("button", { className: "icon-btn", "aria-label": s.playing ? "Pause" : "Play", onClick: () => (player.togglePlay(), setTimeout(updateLive, 50)) }, icon(s.playing ? "pause" : "play")),
          h("button", { className: "icon-btn", "aria-label": "Next", onClick: () => (runner && runner.active ? runner.skipTrack() : player.next()) }, icon("next")),
          h("div", { className: "prog" }, h("i")),
        );
      } else {
        fill(mini,
          art(null, 40),
          h("div", { className: "grow" },
            h("div", { className: "t ellipsis" }, player.fetchedAt || player.lastError ? "Nothing playing" : "Connecting to Spotify…"),
            h("div", { className: "s ellipsis" }, player.lastError ? player.lastError : "Open Spotify and play any song"),
          ),
        );
      }
    }
    setMini(st ? phaseColor(st.phaseIdx) : "#535353");
    const bar = mini.querySelector(".prog i");
    if (bar && s && s.duration) bar.style.width = `${Math.min(100, (player.progress() / s.duration) * 100)}%`;

    if (showRunning) updateRunning(st, s);
    if (live.nowCard && live.nowCard.isConnected) {
      const k = s ? s.uri : "";
      if (live.nowCard.dataset.key !== k) {
        live.nowCard.dataset.key = k;
        drawNowCard(live.nowCard, s);
      }
    }
  }

  function drawNowCard(el, s) {
    fill(el,
      art(s && s.art, 56),
      h("div", { className: "grow" },
        h("div", { className: "tiny", style: "font-weight:700;text-transform:uppercase;letter-spacing:.08em" }, "Now playing"),
        h("div", { className: "ellipsis", style: "font-weight:800" }, s ? s.name : "Nothing playing"),
        h("div", { className: "sub ellipsis" }, s ? s.artist : "Play a song in Spotify to trim it"),
      ),
      s && h("button", { className: "btn small", onClick: () => openTrimSheet({ uri: s.uri, name: s.name, artist: s.artist, duration: s.duration, art: s.art }) }, icon("scissors"), "Trim"),
    );
  }

  // ----- timed session tab -------------------------------------------------------
  function sessionTab() {
    if (runner && runner.active) {
      live.root = h("div");
      return live.root;
    }
    let tpl = templates.find((t) => t.id === activeTemplateId) || templates[0];
    activeTemplateId = tpl.id;
    const root = h("div");
    // Call after editing tpl; selecting a template only needs saveActiveTemplate().
    const persist = () => (store.touchTemplate(tpl), saveActiveTemplate());
    const smooth = () => tpl.transitions !== "exact";
    const err = h("div", { className: "err" });
    const timeline = h("div");
    let busy = false;

    const updateTimeline = () => {
      setHero(phaseColor(0));
      let budgets;
      try {
        budgets = computeBudgets(Number(tpl.totalMin) * 60000, tpl.phases);
        err.textContent = "";
      } catch (e) {
        fill(timeline);
        err.textContent = e.message;
        return;
      }
      fill(timeline,
        h("div", { className: "timeline" }, tpl.phases.map((ph, i) => h("div", { style: `--c:${phaseColor(i)};flex:${Math.max(budgets[i], 1)}` }, h("i")))),
        h("div", { className: "legend" }, tpl.phases.map((ph, i) => h("span", { style: `--c:${phaseColor(i)}` }, `${ph.name} ${formatTime(budgets[i])}`))),
      );
    };

    const draw = () => {
      const totalPct = ((tpl.totalMin - 5) / (180 - 5)) * 100;
      const lengthLabel = h("span", { className: "tnum" }, `${tpl.totalMin} min`);
      const lengthRange = h("input", {
        type: "range", min: "5", max: "180", step: "1", value: tpl.totalMin, style: `--pct:${totalPct}%`, "aria-label": "Session length",
        onInput: (e) => {
          tpl.totalMin = Number(e.target.value);
          e.target.style.setProperty("--pct", `${((tpl.totalMin - 5) / 175) * 100}%`);
          lengthLabel.textContent = `${tpl.totalMin} min`;
          updateTimeline();
        },
        onChange: persist,
      });

      fill(root,
        h("div", { className: "eyebrow" }, "Timed session"),
        h("div", { className: "row" },
          h("h1", { className: "grow ellipsis" }, tpl.name),
          h("button", { className: "icon-btn", "aria-label": "Session options", onClick: () => actionSheet(tpl.name, [
            { icon: "edit", label: "Rename", run: async () => {
              const name = await promptSheet("Rename session", tpl.name);
              if (name) (tpl.name = name), persist(), draw();
            } },
            { icon: "copy", label: "Duplicate", run: () => {
              const copy = { ...JSON.parse(JSON.stringify(tpl)), id: String(Date.now()), name: `${tpl.name} (copy)` };
              store.addTemplate(copy);
              activeTemplateId = copy.id;
              tpl = copy;
              saveActiveTemplate();
              draw();
            } },
            templates.length > 1 && { icon: "trash", label: "Delete", danger: true, run: async () => {
              if (!(await confirmSheet(`Delete “${tpl.name}”?`, "This can't be undone.", "Delete"))) return;
              store.removeTemplate(tpl);
              tpl = templates[0];
              activeTemplateId = tpl.id;
              saveActiveTemplate();
              draw();
            } },
          ]) }, icon("more")),
        ),
        h("div", { className: "sub" }, `${tpl.phases.length} phase${tpl.phases.length === 1 ? "" : "s"} · `, lengthLabel),

        // Play row, like a Spotify playlist header.
        h("div", { className: "row", style: "margin-top:18px" },
          h("button", { className: "icon-btn" + (tpl.shuffle ? " on" : ""), "aria-label": "Shuffle", title: "Shuffle within phases", onClick: () => ((tpl.shuffle = !tpl.shuffle), persist(), draw(), toast(tpl.shuffle ? "Shuffle on" : "Shuffle off")) }, icon("shuffle")),
          h("button", { className: "icon-btn" + (tpl.smartFit ? " on" : ""), "aria-label": "Smart fit", title: "Smart fit", onClick: () => ((tpl.smartFit = !tpl.smartFit), persist(), draw(), toast(tpl.smartFit ? "Smart fit on: prefers songs that end before the phase does" : "Smart fit off")) }, icon("fit")),
          h("button", { className: "icon-btn", "aria-label": "Preview plan", title: "Preview plan", onClick: () => run(true) }, icon("list")),
          h("div", { className: "grow" }),
          h("button", { className: "play-fab", "aria-label": "Start session", onClick: () => run(false) }, icon("play")),
        ),

        h("div", { className: "chips" },
          templates.map((t) => h("button", { className: "chip" + (t === tpl ? " on" : ""), onClick: () => {
            activeTemplateId = t.id;
            tpl = t;
            saveActiveTemplate();
            draw();
          } }, t.name)),
          h("button", { className: "chip", "aria-label": "New session", onClick: () => {
            const t = { ...defaultTemplate(String(Date.now())), name: "New session" };
            store.addTemplate(t);
            activeTemplateId = t.id;
            tpl = t;
            saveActiveTemplate();
            draw();
          } }, icon("plus"), "New"),
        ),

        resumeCard(),

        h("h2", null, "Length"),
        h("div", { className: "card" },
          lengthRange,
          timeline,
        ),
        err,

        h("h2", null, "Transitions"),
        h("div", { className: "card" },
          h("div", { className: "seg wide" },
            h("button", { className: smooth() ? "on" : "", onClick: () => ((tpl.transitions = "smooth"), persist(), draw()) }, "Smooth"),
            h("button", { className: smooth() ? "" : "on", onClick: () => ((tpl.transitions = "exact"), persist(), draw()) }, "Exact"),
          ),
          smooth()
            ? h("div", { className: "feature-list" },
                h("div", null, icon("check"), "Phases change between songs, close to your timing; the session as a whole ends on time"),
                h("div", null, icon("check"), "No song gets cut, so Spotify's crossfade (if on) blends every change"),
                h("div", null, icon("check"), "Plays on its own: lock your phone any time"),
              )
            : h("div", { className: "feature-list" },
                h("div", null, icon("timer"), "Phases change exactly on the minute"),
                h("div", { className: "warn" }, icon("info"), "The song playing at a phase change gets cut (iPhones can't fade it)"),
                h("div", { className: "warn" }, icon("info"), "Keep Playlist Plus open for the cuts to happen on time"),
              ),
        ),

        h("h2", null, "Phases"),
        tpl.phases.map((ph, i) => phaseCard(ph, i)),
        h("button", { className: "add-phase", onClick: () => {
          tpl.phases.push({ name: `Phase ${tpl.phases.length + 1}`, playlistUri: "", mode: "minutes", value: 5 });
          persist();
          draw();
        } }, icon("plus"), "Add phase"),
        h("p", { className: "tiny", style: "margin-top:14px" }, "Phases play in order. “Rest” phases share the time the others don't use; without one, leftover time goes to the last phase."),
      );
      updateTimeline();
    };

    function phaseCard(ph, i) {
      const picker = h("button", { className: "picker", onClick: async () => {
        const uri = await pickPlaylist(ph.name);
        if (uri) (ph.playlistUri = uri), persist(), draw();
      } });
      const drawPicker = (meta) =>
        fill(picker,
          art(meta && meta.art, 44),
          h("div", { className: "grow" },
            h("div", { className: "ellipsis", style: "font-weight:700" }, meta ? meta.name : "Choose a playlist"),
            h("div", { className: "tiny" }, meta ? (meta.total != null ? `${meta.total} songs` : "Playlist") : "Tap to pick from your library"),
          ),
          icon("chevronRight"),
        );
      drawPicker(null);
      if (ph.playlistUri) {
        fill(picker.children[1].firstChild, "Loading…");
        getPlaylistMeta(ph.playlistUri).then(drawPicker);
      }

      const setMode = (m) => () => {
        ph.mode = m;
        if (m === "percent" && !(ph.value > 0 && ph.value <= 100)) ph.value = 20;
        persist();
        draw();
      };
      const valueIn = h("input", {
        type: "number", inputmode: "decimal", min: "0", value: ph.value, "aria-label": "Amount",
        onChange: (e) => ((ph.value = Math.max(0, Number(e.target.value) || 0)), persist(), updateTimeline()),
      });
      const step = (d) => () => {
        ph.value = Math.max(0, (Number(ph.value) || 0) + d * (ph.mode === "percent" ? 5 : 1));
        valueIn.value = ph.value;
        persist();
        updateTimeline();
      };

      return h("div", { className: "phase", style: `--c:${phaseColor(i)}` },
        h("div", { className: "row" },
          h("input", { className: "name-input grow", value: ph.name, "aria-label": "Phase name", onChange: (e) => ((ph.name = e.target.value || `Phase ${i + 1}`), persist(), updateTimeline()) }),
          h("button", { className: "icon-btn", "aria-label": "Phase options", onClick: () => actionSheet(ph.name, [
            i > 0 && { icon: "up", label: "Move up", run: () => {
              [tpl.phases[i - 1], tpl.phases[i]] = [tpl.phases[i], tpl.phases[i - 1]];
              persist();
              draw();
            } },
            i < tpl.phases.length - 1 && { icon: "down", label: "Move down", run: () => {
              [tpl.phases[i + 1], tpl.phases[i]] = [tpl.phases[i], tpl.phases[i + 1]];
              persist();
              draw();
            } },
            { icon: "trash", label: "Remove phase", danger: true, run: () => {
              tpl.phases.splice(i, 1);
              persist();
              draw();
            } },
          ]) }, icon("more")),
        ),
        picker,
        h("div", { className: "row", style: "flex-wrap:wrap;gap:8px" },
          h("div", { className: "seg" },
            h("button", { className: ph.mode === "minutes" ? "on" : "", onClick: setMode("minutes") }, "Minutes"),
            h("button", { className: ph.mode === "percent" ? "on" : "", onClick: setMode("percent") }, "Percent"),
            h("button", { className: ph.mode === "rest" ? "on" : "", onClick: setMode("rest") }, "Rest"),
          ),
          ph.mode !== "rest" &&
            h("div", { className: "stepper" },
              h("button", { "aria-label": "Less", onClick: step(-1) }, icon("minus")),
              valueIn,
              h("span", { className: "unit" }, ph.mode === "percent" ? "%" : "min"),
              h("button", { "aria-label": "More", onClick: step(1) }, icon("plus")),
            ),
        ),
      );
    }

    async function buildPlan() {
      const budgets = computeBudgets(Number(tpl.totalMin) * 60000, tpl.phases);
      const defs = [];
      for (let i = 0; i < tpl.phases.length; i++) {
        const ph = tpl.phases[i];
        if (budgets[i] <= 0) continue;
        if (!ph.playlistUri) throw new Error(`Choose a playlist for “${ph.name}”.`);
        let pool;
        try {
          pool = await loadPlaylistTracks(ph.playlistUri);
        } catch (e) {
          throw new Error(`${ph.name}: ${e.message}`);
        }
        if (!pool.length) throw new Error(`The playlist for “${ph.name}” has no playable songs.`);
        defs.push({ name: ph.name, color: phaseColor(i), pool, budget: budgets[i] });
      }
      if (!defs.length) throw new Error("No phase has any time assigned.");
      const phases = planSession(defs, {
        mode: smooth() ? "smooth" : "exact",
        shuffle: tpl.shuffle,
        smartFit: tpl.smartFit,
        trims: settings.trimsInSessions ? trims : {},
      });
      phases.mode = smooth() ? "smooth" : "exact";
      phases.title = tpl.name;
      return phases;
    }

    async function run(previewOnly) {
      if (busy) return;
      busy = true;
      err.textContent = "";
      try {
        const phases = await buildPlan();
        if (previewOnly) showPlan(phases);
        else startSession(phases);
      } catch (e) {
        err.textContent = e.message;
        toast(e.message, true);
      } finally {
        busy = false;
      }
    }

    function showPlan(phases) {
      const total = phases.reduce((a, p) => a + p.budget, 0);
      const trimmed = phases.reduce((a, p) => a + p.items.filter((i) => i.length < i.duration).length, 0);
      const note = (ic, text, cls = "") => h("div", { className: `note ${cls}` }, icon(ic), h("div", null, text));
      const close = openSheet(h("div", null,
        h("h3", null, `${tpl.name} · ${formatTime(total)}`),
        smooth()
          ? trimmed
            ? note("scissors", `${trimmed} trimmed song${trimmed === 1 ? "" : "s"}: keep Playlist Plus open so they're trimmed. If your phone locks, they play in full and the session carries on.`)
            : note("check", "Every change happens between songs, so Spotify plays this on its own. Lock your phone any time.", "good")
          : note("info", "Exact timing cuts songs at phase changes. Keep Playlist Plus open during the session."),
        smooth() && !settings.crossfadeSeconds && note("info", "Tip: turn on Crossfade in Spotify (Settings → Playback), then set the same value in Playlist Plus Settings, for seamless fades between songs."),
        phases.map((ph) => {
          let t = 0;
          const rows = [];
          for (const it of ph.items) {
            if (t >= ph.budget) break;
            const plays = Math.min(it.length, ph.budget - t);
            const cut = plays < it.length;
            rows.push(h("div", { className: "item" },
              art(it.art, 44),
              h("div", { className: "grow" },
                h("div", { className: "t ellipsis" }, it.name),
                h("div", { className: "s ellipsis" }, it.length < it.duration && h("span", { className: "green" }, icon("scissors")), it.artist),
              ),
              h("div", { className: "end tnum" + (cut ? " green" : "") }, cut ? `${formatTime(plays)} ✂` : formatTime(plays)),
            ));
            t += it.length;
          }
          return h("div", { style: "margin-bottom:16px" },
            h("div", { className: "row", style: `--c:${ph.color}` },
              h("span", { style: `width:10px;height:10px;border-radius:50%;background:${ph.color}` }),
              h("b", { className: "grow" }, ph.name),
              h("span", { className: "sub tnum" }, formatTime(ph.budget), smooth() && Math.abs(ph.budget - ph.target) >= 1000 ? h("span", { className: "tiny" }, ` (${ph.budget > ph.target ? "+" : "−"}${formatTime(Math.abs(ph.budget - ph.target))})`) : null),
            ),
            h("div", { className: "list" }, rows),
          );
        }),
        h("div", { style: "position:sticky;bottom:calc(-20px - var(--safe-b));margin:0 -16px calc(-20px - var(--safe-b));padding:28px 16px calc(20px + var(--safe-b));background:linear-gradient(rgba(36,36,36,0),#242424 40%)" },
          h("button", { className: "btn block", onClick: () => (close(), startSession(phases)) }, icon("play"), "Start this plan"),
        ),
      ));
    }

    draw();
    if (!playlistsCache) listPlaylists().catch(() => {});
    return root;
  }

  function pickPlaylist(phaseName) {
    return new Promise((resolve) => {
      let result = null;
      const listEl = h("div", { className: "list" }, h("div", { className: "empty" }, "Loading your playlists…"));
      const search = h("input", { className: "field", placeholder: "Search your playlists", autocomplete: "off", onInput: () => draw() });
      const link = h("input", { className: "field", placeholder: "Paste a playlist link", autocapitalize: "off", autocomplete: "off" });
      let all = [];
      const draw = () => {
        const q = search.value.trim().toLowerCase();
        const shown = all.filter((p) => p.readable && p.name.toLowerCase().includes(q));
        fill(listEl, shown.length
          ? shown.map((p) => h("button", { className: "item", onClick: () => ((result = p.uri), close()) },
              art(p.art, 52),
              h("div", { className: "grow" }, h("div", { className: "t ellipsis" }, p.name), h("div", { className: "s" }, `Playlist${p.total != null ? ` · ${p.total} songs` : ""}`)),
            ))
          : h("div", { className: "empty" }, icon("search"), q ? "No playlists match." : "No playlists of your own yet."));
      };
      const close = openSheet(h("div", null,
        h("h3", null, `Playlist for ${phaseName}`),
        h("div", { className: "search" }, icon("search"), search),
        h("div", { className: "spacer" }),
        listEl,
        h("p", { className: "tiny" }, "Only playlists you created or collaborate on are shown: Spotify doesn't let apps read other playlists. To use one, add its songs to a playlist of your own."),
        h("div", { className: "row" },
          h("div", { className: "grow" }, link),
          h("button", { className: "btn small", onClick: () => {
            const uri = normalizePlaylistUri(link.value);
            if (!uri) return toast("That doesn't look like a playlist link.", true);
            result = uri;
            close();
          } }, "Use"),
        ),
      ), { onClose: () => resolve(result) });
      listPlaylists()
        .then((p) => ((all = p), draw()))
        .catch((e) => fill(listEl, h("div", { className: "err" }, `Couldn't load your playlists: ${e.message}`)));
    });
  }

  // Running session: big countdown, phase progress, now playing and controls.
  function updateRunning(st, s) {
    const root = live.root;
    if (!root || !root.isConnected) return;
    const item = st.item;
    const nowUri = s ? s.uri : item.uri;
    const key = `${st.phaseIdx}|${runner.itemIdx}|${nowUri}|${s && s.playing}`;
    const color = runner.phases[st.phaseIdx].color || phaseColor(st.phaseIdx);
    setHero(color);
    if (live.key !== key) {
      live.key = key;
      const playing = s && s.uri === item.uri ? s : null;
      const r = (live.refs = {});
      const segs = runner.phases.map((p, i) => {
        const fillEl = h("i");
        r[`seg${i}`] = fillEl;
        return h("div", { style: `--c:${p.color || phaseColor(i)};flex:${p.budget}` }, fillEl);
      });
      const upcoming = [];
      for (let pi = runner.phaseIdx, ii = runner.itemIdx + 1; pi < runner.phases.length && upcoming.length < 3; ii++) {
        if (ii >= runner.phases[pi].items.length) {
          pi++;
          ii = -1;
          continue;
        }
        upcoming.push({ ...runner.phases[pi].items[ii], phase: runner.phases[pi] });
      }
      // Warm the image cache so the next song's artwork appears instantly.
      upcoming.forEach((u) => u.art && (new Image().src = u.art));
      const nextPhase = runner.phases[st.phaseIdx + 1];
      fill(root,
        h("div", { className: "eyebrow" }, `Phase ${st.phaseIdx + 1} of ${st.phaseCount}`),
        h("h1", null, st.phaseName),
        h("div", { className: "row", style: "align-items:flex-end;margin-top:14px" },
          (r.countdown = h("div", { className: "countdown tnum" })),
        ),
        (r.sub = h("div", { className: "sub", style: "margin-top:6px" })),
        h("div", { className: "timeline big" }, segs),
        art((playing && playing.bigArt) || item.art, null, { className: "big-art" }),
        h("div", { className: "row", style: "margin-top:20px" },
          art((playing && playing.art) || item.art, 56, { className: "small-art" }),
          h("div", { className: "grow" },
            h("div", { className: "ellipsis", style: "font-size:22px;font-weight:800;letter-spacing:-.02em" }, (playing && playing.name) || item.name),
            h("div", { className: "sub ellipsis" }, (playing && playing.artist) || item.artist),
          ),
          item.length < item.duration && h("span", { className: "green", title: "Trimmed" }, icon("scissors")),
        ),
        h("div", { className: "songbar" }, (r.songFill = h("i"))),
        (r.times = h("div", { className: "row tiny tnum", style: "justify-content:space-between;margin-top:-4px" }, h("span"), h("span"))),
        h("div", { className: "controls" },
          h("button", { className: "icon-btn", "aria-label": "Stop session", onClick: () => stopSession(true) }, icon("stop")),
          h("div", { style: "width:48px" }),
          h("button", { className: "main-btn", "aria-label": s && s.playing ? "Pause" : "Play", onClick: () => (player.togglePlay(), setTimeout(updateLive, 50)) }, icon(s && s.playing ? "pause" : "play")),
          h("button", { className: "icon-btn", "aria-label": "Next song", onClick: () => runner.skipTrack() }, icon("next")),
          h("button", { className: "icon-btn", "aria-label": "Next phase", disabled: !nextPhase, onClick: () => runner.skipPhase() }, icon("forward")),
        ),
        nextPhase && h("div", { style: "text-align:center;margin-top:4px" }, (r.nextLabel = h("span", { className: "tiny tnum" }))),
        upcoming.length > 0 && h("h2", null, "Next in queue"),
        h("div", { className: "list" }, upcoming.map((u) =>
          h("div", { className: "item" },
            art(u.art, 48),
            h("div", { className: "grow" },
              h("div", { className: "t ellipsis" }, u.name),
              h("div", { className: "s ellipsis" }, u.phase !== runner.phase && h("span", { style: `color:${u.phase.color}` }, `${u.phase.name} · `), u.artist),
            ),
            h("div", { className: "end tnum" }, formatTime(u.length)),
          ),
        )),
      );
    }
    const r = live.refs;
    r.countdown.textContent = formatTime(st.phaseLeft);
    r.sub.textContent = `left in ${st.phaseName} · ${formatTime(st.totalLeft)} left in session`;
    if (r.nextLabel) {
      const np = runner.phases[st.phaseIdx + 1];
      const lastSong = runner.opts.smooth && runner.itemIdx === runner.phase.items.length - 1;
      r.nextLabel.textContent = lastSong ? `${np.name} starts after this song` : `Next: ${np.name} in ${formatTime(st.phaseLeft)}`;
    }
    runner.phases.forEach((p, i) => {
      const pct = i < st.phaseIdx ? 100 : i > st.phaseIdx ? 0 : Math.min(100, ((p.budget - st.phaseLeft) / p.budget) * 100);
      r[`seg${i}`].style.setProperty("--p", `${pct}%`);
    });
    // Song progress within the kept (trimmed) part.
    const pos = s && s.uri === item.uri ? player.progress() : item.start;
    const pct = Math.max(0, Math.min(1, (pos - item.start) / Math.max(1, item.end - item.start)));
    r.songFill.style.width = `${pct * 100}%`;
    r.times.children[0].textContent = formatTime(Math.max(0, pos - item.start));
    r.times.children[1].textContent = `-${formatTime(Math.max(0, item.end - pos))}`;
  }

  // ----- trims ----------------------------------------------------------------------
  async function openTrimSheet(track) {
    let t = { ...track };
    if (!t.duration || !t.art) {
      try {
        t = { ...t, ...(await getTrack(t.uri)) };
      } catch {
        /* keep what we have */
      }
    }
    if (!t.duration) return toast("Couldn't load this song from Spotify.", true);
    const dur = t.duration;
    const existing = trims[t.uri] || {};
    let start = existing.start || 0;
    let end = existing.end || dur;
    const isCurrent = () => player.currentUri() === t.uri;

    const BARS = 40;
    const bars = Array.from({ length: BARS }, () => h("i", { style: "height:100%" }));
    const playhead = h("div", { className: "playhead" });
    const rs = h("input", { type: "range", min: "0", max: String(dur), step: "500", value: String(start), "aria-label": "Start" });
    const re = h("input", { type: "range", min: "0", max: String(dur), step: "500", value: String(end), "aria-label": "End" });
    const startIn = h("input", { className: "v tnum", inputmode: "decimal", "aria-label": "Start time" });
    const endIn = h("input", { className: "v tnum", inputmode: "decimal", "aria-label": "End time" });
    const plays = h("div", { className: "v tnum" });
    const err = h("div", { className: "err" });

    const update = () => {
      bars.forEach((b, i) => b.classList.toggle("in", ((i + 0.5) / BARS) * dur >= start && ((i + 0.5) / BARS) * dur <= end));
      rs.value = String(start);
      re.value = String(end);
      if (document.activeElement !== startIn) startIn.value = formatTime(start);
      if (document.activeElement !== endIn) endIn.value = formatTime(end);
      plays.textContent = formatTime(end - start);
      err.textContent = "";
    };
    rs.addEventListener("input", () => ((start = Math.min(Number(rs.value), end - 5000)), update()));
    re.addEventListener("input", () => ((end = Math.max(Number(re.value), start + 5000)), update()));
    const fromField = (input, which) => () => {
      const v = parseTime(input.value);
      if (v == null || Number.isNaN(v)) return update();
      if (which === "start") start = Math.max(0, Math.min(v, end - 5000));
      else end = Math.min(dur, Math.max(v, start + 5000));
      update();
    };
    startIn.addEventListener("change", fromField(startIn, "start"));
    endIn.addEventListener("change", fromField(endIn, "end"));

    const nowChip = (label, which) =>
      h("button", { className: "chip", onClick: () => {
        if (!isCurrent()) return toast("Play this song first, then tap to use its position.", true);
        const p = Math.round(player.progress() / 500) * 500;
        if (which === "start") start = Math.max(0, Math.min(p, end - 5000));
        else end = Math.min(dur, Math.max(p, start + 5000));
        update();
      } }, icon("timer"), label);

    const tickHead = setInterval(() => {
      const show = isCurrent();
      playhead.style.display = show ? "block" : "none";
      if (show) playhead.style.left = `${Math.min(100, (player.progress() / dur) * 100)}%`;
    }, 250);

    const close = openSheet(h("div", null,
      h("div", { className: "row", style: "margin-bottom:6px" },
        art(t.art, 56),
        h("div", { className: "grow" },
          h("div", { className: "ellipsis", style: "font-size:18px;font-weight:800" }, t.name),
          h("div", { className: "sub ellipsis" }, t.artist),
        ),
      ),
      h("div", { className: "stats" },
        h("div", null, startIn, h("div", { className: "k" }, "Start")),
        h("div", null, plays, h("div", { className: "k" }, "Plays")),
        h("div", null, endIn, h("div", { className: "k" }, "End")),
      ),
      h("div", { className: "trim-track" }, h("div", { className: "bars" }, bars), playhead, rs, re),
      h("div", { className: "row tiny tnum", style: "justify-content:space-between" }, h("span", null, "0:00"), h("span", null, formatTime(dur))),
      h("div", { className: "chips", style: "margin-top:12px" },
        nowChip("Start here", "start"),
        nowChip("End here", "end"),
        h("button", { className: "chip", onClick: () => player.play(t.uri, start) }, icon("play"), "From start"),
        h("button", { className: "chip", onClick: () => {
          const at = Math.max(start, end - 5000);
          if (isCurrent()) player.seek(at);
          else player.play(t.uri, at);
        } }, icon("play"), "Hear the end"),
      ),
      err,
      h("div", { className: "spacer" }),
      h("button", { className: "btn block", onClick: () => {
        const full = start === 0 && end >= dur;
        if (full) store.removeTrim(t.uri);
        else store.setTrim(t.uri, { start, end: end >= dur ? null : end, name: t.name, artist: t.artist, art: t.art || null });
        toast(full ? `“${t.name}” plays in full` : `Trimmed “${t.name}”`);
        close();
        if (tab === "trims") renderTab();
      } }, icon("check"), "Save trim"),
      trims[t.uri] && h("div", { style: "text-align:center;margin-top:8px" },
        h("button", { className: "btn danger small", onClick: () => {
          store.removeTrim(t.uri);
          toast(`Removed trim from “${t.name}”`);
          close();
          if (tab === "trims") renderTab();
        } }, "Remove trim"),
      ),
    ), { onClose: () => clearInterval(tickHead) });
    update();
  }

  function trimsTab() {
    setHero("#e8115b");
    const entries = Object.entries(trims).sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));
    const shelf = h("div", { className: "chips", style: "gap:12px" });
    const songs = h("div", { className: "list" });
    let openUri = null;

    const loadShelf = async () => {
      fill(shelf, h("span", { className: "tiny" }, "Loading your playlists…"));
      try {
        const pls = (await listPlaylists()).filter((p) => p.readable);
        if (!pls.length) return fill(shelf, h("span", { className: "tiny" }, "No playlists of your own yet."));
        fill(shelf, pls.map((p) =>
          h("button", { style: "width:120px;flex:none;text-align:left", onClick: async () => {
            if (openUri === p.uri) {
              openUri = null;
              return fill(songs);
            }
            openUri = p.uri;
            fill(songs, h("div", { className: "empty" }, "Loading songs…"));
            try {
              const tracks = await loadPlaylistTracks(p.uri);
              fill(songs, h("h2", { style: "margin-top:16px" }, p.name), tracks.map((tr) => songRow(tr, trims[tr.uri] ? trimLabel(trims[tr.uri]) : formatTime(tr.duration))));
            } catch (e) {
              fill(songs, h("div", { className: "err" }, e.message));
            }
          } },
            art(p.art, 120),
            h("div", { className: "ellipsis", style: "font-size:13px;font-weight:700;margin-top:8px" }, p.name),
            h("div", { className: "tiny" }, p.total != null ? `${p.total} songs` : "Playlist"),
          ),
        ));
      } catch (e) {
        fill(shelf, h("div", { className: "err" }, e.message));
      }
    };

    const trimLabel = (tr) => `${formatTime(tr.start || 0)} – ${tr.end ? formatTime(tr.end) : "end"}`;
    const songRow = (tr, sub, trimmed = !!trims[tr.uri]) =>
      h("button", { className: "item", onClick: () => openTrimSheet(tr) },
        art(tr.art, 48),
        h("div", { className: "grow" },
          h("div", { className: "t ellipsis" }, tr.name),
          h("div", { className: "s ellipsis" + (trimmed ? " green" : "") }, trimmed && icon("scissors"), trimmed ? sub : tr.artist),
        ),
        h("div", { className: "end tnum" }, trimmed ? "" : sub),
        icon("chevronRight"),
      );

    const root = h("div", null,
      h("div", { className: "eyebrow" }, "Your library"),
      h("h1", null, "Trims"),
      h("div", { className: "sub" }, entries.length ? `${entries.length} song${entries.length === 1 ? "" : "s"} trimmed` : "Cut the intro or outro off any song"),
      (live.nowCard = h("div", { className: "card", style: "margin-top:20px;display:flex;align-items:center;gap:12px" })),
      h("h2", null, "Trimmed songs"),
      entries.length
        ? h("div", { className: "list" }, entries.map(([uri, tr]) => songRow({ uri, name: tr.name || uri, artist: tr.artist, art: tr.art, duration: null }, trimLabel(tr), true)))
        : h("div", { className: "empty" }, icon("scissors"), "No trims yet. Trim the song that's playing, or pick one from your playlists below."),
      h("h2", null, "Your playlists"),
      shelf,
      songs,
    );
    loadShelf();
    return root;
  }

  // ----- settings tab -----------------------------------------------------------------
  function settingsTab() {
    setHero("#535353");
    const devBox = h("div", { className: "list" });
    const syncBox = h("div");
    const drawSync = () => {
      if (!syncClient) {
        live.syncRow = null;
        return fill(syncBox, setting("Sync with your other devices", "Keep trims and sessions the same on your phone and computer.", icon("chevronRight"), () => openSyncSetup(drawSync)));
      }
      live.syncRow = h("div");
      drawSyncRow(live.syncRow);
      fill(syncBox, live.syncRow, setting("Stop syncing", "This device keeps its current trims and sessions.", icon("logout"), async () => {
        if (!(await confirmSheet("Stop syncing?", "This device keeps its current copy. Your other devices keep syncing.", "Stop syncing"))) return;
        disconnectSync();
        drawSync();
      }));
    };
    const setting = (title, desc, control, onClick) =>
      h(onClick ? "button" : "div", { className: "setting", onClick },
        h("div", { className: "grow" }, h("div", { className: "t" }, title), desc && h("div", { className: "s" }, desc)),
        control,
      );
    drawSync();
    const switchSetting = (key, title, desc) =>
      setting(title, desc, toggle(settings[key], (v) => ((settings[key] = v), saveSettings())));

    const fadeIn = h("input", { type: "number", inputmode: "numeric", value: settings.fadeSeconds, "aria-label": "Fade seconds", onChange: (e) => {
      settings.fadeSeconds = Math.max(0, Math.min(15, Number(e.target.value) || 0));
      e.target.value = settings.fadeSeconds;
      saveSettings();
    } });
    const xfIn = h("input", { type: "number", inputmode: "numeric", value: settings.crossfadeSeconds, "aria-label": "Spotify crossfade seconds", onChange: (e) => {
      settings.crossfadeSeconds = Math.max(0, Math.min(12, Number(e.target.value) || 0));
      e.target.value = settings.crossfadeSeconds;
      saveSettings();
    } });
    const fadeStep = (d) => () => {
      settings.fadeSeconds = Math.max(0, Math.min(15, settings.fadeSeconds + d));
      fadeIn.value = settings.fadeSeconds;
      saveSettings();
    };

    const deviceIcon = (type) => icon(type === "Computer" ? "computer" : type === "Smartphone" ? "phone" : "speaker");
    const drawDevices = async () => {
      fill(devBox, h("div", { className: "tiny", style: "padding:12px 0" }, "Looking for devices…"));
      try {
        const { devices } = await api("GET", "/me/player/devices");
        fill(devBox,
          devices.length
            ? devices.map((d) =>
                h("button", { className: "item", onClick: async () => {
                  if (d.is_active) return;
                  try {
                    await api("PUT", "/me/player", { device_ids: [d.id], play: false });
                    player.chosenDevice = d.id;
                    toast(`Playing on ${d.name}`);
                    player.pollSoon();
                    setTimeout(drawDevices, 800);
                  } catch (e) {
                    toast(e.message, true);
                  }
                } },
                  h("div", { className: d.is_active ? "green" : "", style: "width:48px;display:grid;place-items:center" }, deviceIcon(d.type)),
                  h("div", { className: "grow" },
                    h("div", { className: "t ellipsis" + (d.is_active ? " green" : "") }, d.name),
                    h("div", { className: "s" }, d.is_active ? "Listening on this device" : d.type),
                  ),
                  d.is_active && h("span", { className: "green" }, icon("check")),
                ),
              )
            : h("div", { className: "empty" }, icon("phone"), "No devices found. Open the Spotify app on your phone, then refresh."),
          h("button", { className: "btn outline small", style: "margin-top:8px", onClick: drawDevices }, "Refresh"),
        );
      } catch (e) {
        fill(devBox, h("div", { className: "err" }, e.message));
      }
    };
    drawDevices();

    const exportTrims = async () => {
      const text = JSON.stringify(trims);
      try {
        if (navigator.share) await navigator.share({ title: "Playlist Plus trims", text });
        else {
          await navigator.clipboard.writeText(text);
          toast("Trims copied to clipboard");
        }
      } catch (e) {
        if (e && e.name === "AbortError") return;
        try {
          await navigator.clipboard.writeText(text);
          toast("Trims copied to clipboard");
        } catch {
          toast("Couldn't share or copy the trims.", true);
        }
      }
    };
    const importTrims = () => {
      const area = h("textarea", { className: "field", placeholder: "Paste exported trims here" });
      const close = openSheet(h("div", null,
        h("h3", null, "Import trims"),
        h("p", { className: "sub" }, "Paste trims exported from the desktop extension or another phone. They're merged with the ones you have."),
        area,
        h("div", { className: "spacer" }),
        h("button", { className: "btn block", onClick: () => {
          try {
            const data = JSON.parse(area.value);
            if (typeof data !== "object" || !data || Array.isArray(data)) throw new Error();
            const n = store.importTrims(data);
            toast(`Imported ${n} trim${n === 1 ? "" : "s"}`);
            close();
          } catch {
            toast("That isn't valid trim data.", true);
          }
        } }, "Import"),
      ));
    };

    return h("div", null,
      h("div", { className: "eyebrow" }, "Playlist Plus"),
      h("h1", null, "Settings"),
      h("h2", null, "Playback"),
      switchSetting("trimsEnabled", "Trim songs while listening", "Applies your trims whenever this app is open."),
      switchSetting("trimsInSessions", "Trim songs in timed sessions", null),
      setting("Crossfade in Spotify", "Set the same value as Spotify → Settings → Playback → Crossfade. Sessions then end cleanly, and trimmed songs hand over at the right moment.",
        h("div", { className: "stepper" },
          h("button", { "aria-label": "Shorter", onClick: () => ((settings.crossfadeSeconds = Math.max(0, settings.crossfadeSeconds - 1)), saveSettings(), (xfIn.value = settings.crossfadeSeconds)) }, icon("minus")),
          xfIn,
          h("span", { className: "unit" }, "s"),
          h("button", { "aria-label": "Longer", onClick: () => ((settings.crossfadeSeconds = Math.min(12, settings.crossfadeSeconds + 1)), saveSettings(), (xfIn.value = settings.crossfadeSeconds)) }, icon("plus")),
        ),
      ),
      setting("Fade out cut songs", "Volume fade before a trim end or an exact phase change. Works when Spotify plays on a computer or speaker; iPhones don't allow it, so use Smooth transitions there.",
        h("div", { className: "stepper" },
          h("button", { "aria-label": "Shorter", onClick: fadeStep(-1) }, icon("minus")),
          fadeIn,
          h("span", { className: "unit" }, "s"),
          h("button", { "aria-label": "Longer", onClick: fadeStep(1) }, icon("plus")),
        ),
      ),
      h("h2", null, "Sync"),
      syncBox,
      h("h2", null, "Devices"),
      devBox,
      h("h2", null, "Backup"),
      setting("Export trims", "Share or copy them, e.g. to the desktop extension.", icon("share"), exportTrims),
      setting("Import trims", "Paste trims from another device.", icon("download"), importTrims),
      h("h2", null, "Account"),
      setting("Log out", null, icon("logout"), logout),
      setting("Change Client ID", "Use a different Spotify developer app.", icon("key"), async () => {
        if (!(await confirmSheet("Change Client ID?", "You'll be logged out and asked for a new Client ID.", "Continue"))) return;
        clientId = "";
        localStorage.removeItem(KEY.clientId);
        logout();
      }),
      h("details", { className: "more", style: "margin-top:16px" },
        h("summary", null, icon("info"), "How it works", icon("chevronDown")),
        h("p", { className: "sub" }, "Playlist Plus remote-controls Spotify through Spotify's official Web API. iOS pauses web apps in the background, so trims and exact phase timing need this app open. The screen stays awake during sessions. If the phone locks, Spotify keeps playing the planned songs in order, and the app catches up when you return."),
      ),
    );
  }

  // ----- sync between devices (private GitHub Gist) --------------------------------------
  const makeSyncClient = () => {
    const token = load(KEY.syncToken, "");
    return token ? createGistClient({ token, gistId: load(KEY.gistId, null) }) : null;
  };
  let syncClient = makeSyncClient();
  let syncStatus = { state: syncClient ? "idle" : "off", error: null };
  let pendingRefresh = false;
  const syncer = createSyncer(store, () => (syncClient && syncClient.gistId ? syncClient : null), {
    onStatus: (state, info) => {
      syncStatus = { state, error: state === "error" ? info : null };
      if (state === "synced" && info) refreshAfterRemoteChange();
      if (live.syncRow && live.syncRow.isConnected) drawSyncRow(live.syncRow);
    },
  });

  // Show changes made on another device, without yanking anything out from under the user.
  function refreshAfterRemoteChange() {
    const busy = document.querySelector(".sheet-wrap") || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement && document.activeElement.tagName);
    if (busy) return (pendingRefresh = true);
    pendingRefresh = false;
    if (!auth || !app.contains(main)) return;
    if (tab === "session" && runner && runner.active) return; // the running view doesn't show templates
    renderTab();
  }
  document.addEventListener("focusout", () => pendingRefresh && setTimeout(refreshAfterRemoteChange, 300));

  async function connectSync(token) {
    const client = createGistClient({ token });
    const login = await client.user();
    await client.connect(store.doc());
    save(KEY.syncToken, token);
    save(KEY.gistId, client.gistId);
    save(KEY.syncLogin, login);
    syncClient = client;
    await syncer.now();
    if (syncStatus.state === "error") throw new Error(syncStatus.error);
    return login;
  }
  function disconnectSync() {
    [KEY.syncToken, KEY.gistId, KEY.syncLogin].forEach((k) => localStorage.removeItem(k));
    syncClient = null;
    syncStatus = { state: "off", error: null };
  }
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 10 ? "just now" : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };
  function drawSyncRow(el) {
    const login = load(KEY.syncLogin, "");
    const desc =
      syncStatus.state === "syncing" ? "Syncing…" : syncStatus.state === "error" ? syncStatus.error : syncer.lastSync ? `Up to date · ${ago(syncer.lastSync)}` : "Waiting to sync";
    fill(el,
      h("div", { className: "setting" },
        h("div", { className: syncStatus.state === "error" ? "" : "green", style: "width:24px" }, icon(syncStatus.state === "error" ? "info" : "check")),
        h("div", { className: "grow" }, h("div", { className: "t" }, `Synced with GitHub${login ? ` · @${login}` : ""}`), h("div", { className: "s" + (syncStatus.state === "error" ? " err" : "") }, desc)),
        h("button", { className: "btn outline small", disabled: syncStatus.state === "syncing", onClick: () => syncer.now() }, "Sync now"),
      ),
    );
  }
  function openSyncSetup(onDone) {
    const input = h("input", { className: "field", placeholder: "Paste your GitHub token", autocapitalize: "off", autocomplete: "off", spellcheck: "false" });
    const step = (n, ...content) => h("div", { className: "step" }, h("span", { className: "n" }, n), h("div", null, ...content));
    const close = openSheet(h("div", null,
      h("h3", null, "Sync your devices"),
      h("p", { className: "sub" }, "Your trims and sessions are kept in a private GitHub Gist, so your phone and computer always have the same ones. You'll need a free GitHub account; use the same one on every device."),
      h("div", { className: "steps", style: "margin:16px 0" },
        step(1, h("a", { href: "https://github.com/settings/tokens/new?scopes=gist&description=Playlist%20Plus%20sync", target: "_blank", rel: "noopener" }, "Create a GitHub token"), ". Only “gist” is ticked, so the token can't touch anything else. Pick a long expiration, tap ", h("b", null, "Generate token"), " and copy it."),
        step(2, "Paste it here, on each device:"),
      ),
      input,
      h("div", { className: "spacer" }),
      h("button", { className: "btn block", onClick: async (e) => {
        const token = input.value.trim();
        if (token.length < 20) return toast("That doesn't look like a GitHub token.", true);
        e.target.disabled = true;
        e.target.textContent = "Connecting…";
        try {
          const login = await connectSync(token);
          toast(`Synced with @${login}`);
          close();
          onDone && onDone();
        } catch (err) {
          toast(err.message, true);
          e.target.disabled = false;
          e.target.textContent = "Connect";
        }
      } }, "Connect"),
    ));
    setTimeout(() => input.focus(), 320);
  }

  // ----- session lifecycle --------------------------------------------------------------
  let runner = null;
  let wakeLock = null;
  const keepAwake = async () => {
    try {
      if (runner && runner.active && navigator.wakeLock && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => (wakeLock = null));
      }
    } catch {
      /* not supported or denied: the session still runs while the app is open */
    }
  };

  const runnerOpts = (extra = {}) => ({
    fadeMs: settings.fadeSeconds * 1000,
    crossfadeMs: settings.crossfadeSeconds * 1000,
    trims: settings.trimsInSessions ? trims : {},
    onEvent: (type, r) => {
      if (type === "phase") toast(`Now: ${r.phase.name}`);
      if (type === "finish") {
        toast("Session complete 🎉");
        clearSession();
        if (wakeLock) wakeLock.release();
        if (tab === "session") renderTab();
      }
      if (type === "phase" || type === "track") saveSession();
      live.key = null;
      updateLive();
    },
    ...extra,
  });

  // A session survives iOS closing the app: it's saved as it goes and offered (or quietly
  // resumed) on the next launch.
  let sessionTitle = "";
  function saveSession() {
    if (!(runner && runner.active)) return;
    const snap = runner.snapshot();
    // Smooth sessions never re-plan, so the (possibly large) playlists needn't be stored.
    if (snap.opts.smooth) snap.phases = snap.phases.map(({ pool, ...p }) => p);
    save(KEY.session, { ...snap, title: sessionTitle, savedAt: Date.now() });
  }
  function clearSession() {
    localStorage.removeItem(KEY.session);
  }
  function savedSession() {
    const snap = load(KEY.session, null);
    if (!snap || !snap.phases || Date.now() - snap.savedAt > 4 * 3600 * 1000) return null;
    return snap;
  }
  function resumeSession(snap) {
    if (runner) runner.stop();
    runner = SessionRunner.restore(player, snap, runnerOpts());
    // Exact sessions count the time that passed while the app was closed, if music played.
    if (!snap.opts.smooth && player.isPlaying()) runner.phaseElapsed += Math.min(Date.now() - snap.savedAt, 3600 * 1000);
    sessionTitle = snap.title || "";
    lastTick = Date.now();
    keepAwake();
    tab = "session";
    render();
  }
  function resumeCard() {
    const snap = !(runner && runner.active) && savedSession();
    if (!snap) return null;
    const ph = snap.phases[snap.phaseIdx];
    return h("div", { className: "card resume", style: `--c:${(ph && ph.color) || phaseColor(snap.phaseIdx)}` },
      h("div", { className: "tiny", style: "font-weight:700;text-transform:uppercase;letter-spacing:.08em" }, "Session in progress"),
      h("div", { style: "font-size:18px;font-weight:800;margin:2px 0 10px" }, `${snap.title || "Timed session"} · ${ph ? ph.name : ""}`),
      h("div", { className: "row" },
        h("button", { className: "btn small", onClick: () => resumeSession(snap) }, icon("play"), "Resume"),
        h("button", { className: "btn outline small", onClick: () => (clearSession(), renderTab()) }, "Discard"),
      ),
    );
  }

  // Make sure Spotify is open somewhere we can play to; if not, help the user open it.
  async function findDevice() {
    await player.poll();
    if (player.state && player.state.device) return true;
    try {
      const { devices } = await api("GET", "/me/player/devices");
      const pick = devices.find((d) => d.is_active) || devices.find((d) => d.type === "Smartphone") || devices[0];
      if (pick) {
        player.chosenDevice = pick.id;
        return true;
      }
    } catch {
      /* fall through */
    }
    return false;
  }
  async function ensureDevice() {
    if (await findDevice()) return true;
    return new Promise((resolve) => {
      let ok = false;
      const check = async () => {
        if (document.hidden) return;
        if (await findDevice()) {
          ok = true;
          close();
        }
      };
      document.addEventListener("visibilitychange", check);
      const close = openSheet(h("div", null,
        h("h3", null, "Open Spotify first"),
        h("p", { className: "sub" }, "Playlist Plus plays your session in the Spotify app. Open Spotify, then come back here and the session starts."),
        h("div", { className: "spacer" }),
        h("a", { className: "btn block", href: "spotify:" }, "Open Spotify"),
        h("div", { className: "spacer" }),
        h("button", { className: "btn outline block", onClick: async () => {
          await check();
          if (!ok) toast("Still can't find Spotify. Is it open on your phone?", true);
        } }, "I'm back, start"),
      ), { onClose: () => {
        document.removeEventListener("visibilitychange", check);
        resolve(ok);
      } });
    });
  }

  async function startSession(phases) {
    if (!(await ensureDevice())) return;
    if (runner) runner.stop();
    runner = new SessionRunner(player, phases, runnerOpts({ smooth: phases.mode === "smooth" }));
    sessionTitle = phases.title || "";
    lastTick = Date.now();
    runner.start();
    saveSession();
    keepAwake();
    toast(`Starting ${phases[0].name}`);
    tab = "session";
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function stopSession(ask) {
    if (!runner) return;
    if (ask && !(await confirmSheet("End this session?", "The music keeps playing; the timer stops.", "End session"))) return;
    runner.stop();
    runner = null;
    clearSession();
    if (wakeLock) wakeLock.release();
    toast("Session ended");
    if (tab === "session") renderTab();
  }

  // ----- main loop -------------------------------------------------------------------------
  const trimWatcher = new TrimWatcher(player, () => trims);
  let lastTick = Date.now();
  let lastLive = 0;

  function tick() {
    const now = Date.now();
    const sessionOn = runner && runner.active;
    // After the phone was locked, wait for fresh state; the gap then counts as listening time.
    if (document.hidden || !player.fresh()) {
      if (!sessionOn) lastTick = now;
      return;
    }
    const dt = Math.min(now - lastTick, 3 * 3600 * 1000);
    lastTick = now;
    try {
      if (sessionOn) runner.tick(dt);
      else if (settings.trimsEnabled) trimWatcher.tick();
    } catch (e) {
      console.error(e);
    }
    if (now - lastLive > 250) {
      lastLive = now;
      updateLive();
    }
    if (sessionOn && now - lastSaved > 5000) {
      lastSaved = now;
      saveSession();
    }
  }
  let lastSaved = 0;

  // Poll faster when something is about to happen (a cut, a hand-over, a trim), so it lands on time.
  function msToNextAction() {
    const s = player.state;
    if (!s || !s.playing) return Infinity;
    const pos = player.progress();
    if (runner && runner.active) {
      const item = runner.item;
      return item ? Math.min(item.end - pos, runner.opts.smooth ? Infinity : runner.phaseLeft()) : Infinity;
    }
    // Outside sessions: a trim end coming up, or a song ending (the next one may have a trimmed start).
    const t = settings.trimsEnabled && trims[s.uri];
    return Math.min(t && t.end ? t.end - pos : Infinity, s.duration ? s.duration - pos : Infinity);
  }

  async function pollLoop() {
    for (;;) {
      if (auth && !document.hidden) await player.poll();
      const busy = (runner && runner.active) || (settings.trimsEnabled && Object.keys(trims).length);
      const soon = msToNextAction() < 8000;
      await new Promise((r) => setTimeout(r, soon ? 400 : busy ? 1000 : 3000));
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    player.fetchedAt = 0; // state is stale after being in the background
    player.poll();
    keepAwake();
    syncer.now();
  });

  // ----- boot --------------------------------------------------------------------------------
  (async () => {
    try {
      await handleRedirect();
    } catch (e) {
      fatal = e.message;
    }
    render();
    syncer.start();
    if (auth) {
      setInterval(tick, 100);
      pollLoop();
      await player.poll();
      updateLive();
      // iOS often closes a backgrounded web app. If a session was running a moment ago and
      // Spotify is still playing it, carry on as if nothing happened; otherwise offer to resume.
      const snap = savedSession();
      if (snap && player.state) {
        const uris = new Set(snap.phases.flatMap((p) => p.items.map((i) => i.uri)));
        if (uris.has(player.state.uri)) resumeSession(snap);
      }
    }
  })();
})();
