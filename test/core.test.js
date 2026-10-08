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
  const items = planPhase(tracks, 120000, { shuffle: false, smartFit: true });
  assert.equal(items[0].uri, "spotify:track:t2");
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
  assert.deepEqual(events.filter((e) => e[0] !== "track"), [["phase", 1], ["phase", 2], ["finish", 3]]);
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
