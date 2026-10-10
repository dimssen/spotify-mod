const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { build } = require("../scripts/build-web.js");

test("web build: minified, hashed files that index.html references, core only", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "pp-build-"));
  try {
    const { coreName, appName } = build(out);
    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");

    // Every local file the page references exists.
    const refs = [...html.matchAll(/(?:src|href)="([^":]+?)"/g)].map((m) => m[1]);
    assert.ok(refs.includes(coreName) && refs.includes(appName));
    for (const r of refs) assert.ok(fs.existsSync(path.join(out, r)), `missing ${r}`);
    // Scripts never block rendering.
    for (const tag of html.match(/<script[^>]*src=[^>]*>/g)) assert.match(tag, /\bdefer\b/);

    // The core has the shared logic but none of the desktop extension's UI.
    const core = fs.readFileSync(path.join(out, coreName), "utf8");
    assert.ok(!core.includes("Spicetify.Topbar") && !core.includes("ContextMenu"));
    const sandbox = { window: {} };
    vm.runInNewContext(core, sandbox);
    const api = sandbox.window.PlaylistPlusCore;
    for (const fn of ["planSession", "SessionRunner", "TrimWatcher", "SyncStore", "afterSessionQueue", "computeBudgets"]) assert.equal(typeof api[fn], "function", fn);
    // It still plans a session after minification.
    const tracks = Array.from({ length: 10 }, (_, i) => ({ uri: `spotify:track:${i}`, name: `S${i}`, duration: 200000 }));
    const plan = api.planSession([{ name: "A", pool: tracks, budget: 600000 }], { mode: "smooth" });
    assert.ok(plan[0].items.length >= 2);

    // The app script is valid JavaScript, and the CSS was minified.
    new vm.Script(fs.readFileSync(path.join(out, appName), "utf8"));
    assert.ok(!/\n\s+\.btn \{/.test(html), "CSS should be minified");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
