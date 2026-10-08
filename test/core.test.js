const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../playlist-plus.js");

const { parseTime, formatTime, normalizePlaylistUri, computeBudgets, planPhase, SessionRunner, TrimWatcher } = core;
const MIN = 60000;

test("parseTime / formatTime", () => {
  assert.equal(parseTime("1:30"), 90000);
  assert.equal(parseTime("90"), 90000);
  assert.equal(parseTime("1:02:03"), 3723000);
  assert.equal(parseTime("0:05.5"), 5500);
  assert.equal(parseTime(""), null);
  assert.ok(Number.isNaN(parseTime("abc")));
  assert.equal(formatTime(90000), "1:30");
  assert.equal(formatTime(3723000), "1:02:03");
});

test("normalizePlaylistUri", () => {
  assert.equal(normalizePlaylistUri("https://open.spotify.com/playlist/37i9dQZF1DX?si=abc"), "spotify:playlist:37i9dQZF1DX");
  assert.equal(normalizePlaylistUri("https://open.spotify.com/intl-de/playlist/abc123"), "spotify:playlist:abc123");
  assert.equal(normalizePlaylistUri("spotify:user:bob:playlist:xyz"), "spotify:playlist:xyz");
  assert.equal(normalizePlaylistUri("spotify:album:xyz"), null);
});

test("computeBudgets: warm-up / normal / rest", () => {
  const phases = [
    { name: "Warm-up", mode: "minutes", value: 6 },
    { name: "Normal", mode: "minutes", value: 36 },
    { name: "Cool-down", mode: "rest" },
  ];
  assert.deepEqual(computeBudgets(50 * MIN, phases), [6 * MIN, 36 * MIN, 8 * MIN]);
});

test("computeBudgets: percent, leftover to last, overflow error", () => {
  assert.deepEqual(computeBudgets(40 * MIN, [{ mode: "percent", value: 25 }, { mode: "minutes", value: 10 }]), [10 * MIN, 30 * MIN]);
  assert.throws(() => computeBudgets(10 * MIN, [{ mode: "minutes", value: 8 }, { mode: "minutes", value: 5 }]), /longer than the session/);
});

const track = (n, secs) => ({ uri: `spotify:track:t${n}`, name: `T${n}`, duration: secs * 1000 });

test("planPhase covers the budget and respects trims", () => {
  const tracks = [track(1, 200), track(2, 180), track(3, 240)];
  const trims = { "spotify:track:t3": { start: 30000, end: 90000 } };
  const items = planPhase(tracks, 10 * MIN, { shuffle: false, smartFit: false, trims });
  const total = items.reduce((a, b) => a + b.length, 0);
  assert.ok(total >= 10 * MIN);
  const t3 = items.find((i) => i.uri === "spotify:track:t3");
  assert.equal(t3.start, 30000);
  assert.equal(t3.length, 60000);
  for (let i = 1; i < items.length; i++) assert.notEqual(items[i].uri, items[i - 1].uri);
});

test("planPhase smart fit prefers songs that fit", () => {
  const tracks = [track(1, 300), track(2, 100)];
  const items = planPhase(tracks, 200000, { shuffle: false, smartFit: true });
  assert.equal(items[0].uri, "spotify:track:t2");
});

test("planPhase smart fit avoids ending a phase on a few-second fragment", () => {
  // 280s would leave a 20s gap; 200s + 100s fills 300s exactly.
  const tracks = [track(1, 280), track(2, 200), track(3, 100)];
  const items = planPhase(tracks, 300000, { shuffle: false, smartFit: true });
  assert.deepEqual(items.map((i) => i.uri), ["spotify:track:t2", "spotify:track:t3"]);
  // When nothing fits cleanly, cut a song near its end instead of adding a 20s fragment.
  // 270s would leave 30s for a fragment; instead play the 400s song and cut it at 5:00.
  const items2 = planPhase([track(1, 270), track(2, 400)], 300000, { shuffle: false, smartFit: true });
  assert.deepEqual(items2.map((i) => i.uri), ["spotify:track:t2"]);
});

test("planPhase smart fit looks ahead so no phase ends on a scrap", () => {
  // Four warm-up songs (2:30, 3:04, 2:47, 3:21) into 6:00, in every starting order.
  const base = [track(1, 150), track(2, 184), track(3, 167), track(4, 201)];
  for (let r = 0; r < base.length; r++) {
    const tracks = base.slice(r).concat(base.slice(0, r));
    const items = planPhase(tracks, 6 * MIN, { shuffle: false, smartFit: true });
    let t = 0;
    for (const it of items) {
      const plays = Math.min(it.length, 6 * MIN - t);
      assert.ok(plays >= 45000, `order ${r}: ${it.uri} would play only ${plays / 1000}s`);
      t += it.length;
    }
  }
});

// --- simulated Spotify player -----------------------------------------------
function fakePlayer(durations) {
  return {
    uri: null,
    pos: 0,
    playing: false,
    volume: 1,
    log: [],
    currentUri() { return this.uri; },
    progress() { return this.pos; },
    isPlaying() { return this.playing; },
    play(uri) { this.uri = uri; this.pos = 0; this.playing = true; this.log.push(uri); },
    seek(ms) { this.pos = ms; },
    next() { this.uri = "spotify:track:autoplay"; this.pos = 0; },
    pause() { this.playing = false; },
    getVolume() { return this.volume; },
    setVolume(v) { this.volume = v; },
    advance(dt) {
      if (!this.playing) return;
      this.pos += dt;
      const d = durations[this.uri] ?? 200000;
      if (this.pos >= d) { this.uri = "spotify:track:autoplay"; this.pos = 0; }
    },
  };
}

function simulate(runner, player, ms, step = 200) {
  for (let t = 0; t < ms && runner.active; t += step) {
    player.advance(step);
    runner.tick(step);
  }
}

test("SessionRunner plays phases for their budgets and stops at the end", () => {
  const warm = [track(1, 120), track(2, 150)];
  const normal = [track(3, 200), track(4, 210), track(5, 190)];
  const cool = [track(6, 100)];
  const durations = Object.fromEntries([...warm, ...normal, ...cool].map((t) => [t.uri, t.duration]));
  const p = fakePlayer(durations);
  const budgets = computeBudgets(20 * MIN, [
    { mode: "minutes", value: 3 },
    { mode: "minutes", value: 12 },
    { mode: "rest" },
  ]);
  const pools = [warm, normal, cool];
  const phases = pools.map((pool, i) => ({ name: `P${i}`, budget: budgets[i], pool, items: planPhase(pool, budgets[i], { shuffle: false }) }));
  const events = [];
  const r = new SessionRunner(p, phases, { fadeMs: 3000, onEvent: (type, rr) => events.push([type, rr.phaseIdx]) });
  r.start();

  // Track which phase each played URI belonged to, and when.
  let t = 0;
  const firstSeen = {};
  while (r.active && t < 30 * MIN) {
    p.advance(200);
    r.tick(200);
    t += 200;
    if (r.active && firstSeen[r.phaseIdx] == null) firstSeen[r.phaseIdx] = t;
  }
  assert.equal(r.active, false);
  assert.equal(p.playing, false);
  // Session length ≈ 20 min (only playing time counts; small slack for track switches).
  assert.ok(Math.abs(t - 20 * MIN) < 10000, `ended at ${t}`);
  assert.ok(Math.abs(firstSeen[1] - 3 * MIN) < 5000, `phase 2 at ${firstSeen[1]}`);
  assert.ok(Math.abs(firstSeen[2] - 15 * MIN) < 8000, `phase 3 at ${firstSeen[2]}`);
  assert.deepEqual(events.filter((e) => e[0] !== "track").map((e) => e[0]), ["phase", "phase", "finish"]);
  assert.equal(p.volume, 1, "volume restored after fade");
  // Cool-down only ever plays cool-down tracks.
  assert.ok(phases[2].items.every((i) => i.uri === "spotify:track:t6"));
});

test("SessionRunner applies trims and treats a manual skip as next song", () => {
  const tracks = [track(1, 200), track(2, 200)];
  const trims = { "spotify:track:t1": { start: 60000, end: 90000 } };
  const p = fakePlayer({ "spotify:track:t1": 200000, "spotify:track:t2": 200000 });
  const items = planPhase(tracks, 5 * MIN, { shuffle: false, smartFit: false, trims });
  const r = new SessionRunner(p, [{ name: "A", budget: 5 * MIN, pool: tracks, items }], { trims, shuffle: false, smartFit: false });
  r.start();
  r.tick(200); // switch detected -> seek to trim start
  assert.equal(p.pos, 60000);
  simulate(r, p, 31000);
  assert.equal(p.uri, "spotify:track:t2", "trimmed end reached -> next song");
  p.next(); // user hits next: Spotify plays something unrelated
  r.tick(200);
  assert.equal(p.uri, "spotify:track:t1", "runner takes back control with the next planned song");
});

test("SessionRunner does not count paused time", () => {
  const tracks = [track(1, 600)];
  const p = fakePlayer({ "spotify:track:t1": 600000 });
  const r = new SessionRunner(p, [{ name: "A", budget: MIN, pool: tracks, items: planPhase(tracks, MIN) }]);
  r.start();
  simulate(r, p, 30000);
  p.pause();
  simulate(r, p, 5 * MIN);
  assert.equal(r.active, true);
  p.playing = true;
  simulate(r, p, 31000);
  assert.equal(r.active, false);
});

test("TrimWatcher seeks to start and skips at end", () => {
  const trims = { "spotify:track:t1": { start: 20000, end: 40000 } };
  const p = fakePlayer({});
  const w = new TrimWatcher(p, () => trims);
  p.play("spotify:track:t1");
  w.tick();
  assert.equal(p.pos, 20000);
  p.pos = 40100;
  w.tick();
  assert.equal(p.uri, "spotify:track:autoplay");
});

// --- phone (Web API) mode: Spotify gets the whole plan and plays on by itself ----
function queueingPlayer(durations) {
  const p = fakePlayer(durations);
  p.playsUpcoming = true;
  p.queue = [];
  p.play = function (uri, start, upcoming) {
    this.queue = [uri, ...(upcoming || [])];
    this.uri = uri;
    this.pos = start || 0;
    this.playing = true;
    this.log.push(uri);
  };
  p.getVolume = () => null; // iPhone: no remote volume
  p.advance = function (dt) {
    if (!this.playing) return;
    this.pos += dt;
    if (this.pos >= (durations[this.uri] ?? 200000)) {
      const i = this.queue.indexOf(this.uri);
      this.uri = this.queue[i + 1] || "spotify:track:autoplay";
      this.pos = 0;
    }
  };
  return p;
}

test("phone mode: plays the plan from start positions, lets Spotify roll over natural ends", () => {
  const tracks = [track(1, 100), track(2, 100), track(3, 100)];
  const trims = { "spotify:track:t2": { start: 20000 } };
  const p = queueingPlayer(Object.fromEntries(tracks.map((t) => [t.uri, t.duration])));
  const items = planPhase(tracks, 5 * MIN, { shuffle: false, smartFit: false, trims });
  const r = new SessionRunner(p, [{ name: "A", budget: 5 * MIN, pool: tracks, items }], { trims });
  r.start();
  assert.deepEqual(p.queue.slice(0, 3), ["spotify:track:t1", "spotify:track:t2", "spotify:track:t3"]);
  simulate(r, p, 101000);
  assert.equal(p.uri, "spotify:track:t2");
  // t2 starts at a trim point, so the runner hands over itself (no intro heard)...
  assert.deepEqual(p.log, ["spotify:track:t1", "spotify:track:t2"]);
  assert.ok(p.pos >= 20000, "t2 starts at its trimmed start");
  // ...while the untrimmed t2 -> t3 change is left to Spotify (keeps its crossfade).
  simulate(r, p, 81000);
  assert.equal(p.uri, "spotify:track:t3");
  assert.equal(p.log.length, 2, "no play() call at a natural song change");
  simulate(r, p, 6 * MIN);
  assert.equal(r.active, false);
  assert.equal(p.playing, false);
});

test("phone mode: re-syncs after the controller was suspended across a phase boundary", () => {
  const a = [track(1, 60), track(2, 60)];
  const b = [track(3, 60), track(4, 60), track(5, 60)];
  const p = queueingPlayer(Object.fromEntries([...a, ...b].map((t) => [t.uri, t.duration])));
  const phases = [
    { name: "A", budget: 2 * MIN, pool: a, items: planPhase(a, 2 * MIN, { shuffle: false }) },
    { name: "B", budget: 3 * MIN, pool: b, items: planPhase(b, 3 * MIN, { shuffle: false }) },
  ];
  const r = new SessionRunner(p, phases, {});
  r.start();
  r.tick(200);
  // Phone locked: Spotify plays on for 2.5 minutes without the controller running.
  for (let t = 0; t < 150000; t += 200) p.advance(200);
  assert.equal(p.uri, "spotify:track:t3");
  r.tick(150000);
  assert.equal(r.phaseIdx, 1);
  assert.ok(Math.abs(r.phaseElapsed - 30000) < 1000, `phaseElapsed ${r.phaseElapsed}`);
  simulate(r, p, 4 * MIN);
  assert.equal(r.active, false);
});

// --- smooth transitions ----------------------------------------------------------
const { planPhaseSmooth, planSession } = core;

function lcg(seed) {
  let x = seed;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
const randomTracks = (rng, n, prefix) => Array.from({ length: n }, (_, i) => track(`${prefix}${i}`, 150 + Math.floor(rng() * 150)));

test("smooth planning ends phases on song boundaries close to the target", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rng = lcg(seed);
    const tracks = randomTracks(rng, 25, "s");
    for (const target of [6 * MIN, 36 * MIN, 8 * MIN]) {
      const items = planPhaseSmooth(tracks, target, { rng });
      const total = items.reduce((a, i) => a + i.length, 0);
      assert.ok(Math.abs(total - target) <= Math.max(15000, Math.min(60000, target * 0.12)), `seed ${seed}: ${total} vs ${target}`);
      for (let i = 1; i < items.length; i++) assert.notEqual(items[i].uri, items[i - 1].uri);
    }
  }
});

test("planSession smooth carries drift so the whole session stays on time", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const rng = lcg(seed);
    const defs = [
      { name: "Warm-up", pool: randomTracks(rng, 8, "w"), budget: 6 * MIN },
      { name: "Normal", pool: randomTracks(rng, 30, "n"), budget: 36 * MIN },
      { name: "Cool-down", pool: randomTracks(rng, 8, "c"), budget: 8 * MIN },
    ];
    const phases = planSession(defs, { mode: "smooth", rng });
    const total = phases.reduce((a, p) => a + p.budget, 0);
    assert.ok(Math.abs(total - 50 * MIN) <= 60000, `seed ${seed}: session ${total / 1000}s`);
    for (const p of phases) assert.equal(p.budget, p.items.reduce((a, i) => a + i.length, 0));
  }
});

test("smooth session on a phone: Spotify plays it all by itself, then it stops", () => {
  const a = [track(1, 120), track(2, 120), track(3, 120)];
  const b = [track(4, 180), track(5, 180)];
  const durations = Object.fromEntries([...a, ...b].map((t) => [t.uri, t.duration]));
  const p = queueingPlayer(durations);
  const phases = planSession([{ name: "A", pool: a, budget: 4 * MIN }, { name: "B", pool: b, budget: 6 * MIN }], { mode: "smooth", shuffle: false });
  const r = new SessionRunner(p, phases, { smooth: true, crossfadeMs: 2000 });
  r.start();
  const events = [];
  r.opts.onEvent = (type) => events.push(type);
  simulate(r, p, 11 * MIN);
  assert.equal(r.active, false);
  assert.equal(p.playing, false, "paused at the end, not playing autoplay");
  assert.equal(p.log.length, 1, "one play() for the whole session: every change was a natural one");
  assert.ok(!p.log.includes("spotify:track:autoplay"));
  assert.ok(events.includes("phase") && events.includes("finish"));
});

test("smooth session works even if the controller sleeps through it", () => {
  const a = [track(1, 120), track(2, 120)];
  const b = [track(3, 180), track(4, 180)];
  const p = queueingPlayer(Object.fromEntries([...a, ...b].map((t) => [t.uri, t.duration])));
  const phases = planSession([{ name: "A", pool: a, budget: 4 * MIN }, { name: "B", pool: b, budget: 6 * MIN }], { mode: "smooth", shuffle: false });
  const r = new SessionRunner(p, phases, { smooth: true });
  r.start();
  r.tick(200);
  for (let t = 0; t < 5 * MIN; t += 200) p.advance(200); // phone locked for 5 minutes
  r.tick(5 * MIN);
  assert.equal(r.phaseIdx, 1);
  const st = r.status();
  assert.ok(Math.abs(st.totalLeft - 5 * MIN) < 2000, `left ${st.totalLeft}`);
});

test("volume is restored only after the next song has started", () => {
  const tracks = [track(1, 100), track(2, 100)];
  const trims = { "spotify:track:t1": { start: 0, end: 60000 } };
  const p = fakePlayer({ "spotify:track:t1": 100000, "spotify:track:t2": 100000 });
  const volumes = [];
  p.setVolume = function (v) { this.volume = v; volumes.push([this.uri, Math.round(v * 100)]); };
  const items = planPhase(tracks, 3 * MIN, { shuffle: false, smartFit: false, trims });
  const r = new SessionRunner(p, [{ name: "A", budget: 3 * MIN, pool: tracks, items }], { trims, fadeMs: 3000 });
  r.start();
  simulate(r, p, 62000);
  const restoreAt = volumes.findIndex(([, v]) => v === 100);
  assert.ok(restoreAt > 0, "faded, then restored");
  assert.equal(volumes[restoreAt][0], "spotify:track:t2", "restored while the new song plays");
  assert.ok(volumes.slice(0, restoreAt).every(([u]) => u === "spotify:track:t1"));
});

test("snapshot/restore continues a session where Spotify is", () => {
  const a = [track(1, 120), track(2, 120)];
  const p = queueingPlayer(Object.fromEntries(a.map((t) => [t.uri, t.duration])));
  const phases = planSession([{ name: "A", pool: a, budget: 4 * MIN }], { mode: "smooth", shuffle: false });
  const r1 = new SessionRunner(p, phases, { smooth: true });
  r1.start();
  r1.tick(200);
  const snap = JSON.parse(JSON.stringify(r1.snapshot()));
  for (let t = 0; t < 150000; t += 200) p.advance(200); // app closed; Spotify moved to song 2
  const r2 = SessionRunner.restore(p, snap);
  r2.tick(200);
  assert.equal(r2.itemIdx, 1);
  simulate(r2, p, 3 * MIN);
  assert.equal(r2.active, false);
});
