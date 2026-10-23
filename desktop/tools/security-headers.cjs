// Preview and regression tests use the same rules deployed by Cloudflare Pages.
"use strict";
const fs = require("fs"), path = require("path");
const rules = [];
for (const line of fs.readFileSync(path.join(__dirname, "../ui/_headers"), "utf8").split(/\r?\n/)) {
  if (line.startsWith("/")) rules.push({ pattern: new RegExp("^" + line.trim().split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"), headers: {} });
  else if (/^\s+\S/.test(line)) {
    const at = line.indexOf(":"); if (at > 0 && rules.length) rules[rules.length - 1].headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
}
function headersFor(urlPath) { return Object.assign({}, ...rules.filter(r => r.pattern.test(urlPath)).map(r => r.headers)); }
module.exports = { headersFor };
