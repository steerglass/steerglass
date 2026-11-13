#!/usr/bin/env node
// Adds a content hash to the shared assets' URLs in the website pages (/portal.js?v=…, /portal.css?v=…),
// so Cloudflare and browsers (which cache them for hours) always get the version the page was written for.
// Run before deploying the website.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../website/", import.meta.url).pathname;
const assets = ["portal.js", "portal.css"];
const hash = Object.fromEntries(assets.map((a) => [a, createHash("sha256").update(readFileSync(join(root, a))).digest("hex").slice(0, 10)]));

const pages = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? pages(p) : p.endsWith(".html") ? [p] : [];
});

let changed = 0;
for (const page of pages(root)) {
  const before = readFileSync(page, "utf8");
  let after = before;
  for (const a of assets) after = after.replace(new RegExp(`/${a.replace(".", "\\.")}(\\?v=[0-9a-f]+)?"`, "g"), `/${a}?v=${hash[a]}"`);
  if (after !== before) {
    writeFileSync(page, after);
    changed++;
  }
}
console.log(`assets: ${assets.map((a) => `${a}?v=${hash[a]}`).join(", ")} · ${changed} page(s) updated`);
