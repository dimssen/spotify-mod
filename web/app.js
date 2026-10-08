// Playlist Plus for phones: controls the Spotify app on this phone (or any Spotify device)
// through the Spotify Web API. Shares its playback logic with the desktop extension.
(() => {
  const { parseTime, formatTime, normalizePlaylistUri, computeBudgets, planPhase, SessionRunner, TrimWatcher } = window.PlaylistPlusCore;

  // ----- storage (same keys and formats as the desktop extension) -----------
  const KEY = {
    trims: "playlist-plus:trims",
    templates: "playlist-plus:templates",
    settings: "playlist-plus:settings",
    activeTemplate: "playlist-plus:active-template",
    clientId: "playlist-plus:client-id",
    auth: "playlist-plus:auth",
    verifier: "playlist-plus:pkce-verifier",
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

  let trims = load(KEY.trims, {});
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
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = (data && data.error) || {};
      throw new ApiError(res.status, err.message || `Spotify error ${res.status}`, err.reason);
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

  let me = null;
  let playlistsCache = null;
  async function listPlaylists(force) {
    if (playlistsCache && !force) return playlistsCache;
    me = me || (await api("GET", "/me"));
    const all = await getAll("/me/playlists?limit=50");
    // Spotify only lets apps read the songs of playlists you own or collaborate on.
    playlistsCache = all
      .filter(Boolean)
      .map((p) => ({ uri: p.uri, id: p.id, name: p.name, readable: p.collaborative || (p.owner && p.owner.id === me.id) }));
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
      .map((t) => ({ uri: t.uri, name: t.name, artist: (t.artists || []).map((a) => a.name).join(", "), duration: t.duration_ms }));
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
          const d = await api("GET", "/me/player?additional_types=episode");
          this.fetchedAt = Date.now();
          this.state =
            d && d.item
              ? {
                  uri: d.item.uri,
                  name: d.item.name,
                  artist: (d.item.artists || []).map((a) => a.name).join(", "),
                  duration: d.item.duration_ms,
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
      setTimeout(() => this.poll(), 600);
    },

    command(method, path, body) {
      api(method, path, body)
        .catch((e) => {
          if (e.reason === "NO_ACTIVE_DEVICE" || e.status === 404) toast("No active Spotify device. Open Spotify on your phone, play any song, then try again.", true);
          else if (e.reason !== "VOLUME_CONTROL_DISALLOW") toast(e.message, true);
        })
        .finally(() => this.pollSoon());
    },

    play(uri, start, upcoming) {
      const uris = [uri, ...(upcoming || [])].slice(0, 100);
      this.command("PUT", `/me/player/play${this.deviceQuery()}`, { uris, position_ms: Math.round(start || 0) });
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

  let toastEl = null;
  function toast(msg, isError) {
    if (!toastEl) {
      toastEl = h("div", { style: "position:fixed;left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:10;padding:12px 14px;border-radius:10px;font-size:15px;box-shadow:0 4px 16px #0008;display:none" });
      document.body.append(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.background = isError ? "#5c1d24" : "#2a2a2a";
    toastEl.style.display = "";
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (toastEl.style.display = "none"), 4000);
  }

  // ----- screens ---------------------------------------------------------------
  const app = document.getElementById("app");
  let tab = "session";
  let fatal = null;
  const nowPlayingBox = h("div");
  const sessionBox = h("div");
  const tabBox = h("div");

  function render() {
    if (!clientId) return fill(app, setupScreen());
    if (!auth) return fill(app, loginScreen());
    fill(
      app,
      h("h1", null, "Playlist Plus"),
      nowPlayingBox,
      sessionBox,
      h("div", { className: "tabs" },
        [["session", "Session"], ["trims", "Trims"], ["settings", "Settings"]].map(([id, label]) =>
          h("button", { className: tab === id ? "on" : "", onClick: () => ((tab = id), render()) }, label),
        ),
      ),
      tabBox,
    );
    updateLive();
    fill(tabBox, tab === "session" ? sessionTab() : tab === "trims" ? trimsTab() : settingsTab());
  }

  function setupScreen() {
    const input = h("input", { className: "grow", placeholder: "Client ID", autocapitalize: "off", autocomplete: "off", spellcheck: "false" });
    return h("div", null,
      h("h1", null, "Playlist Plus"),
      fatal && h("div", { className: "error" }, fatal),
      h("div", { className: "card" },
        h("p", null, "One-time setup (about 3 minutes, easiest on a computer). Spotify requires every app to have its own key:"),
        h("ol", null,
          h("li", null, "Go to ", h("a", { href: "https://developer.spotify.com/dashboard", target: "_blank", rel: "noopener" }, "developer.spotify.com/dashboard"), " and log in with your Spotify account."),
          h("li", null, "Click ", h("b", null, "Create app"), ". Any name and description will do."),
          h("li", null, "Under ", h("b", null, "Redirect URIs"), ", add exactly: ", h("code", null, redirectUri())),
          h("li", null, "Under ", h("b", null, "APIs used"), ", tick ", h("b", null, "Web API"), ", then save."),
          h("li", null, "Open the app's settings, copy the ", h("b", null, "Client ID"), " and paste it below."),
        ),
        h("div", { className: "row" },
          input,
          h("button", {
            onClick: () => {
              const v = input.value.trim();
              if (!/^[0-9a-f]{32}$/i.test(v)) return toast("A Client ID is 32 letters and numbers.", true);
              clientId = v;
              save(KEY.clientId, v);
              render();
            },
          }, "Save"),
        ),
      ),
    );
  }

  function loginScreen() {
    return h("div", null,
      h("h1", null, "Playlist Plus"),
      fatal && h("div", { className: "error" }, fatal),
      h("div", { className: "card" },
        h("p", null, "Connect your Spotify Premium account. Playlist Plus controls the Spotify app on your phone, so keep Spotify installed and logged in."),
        h("div", { className: "row" },
          h("button", { onClick: login }, "Connect Spotify"),
          h("button", { className: "sec small", onClick: () => {
            clientId = "";
            localStorage.removeItem(KEY.clientId);
            render();
          } }, "Change Client ID"),
        ),
      ),
    );
  }

  // Now playing + running session: refreshed often, without rebuilding the tab content.
  function updateLive() {
    const s = player.state;
    if (!auth) return;
    if (!player.fetchedAt && !player.lastError) {
      fill(nowPlayingBox, h("div", { className: "card muted" }, "Connecting to Spotify…"));
    } else if (!s) {
      fill(nowPlayingBox, h("div", { className: "card" },
        h("b", null, "Nothing is playing"),
        h("p", { className: "muted" }, player.lastError ? `Spotify: ${player.lastError}` : "Open the Spotify app, play any song, then come back here."),
      ));
    } else {
      const pct = s.duration ? Math.min(100, (player.progress() / s.duration) * 100) : 0;
      const trim = trims[s.uri];
      fill(nowPlayingBox, h("div", { className: "card np" },
        h("div", { className: "title" }, s.name),
        h("div", { className: "muted" }, `${s.artist}${s.device ? " · on " + s.device.name : ""}`),
        h("div", { className: "muted" }, `${s.playing ? "▶" : "❚❚"} ${formatTime(player.progress())} / ${formatTime(s.duration)}${trim ? `  ·  trimmed ${formatTime(trim.start || 0)}–${trim.end ? formatTime(trim.end) : "end"}` : ""}`),
        h("div", { className: "bar" }, h("div", { style: `width:${pct}%` })),
      ));
    }
    const st = runner && runner.status();
    if (!st) return fill(sessionBox);
    fill(sessionBox, h("div", { className: "card session" },
      h("div", { className: "muted" }, `Phase ${st.phaseIdx + 1} of ${st.phaseCount}`),
      h("div", { className: "big" }, st.phaseName),
      h("div", null, `${formatTime(st.phaseLeft)} left in phase`),
      h("div", { className: "muted" }, `${formatTime(st.totalLeft)} left in session`),
      h("div", { className: "row" },
        h("button", { className: "sec small", onClick: () => runner.skipTrack() }, "Next song"),
        st.phaseIdx + 1 < st.phaseCount && h("button", { className: "sec small", onClick: () => runner.skipPhase() }, "Next phase"),
        h("button", { className: "sec small", onClick: stopSession }, "Stop"),
      ),
    ));
  }

  // ----- timed session tab -----------------------------------------------------
  function sessionTab() {
    let tpl = templates.find((t) => t.id === activeTemplateId) || templates[0];
    const root = h("div");
    const err = h("div", { className: "error" });
    const planBox = h("div");
    let playlists = playlistsCache || [];
    const persist = () => saveTemplates();

    const draw = () => {
      const readable = playlists.filter((p) => p.readable);
      const phaseCards = tpl.phases.map((ph, i) => {
        const known = readable.some((p) => p.uri === ph.playlistUri);
        return h("div", { className: "phase" },
          h("div", { className: "row" },
            h("input", { className: "name grow", value: ph.name, onChange: (e) => ((ph.name = e.target.value), persist()) }),
            h("button", { className: "sec small", disabled: i === 0, "aria-label": "Move up", onClick: () => {
              [tpl.phases[i - 1], tpl.phases[i]] = [tpl.phases[i], tpl.phases[i - 1]];
              persist();
              draw();
            } }, "↑"),
            h("button", { className: "sec small", "aria-label": "Remove phase", onClick: () => {
              tpl.phases.splice(i, 1);
              persist();
              draw();
            } }, "✕"),
          ),
          h("div", { className: "row" },
            h("select", { className: "grow", onChange: (e) => ((ph.playlistUri = e.target.value), persist()) },
              h("option", { value: "" }, playlistsCache ? "Choose playlist…" : "Loading playlists…"),
              !known && ph.playlistUri && h("option", { value: ph.playlistUri, selected: true }, ph.playlistUri),
              readable.map((p) => h("option", { value: p.uri, selected: p.uri === ph.playlistUri }, p.name)),
            ),
          ),
          h("div", { className: "row" },
            h("input", { className: "grow", placeholder: "…or paste a playlist link", autocapitalize: "off", onChange: (e) => {
              const uri = normalizePlaylistUri(e.target.value);
              if (!uri) return toast("That doesn't look like a playlist link.", true);
              ph.playlistUri = uri;
              persist();
              draw();
            } }),
          ),
          h("div", { className: "row" },
            h("input", { type: "number", inputmode: "decimal", min: "0", step: "0.5", value: ph.value, disabled: ph.mode === "rest", onChange: (e) => ((ph.value = Number(e.target.value)), persist()) }),
            h("select", { onChange: (e) => ((ph.mode = e.target.value), persist(), draw()) },
              h("option", { value: "minutes", selected: ph.mode === "minutes" }, "minutes"),
              h("option", { value: "percent", selected: ph.mode === "percent" }, "% of total"),
              h("option", { value: "rest", selected: ph.mode === "rest" }, "remaining time"),
            ),
          ),
        );
      });

      fill(root,
        h("div", { className: "row" },
          h("select", { className: "grow", onChange: (e) => {
            activeTemplateId = e.target.value;
            tpl = templates.find((t) => t.id === activeTemplateId);
            persist();
            draw();
          } }, templates.map((t) => h("option", { value: t.id, selected: t.id === tpl.id }, t.name))),
        ),
        h("div", { className: "row" },
          h("button", { className: "sec small", onClick: () => {
            const name = prompt("Name for the copy", tpl.name + " (copy)");
            if (!name) return;
            const copy = { ...JSON.parse(JSON.stringify(tpl)), id: String(Date.now()), name };
            templates.push(copy);
            activeTemplateId = copy.id;
            tpl = copy;
            persist();
            draw();
          } }, "Duplicate"),
          h("button", { className: "sec small", onClick: () => {
            const name = prompt("Rename", tpl.name);
            if (!name) return;
            tpl.name = name;
            persist();
            draw();
          } }, "Rename"),
          h("button", { className: "sec small", disabled: templates.length < 2, onClick: () => {
            if (!confirm(`Delete "${tpl.name}"?`)) return;
            templates = templates.filter((t) => t !== tpl);
            tpl = templates[0];
            activeTemplateId = tpl.id;
            persist();
            draw();
          } }, "Delete"),
        ),
        h("div", { className: "row" },
          h("span", null, "Length"),
          h("input", { type: "number", inputmode: "numeric", min: "1", value: tpl.totalMin, onChange: (e) => ((tpl.totalMin = Number(e.target.value)), persist()) }),
          h("span", null, "minutes"),
        ),
        h("h2", null, "Phases (played in order)"),
        phaseCards,
        h("button", { className: "sec small", onClick: () => {
          tpl.phases.push({ name: `Phase ${tpl.phases.length + 1}`, playlistUri: "", mode: "minutes", value: 5 });
          persist();
          draw();
        } }, "+ Add phase"),
        h("p", { className: "muted" }, "“Remaining time” phases share whatever the others don't use. Without one, leftover time goes to the last phase. Only playlists you created (or collaborate on) can be used: Spotify doesn't let apps read other playlists."),
        h("label", { className: "check" }, h("input", { type: "checkbox", checked: tpl.shuffle, onChange: (e) => ((tpl.shuffle = e.target.checked), persist()) }), "Shuffle within each phase"),
        h("label", { className: "check" }, h("input", { type: "checkbox", checked: tpl.smartFit, onChange: (e) => ((tpl.smartFit = e.target.checked), persist()) }), "Smart fit (prefer songs that finish before the phase ends)"),
        err,
        h("div", { className: "row" },
          h("button", { onClick: () => run(false) }, runner && runner.active ? "Restart session" : "Start session"),
          h("button", { className: "sec", onClick: () => run(true) }, "Preview plan"),
        ),
        planBox,
      );
    };

    async function buildPlan() {
      const budgets = computeBudgets(Number(tpl.totalMin) * 60000, tpl.phases);
      const trimMap = settings.trimsInSessions ? trims : {};
      const phases = [];
      for (let i = 0; i < tpl.phases.length; i++) {
        const ph = tpl.phases[i];
        if (budgets[i] <= 0) continue;
        if (!ph.playlistUri) throw new Error(`Choose a playlist for "${ph.name}".`);
        let pool;
        try {
          pool = await loadPlaylistTracks(ph.playlistUri);
        } catch (e) {
          throw new Error(`"${ph.name}": ${e.message}`);
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
      fill(planBox,
        h("h2", null, "Plan"),
        phases.map((ph) => {
          let t = 0;
          const rows = [];
          for (const it of ph.items) {
            if (t >= ph.budget) break;
            const plays = Math.min(it.length, ph.budget - t);
            rows.push(h("li", null,
              h("span", { className: "muted" }, formatTime(t)),
              h("div", { className: "grow" }, h("div", { className: "name" }, it.name), h("div", { className: "muted name" }, it.artist)),
              h("span", { className: "muted" }, plays < it.length ? `${formatTime(plays)}✂` : formatTime(plays)),
            ));
            t += it.length;
          }
          return h("div", { className: "card" }, h("b", null, `${ph.name} · ${formatTime(ph.budget)}`), h("ul", { className: "list" }, rows));
        }),
        h("button", { onClick: () => startSession(phases) }, "Start this plan"),
      );
    }

    async function run(previewOnly) {
      err.textContent = "";
      fill(planBox, h("p", { className: "muted" }, "Loading playlists…"));
      try {
        const phases = await buildPlan();
        if (previewOnly) showPlan(phases);
        else {
          fill(planBox);
          startSession(phases);
        }
      } catch (e) {
        fill(planBox);
        err.textContent = e.message;
      }
    }

    draw();
    if (!playlistsCache) {
      listPlaylists()
        .then((p) => {
          playlists = p;
          if (root.isConnected) draw();
        })
        .catch((e) => (err.textContent = `Couldn't load your playlists: ${e.message}`));
    }
    return root;
  }

  // ----- trims tab -------------------------------------------------------------
  let editing = null; // { uri, name, artist, duration }

  function trimEditor(track, rerender) {
    const existing = trims[track.uri] || {};
    const fmt = (ms) => (ms ? formatTime(ms) : "");
    const startIn = h("input", { className: "time", inputmode: "decimal", placeholder: "0:00", value: fmt(existing.start) });
    const endIn = h("input", { className: "time", inputmode: "decimal", placeholder: "end", value: fmt(existing.end) });
    const err = h("div", { className: "error" });
    const isCurrent = () => player.currentUri() === track.uri;
    const nowBtn = (input) =>
      h("button", { className: "sec small", onClick: () => {
        if (!isCurrent()) return toast("Play this song first to use its current position.", true);
        input.value = formatTime(player.progress());
      } }, "Now");
    const read = () => {
      const start = parseTime(startIn.value) || 0;
      const end = parseTime(endIn.value);
      if (Number.isNaN(start) || Number.isNaN(end)) return { error: "Use m:ss, e.g. 1:05." };
      if (end != null && end <= start + 5000) return { error: "End must be at least 5 seconds after start." };
      if (track.duration && end != null && end > track.duration) return { error: `End is past the song's length (${formatTime(track.duration)}).` };
      if (track.duration && start >= track.duration) return { error: "Start is past the end of the song." };
      return { start, end };
    };
    const close = () => {
      editing = null;
      rerender();
    };
    return h("div", { className: "card" },
      h("b", null, `Trim: ${track.name}`),
      h("div", { className: "muted" }, `${track.artist || ""}${track.duration ? " · " + formatTime(track.duration) : ""}`),
      h("div", { className: "row" }, h("span", { style: "width:44px" }, "Start"), startIn, nowBtn(startIn)),
      h("div", { className: "row" }, h("span", { style: "width:44px" }, "End"), endIn, nowBtn(endIn)),
      h("div", { className: "muted" }, "Leave End empty to play to the end. Tap “Now” while the song plays to grab its position."),
      err,
      h("div", { className: "row" },
        h("button", { onClick: () => {
          const r = read();
          if (r.error) return (err.textContent = r.error);
          if (!r.start && r.end == null) delete trims[track.uri];
          else trims[track.uri] = { start: r.start, end: r.end, name: track.name, artist: track.artist };
          saveTrims();
          toast(trims[track.uri] ? `Trimmed “${track.name}”` : `Removed trim from “${track.name}”`);
          close();
        } }, "Save"),
        h("button", { className: "sec small", onClick: () => {
          const r = read();
          if (r.error) return (err.textContent = r.error);
          player.play(track.uri, r.start || 0);
        } }, "Play from start"),
        h("button", { className: "sec small", onClick: () => {
          const r = read();
          if (r.error) return (err.textContent = r.error);
          if (r.end == null) return (err.textContent = "No end point set.");
          const at = Math.max(r.start || 0, r.end - 5000);
          if (isCurrent()) player.seek(at);
          else player.play(track.uri, at);
        } }, "Hear the end"),
        trims[track.uri] && h("button", { className: "sec small", onClick: () => {
          delete trims[track.uri];
          saveTrims();
          close();
        } }, "Remove"),
        h("button", { className: "sec small", onClick: close }, "Cancel"),
      ),
    );
  }

  function trimsTab() {
    const root = h("div");
    const browseBox = h("div");
    const io = h("textarea", { placeholder: "Paste trims exported from the desktop extension (or another phone) here" });

    const draw = () => {
      const s = player.state;
      const entries = Object.entries(trims);
      fill(root,
        editing
          ? trimEditor(editing, draw)
          : h("div", { className: "row" },
              h("button", { disabled: !s, onClick: () => {
                editing = { uri: s.uri, name: s.name, artist: s.artist, duration: s.duration };
                draw();
              } }, s ? "Trim the song that's playing" : "Play a song to trim it"),
            ),
        h("h2", null, "Find a song in your playlists"),
        browseBox,
        h("h2", null, `Trimmed songs (${entries.length})`),
        entries.length
          ? h("ul", { className: "list" },
              entries.map(([uri, t]) =>
                h("li", null,
                  h("div", { className: "grow" },
                    h("div", { className: "name" }, t.name || uri),
                    h("div", { className: "muted" }, `${formatTime(t.start || 0)} – ${t.end ? formatTime(t.end) : "end"}${t.artist ? " · " + t.artist : ""}`),
                  ),
                  h("button", { className: "sec small", onClick: () => {
                    editing = { uri, name: t.name || uri, artist: t.artist, duration: null };
                    draw();
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  } }, "Edit"),
                ),
              ),
            )
          : h("p", { className: "muted" }, "No trimmed songs yet."),
        h("h2", null, "Copy trims between devices"),
        h("p", { className: "muted" }, "Trims are saved on this phone. To copy them from the desktop extension: export there, send yourself the text, paste it here and import."),
        io,
        h("div", { className: "row" },
          h("button", { className: "sec small", onClick: async () => {
            io.value = JSON.stringify(trims);
            try {
              await navigator.clipboard.writeText(io.value);
              toast("Copied to clipboard");
            } catch {
              io.select();
            }
          } }, "Export"),
          h("button", { className: "sec small", onClick: () => {
            try {
              const data = JSON.parse(io.value);
              if (typeof data !== "object" || !data || Array.isArray(data)) throw new Error();
              Object.assign(trims, data);
              saveTrims();
              toast("Trims imported");
              draw();
            } catch {
              toast("That isn't valid trim data.", true);
            }
          } }, "Import (merge)"),
        ),
      );
    };

    // Playlist browser: pick a playlist, tap a song to trim it.
    const drawBrowse = async () => {
      fill(browseBox, h("p", { className: "muted" }, "Loading playlists…"));
      let pls;
      try {
        pls = (await listPlaylists()).filter((p) => p.readable);
      } catch (e) {
        return fill(browseBox, h("div", { className: "error" }, e.message));
      }
      const list = h("ul", { className: "list" });
      const sel = h("select", { className: "grow", onChange: async (e) => {
        if (!e.target.value) return fill(list);
        fill(list, h("li", { className: "muted" }, "Loading…"));
        try {
          const tracks = await loadPlaylistTracks(e.target.value);
          fill(list, tracks.map((t) =>
            h("li", { onClick: () => {
              editing = t;
              draw();
              window.scrollTo({ top: 0, behavior: "smooth" });
            } },
              h("div", { className: "grow" }, h("div", { className: "name" }, t.name), h("div", { className: "muted name" }, t.artist)),
              h("span", { className: "muted" }, trims[t.uri] ? "✂ trimmed" : formatTime(t.duration)),
            ),
          ));
        } catch (err) {
          fill(list, h("li", { className: "error" }, err.message));
        }
      } }, h("option", { value: "" }, "Choose a playlist…"), pls.map((p) => h("option", { value: p.uri }, p.name)));
      fill(browseBox, h("div", { className: "row" }, sel), list);
    };

    draw();
    drawBrowse();
    return root;
  }

  // ----- settings tab ----------------------------------------------------------
  function settingsTab() {
    const devBox = h("div");
    const cb = (key, label) =>
      h("label", { className: "check" }, h("input", { type: "checkbox", checked: settings[key], onChange: (e) => ((settings[key] = e.target.checked), saveSettings()) }), label);
    const drawDevices = async () => {
      fill(devBox, h("p", { className: "muted" }, "Looking for devices…"));
      try {
        const { devices } = await api("GET", "/me/player/devices");
        fill(devBox,
          devices.length
            ? h("ul", { className: "list" }, devices.map((d) =>
                h("li", null,
                  h("div", { className: "grow" }, h("div", { className: "name" }, d.name), h("div", { className: "muted" }, d.type + (d.is_active ? " · active" : ""))),
                  !d.is_active && h("button", { className: "sec small", onClick: async () => {
                    try {
                      await api("PUT", "/me/player", { device_ids: [d.id], play: false });
                      player.chosenDevice = d.id;
                      toast(`Using ${d.name}`);
                      player.pollSoon();
                      setTimeout(drawDevices, 800);
                    } catch (e) {
                      toast(e.message, true);
                    }
                  } }, "Use"),
                ),
              ))
            : h("p", { className: "muted" }, "No devices found. Open the Spotify app on your phone first."),
          h("button", { className: "sec small", onClick: drawDevices }, "Refresh"),
        );
      } catch (e) {
        fill(devBox, h("div", { className: "error" }, e.message));
      }
    };
    drawDevices();
    return h("div", null,
      h("div", { className: "card" },
        cb("trimsEnabled", "Apply song trims during normal listening"),
        cb("trimsInSessions", "Apply song trims during timed sessions"),
        h("div", { className: "row" },
          h("span", null, "Fade out cut songs for"),
          h("input", { type: "number", inputmode: "numeric", min: "0", max: "15", value: settings.fadeSeconds, onChange: (e) => ((settings.fadeSeconds = Math.max(0, Number(e.target.value) || 0)), saveSettings()) }),
          h("span", null, "s"),
        ),
        h("p", { className: "muted" }, "iPhones don't let apps change Spotify's volume remotely, so fading only works when Spotify plays on a computer or speaker."),
      ),
      h("h2", null, "Play on"),
      devBox,
      h("h2", null, "Account"),
      h("div", { className: "row" },
        h("button", { className: "sec small", onClick: logout }, "Log out"),
        h("button", { className: "sec small", onClick: () => {
          if (!confirm("Forget the Client ID and log out?")) return;
          clientId = "";
          localStorage.removeItem(KEY.clientId);
          logout();
        } }, "Change Client ID"),
      ),
    );
  }

  // ----- session lifecycle -------------------------------------------------------
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

  function startSession(phases) {
    if (runner) runner.stop();
    runner = new SessionRunner(player, phases, {
      fadeMs: settings.fadeSeconds * 1000,
      trims: settings.trimsInSessions ? trims : {},
      onEvent: (type, r) => {
        if (type === "phase") toast(`Now: ${r.phase.name}`);
        if (type === "finish") {
          toast("Session complete 🎉");
          if (wakeLock) wakeLock.release();
        }
        updateLive();
      },
    });
    lastTick = Date.now();
    runner.start();
    keepAwake();
    toast(`Session started: ${phases[0].name}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
    updateLive();
  }

  function stopSession() {
    if (!runner) return;
    runner.stop();
    runner = null;
    if (wakeLock) wakeLock.release();
    updateLive();
    toast("Session stopped");
  }

  // ----- main loop ---------------------------------------------------------------
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
    if (now - lastLive > 500 && document.activeElement?.tagName !== "SELECT") {
      lastLive = now;
      updateLive();
    }
  }

  async function pollLoop() {
    for (;;) {
      if (auth && !document.hidden) await player.poll();
      const busy = (runner && runner.active) || (settings.trimsEnabled && Object.keys(trims).length);
      await new Promise((r) => setTimeout(r, busy ? 1000 : 3000));
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    player.fetchedAt = 0; // state is stale after being in the background
    player.poll();
    keepAwake();
  });

  // ----- boot ----------------------------------------------------------------------
  (async () => {
    try {
      await handleRedirect();
    } catch (e) {
      fatal = e.message;
    }
    render();
    if (auth) {
      setInterval(tick, 200);
      pollLoop();
    }
  })();
})();
