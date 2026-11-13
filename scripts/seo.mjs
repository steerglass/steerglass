#!/usr/bin/env node
// Search-engine housekeeping for the website, run by deploy-site.sh.
//
//   node scripts/seo.mjs            writes website/sitemap.xml (lastmod from git), sets the app version in the
//                                   landing's structured data, and prints the URLs that changed since the live sitemap
//   node scripts/seo.mjs --ping URL… tells IndexNow (Bing, Yandex, Seznam…) about those URLs, once they're live
//
// Google reads the sitemap (listed in robots.txt and Search Console); it doesn't use IndexNow.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SITE = "https://steerglass.com";
const INDEXNOW_KEY = "cd4005ba3bbda2c3413f02bee415dd66"; // also served as website/<key>.txt
const root = new URL("../website/", import.meta.url).pathname;

// Public pages and the files their content comes from.
const PAGES = [
  { path: "/", files: ["index.html"], priority: "1.0" },
  { path: "/install/", files: ["install/index.html"], priority: "0.8" },
  { path: "/changelog/", files: ["changelog/index.html", "changelog.json"], priority: "0.6" },
  { path: "/compare/", files: ["compare/index.html"], priority: "0.5" },
  { path: "/compare/lens/", files: ["compare/lens/index.html"], priority: "0.6" },
  { path: "/compare/k9s/", files: ["compare/k9s/index.html"], priority: "0.6" },
  { path: "/compare/headlamp/", files: ["compare/headlamp/index.html"], priority: "0.6" },
  { path: "/privacy/", files: ["privacy/index.html"], priority: "0.3" },
  { path: "/security/", files: ["security/index.html"], priority: "0.3" },
];

const args = process.argv.slice(2);
if (args[0] === "--ping") {
  const urls = args.slice(1);
  if (!urls.length) process.exit(0);
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: new URL(SITE).host, key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList: urls }),
  });
  console.error(`IndexNow: ${res.status} for ${urls.join(", ")}`);
  process.exit(0);
}

/** Last change of a file: its last commit, or now when it has uncommitted changes. */
function lastChange(file) {
  const rel = `website/${file}`;
  const dirty = execFileSync("git", ["status", "--porcelain", "--", rel], { encoding: "utf8" }).trim();
  const committed = execFileSync("git", ["log", "-1", "--format=%cI", "--", rel], { encoding: "utf8" }).trim();
  return dirty || !committed ? new Date() : new Date(committed);
}

const entries = PAGES.map((p) => ({ ...p, lastmod: new Date(Math.max(...p.files.map((f) => lastChange(f).getTime()))).toISOString().slice(0, 10) }));
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <url><loc>${SITE}${e.path}</loc><lastmod>${e.lastmod}</lastmod><priority>${e.priority}</priority></url>`).join("\n")}
</urlset>
`;
writeFileSync(`${root}sitemap.xml`, xml);

const version = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url))).version;
const landing = `${root}index.html`;
writeFileSync(landing, readFileSync(landing, "utf8").replace(/"softwareVersion": "[^"]*"/, `"softwareVersion": "${version}"`));

// The changelog is pre-rendered into its page for crawlers that don't run JavaScript (the page script
// re-renders it the same way). Notes of a version not yet published are left out, as the page does.
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cmp = (a, b) => a.split(".").map(Number).reduce((r, x, i) => r || x - (b.split(".").map(Number)[i] ?? 0), 0);
let published = version;
try {
  published = (await (await fetch(`${SITE}/updates/latest.json`, { cache: "no-store" })).json()).version;
} catch {
  // offline: assume the current version is out
}
const notes = JSON.parse(readFileSync(`${root}changelog.json`, "utf8")).filter((e) => cmp(e.version, published) <= 0);
const fmt = (d) => new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const rendered = notes.map((e) => `<article class="entry" id="v${e.version}"><div class="when"><span class="v">${e.version}</span><span class="faint small">${fmt(e.date)}</span></div><div><h2>${esc(e.title)}</h2><ul>${e.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div></article>`).join("");
const changelogPage = `${root}changelog/index.html`;
writeFileSync(changelogPage, readFileSync(changelogPage, "utf8").replace(/<!-- changelog -->[\s\S]*?<!-- \/changelog -->/, () => `<!-- changelog -->${rendered}<!-- /changelog -->`));

// Changed pages: lastmod differs from the sitemap that is live now.
let live = "";
try {
  live = await (await fetch(`${SITE}/sitemap.xml`, { cache: "no-store" })).text();
} catch {
  // first deploy
}
const changed = entries.filter((e) => !live.includes(`<loc>${SITE}${e.path}</loc><lastmod>${e.lastmod}</lastmod>`));
console.log(changed.map((e) => SITE + e.path).join(" "));
