// Assembles the phone web app into _site/ (the shared core comes from playlist-plus.js).
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "_site");
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, "web"), out, { recursive: true });
fs.copyFileSync(path.join(root, "playlist-plus.js"), path.join(out, "playlist-plus.js"));
console.log(`Built ${path.relative(root, out)}/`);
