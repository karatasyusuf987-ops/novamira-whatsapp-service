// Patches whatsapp-web.js after npm install so it doesn't crash when
// WhatsApp Web removes/renames `canCheckStatusRankingPosterGating` (Jan 2026
// upstream change that breaks every `client.sendMessage` call).
//
// The function is only used when sending Status/Story posts; normal text
// messages never need its result, but the line runs unconditionally and
// throws inside the evaluate() context. We wrap it in a try-catch.
//
// Runs automatically via `postinstall` hook in package.json.

const fs = require("fs");
const path = require("path");

const target = path.join(
  __dirname,
  "node_modules",
  "whatsapp-web.js",
  "src",
  "util",
  "Injected",
  "Utils.js",
);

if (!fs.existsSync(target)) {
  console.log("[patch-wwebjs] Utils.js not found, skipping patch");
  process.exit(0);
}

let src = fs.readFileSync(target, "utf8");

const BROKEN = `cannotBeRanked: window
                        .require('WAWebStatusGatingUtils')
                        .canCheckStatusRankingPosterGating(),`;

const FIXED = `cannotBeRanked: (() => {
                        try {
                            return window
                                .require('WAWebStatusGatingUtils')
                                .canCheckStatusRankingPosterGating();
                        } catch (e) {
                            return false;
                        }
                    })(),`;

if (src.includes(BROKEN)) {
  src = src.replace(BROKEN, FIXED);
  fs.writeFileSync(target, src);
  console.log("[patch-wwebjs] Utils.js patched (canCheckStatusRankingPosterGating wrapped in try/catch)");
} else if (src.includes("canCheckStatusRankingPosterGating") && src.includes("try {")) {
  console.log("[patch-wwebjs] Utils.js already patched");
} else {
  console.log("[patch-wwebjs] Utils.js doesn't match expected pattern — skipping (upstream may have already fixed it)");
}
