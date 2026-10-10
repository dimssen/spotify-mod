// Builds the phone web app into _site/ (or the directory given as the first argument).
//
// - core.<hash>.js: only the shared core of playlist-plus.js (the desktop extension's UI
//   is left out; the phone never uses it)
// - app.<hash>.js:  web/app.js
// - index.html:     inline CSS minified, script names filled in
// JS and CSS are minified with esbuild. File names carry a content hash, so a new version
// is picked up at once even though GitHub Pages lets browsers cache files for 10 minutes.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");

const CORE_END = "\n// ---------------------------------------------------------------------------\n// Spicetify integration + UI";

function build(outDir = path.join(root, "_site")) {
  const out = path.resolve(outDir);
  const ext = fs.readFileSync(path.join(root, "playlist-plus.js"), "utf8");
  const cut = ext.indexOf(CORE_END);
  if (cut < 0) throw new Error("build-web: couldn't find where the core ends in playlist-plus.js");
  const core = ext.slice(0, cut);

  const minifyJs = (code, name) => esbuild.transformSync(code, { loader: "js", minify: true, legalComments: "none", sourcefile: name }).code;
  const minifyCss = (code) => esbuild.transformSync(code, { loader: "css", minify: true }).code.trim();
  const hashed = (name, code) => `${name}.${crypto.createHash("sha256").update(code).digest("hex").slice(0, 10)}.js`;

  const coreJs = minifyJs(core, "core.js");
  const appJs = minifyJs(fs.readFileSync(path.join(root, "web", "app.js"), "utf8"), "app.js");
  const coreName = hashed("core", coreJs);
  const appName = hashed("app", appJs);

  let html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
  html = html.replace(/<style>([\s\S]*?)<\/style>/, (_, css) => `<style>${minifyCss(css)}</style>`);
  const scripts = '<script src="core.js" defer></script>\n  <script src="app.js" defer></script>';
  if (!html.includes(scripts)) throw new Error("build-web: index.html script tags changed; update the build");
  html = html.replace(scripts, `<script src="${coreName}" defer></script>\n  <script src="${appName}" defer></script>`);

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(path.join(root, "web"))) {
    if (f === "app.js" || f === "index.html") continue;
    fs.copyFileSync(path.join(root, "web", f), path.join(out, f));
  }
  fs.writeFileSync(path.join(out, coreName), coreJs);
  fs.writeFileSync(path.join(out, appName), appJs);
  fs.writeFileSync(path.join(out, "index.html"), html);
  return { out, coreName, appName };
}

if (require.main === module) {
  const r = build(process.argv[2]);
  console.log(`Built ${path.relative(root, r.out) || r.out}/ (${r.coreName}, ${r.appName})`);
}
module.exports = { build };
