#!/usr/bin/env node
// Publishes a release to steerglass.com: installers, updater bundles and the updates/latest.json
// that running copies of Steerglass poll.
//
// Usage: node scripts/publish-release.mjs [--notes "What's new"] [--dry-run] <artifact dir or file>...
//
// Pass the bundle folders of the builds (e.g. src-tauri/target/universal-apple-darwin/release/bundle)
// and/or folders with the Windows/Linux artifacts downloaded from CI. Every updater bundle must have
// its .sig next to it (created by `tauri build` when TAURI_SIGNING_PRIVATE_KEY is set).
//
// Layout on the server (the folder STEERGLASS_REMOTE points to, see remote.mjs):
//   releases/<version>/...   every file of that version, immutable
//   download/...             stable names linked from the landing page
//   releases/<version>/sha256sums.txt, download/sha256sums.txt   SHA-256 of every file, shown on /install
// Every published file name is lowercase.
//   apt/, rpm/               the signed Linux repositories (see linux-repos.mjs)
//   updates/latest.json      written last, so clients never see a manifest before its files
// Then the Homebrew cask and the GitHub Release (github-release.mjs) get the new version.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLinuxRepos, uploadLinuxRepos } from "./linux-repos.mjs";
import { updateHomebrewCask } from "./homebrew-cask.mjs";
import { githubRelease } from "./github-release.mjs";
import { remote } from "./remote.mjs";

const SITE = "https://steerglass.com";
const REMOTE = remote();

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const dryRun = args.includes("--dry-run") && args.splice(args.indexOf("--dry-run"), 1);
const notes = flag("--notes") ?? "";
if (!args.length) {
  console.error("usage: publish-release.mjs [--notes text] [--dry-run] <artifact dir or file>...");
  process.exit(1);
}

const version = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url))).version;
// Without --notes, the release notes come from the changelog (website/changelog.json), like the app's "What's new".
const changelogEntry = JSON.parse(readFileSync(new URL("../website/changelog.json", import.meta.url))).find((e) => e.version === version);
const releaseNotes = notes || (changelogEntry ? [changelogEntry.title, ...changelogEntry.items.map((i) => `• ${i}`)].join("\n") : "");

const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : [p]);
let files = args.flatMap(walk).filter((f) => !f.endsWith(".sig"));

const arch = (name) => (/aarch64|arm64/i.test(name) ? "aarch64" : /universal/i.test(name) ? "universal" : "x86_64");

/** What each artifact is: an updater bundle for some platforms, and/or a stable download name. */
function classify(file) {
  const name = basename(file);
  const a = arch(file);
  if (name.endsWith(".app.tar.gz")) {
    return { updater: a === "universal" ? ["darwin-aarch64", "darwin-x86_64"] : [`darwin-${a}`] };
  }
  if (name.endsWith(".dmg")) return { download: a === "universal" ? "steerglass-mac.dmg" : `steerglass-mac-${a}.dmg` };
  if (/-setup\.exe$/.test(name)) {
    return { updater: [`windows-${a}`], download: a === "x86_64" ? "steerglass-windows-setup.exe" : `steerglass-windows-${a}-setup.exe` };
  }
  if (name.endsWith(".msi")) return { download: `steerglass-windows-${a}.msi` };
  if (name.endsWith(".AppImage")) return { updater: [`linux-${a}`], download: `steerglass-linux-${a}.appimage` };
  // Copies installed from a .deb/.rpm update with that package (the updater looks for linux-<arch>-deb/rpm first).
  if (name.endsWith(".deb")) return { updater: [`linux-${a}-deb`], download: `steerglass-linux-${a}.deb` };
  if (name.endsWith(".rpm")) return { updater: [`linux-${a}-rpm`], download: `steerglass-linux-${a}.rpm` };
  return null;
}

const stage = mkdtempSync(join(tmpdir(), "steerglass-release-"));

// The apt/dnf repositories; every download of an .rpm is the copy signed for the dnf repository.
const repos = join(stage, "repos");
if (files.some((f) => /\.(deb|rpm)$/.test(f))) {
  mkdirSync(repos);
  const signed = buildLinuxRepos(files, repos);
  files = files.map((f) => (f.endsWith(".rpm") ? signed.get(basename(f).toLowerCase()) : f));
}

// tauri build only signs the AppImage on Linux: the packages are signed for the updater here.
const UPDATER_KEY = fileURLToPath(new URL("../.secrets/updater.key", import.meta.url));
for (const f of files.filter((f) => /\.(deb|rpm)$/.test(f) && !existsSync(`${f}.sig`))) {
  execFileSync("pnpm", ["-s", "tauri", "signer", "sign", "-f", UPDATER_KEY, "-p", "", f], { stdio: ["ignore", "ignore", "inherit"] });
}
const releaseDir = join(stage, "releases", version);
const downloadDir = join(stage, "download");
mkdirSync(releaseDir, { recursive: true });
mkdirSync(downloadDir, { recursive: true });

const platforms = {};
const downloads = [];
for (const file of files) {
  const kind = classify(file);
  if (!kind) continue;
  const name = basename(file).toLowerCase();
  copyFileSync(file, join(releaseDir, name));
  if (kind.download) {
    copyFileSync(file, join(downloadDir, kind.download));
    downloads.push(kind.download);
  }
  for (const platform of kind.updater ?? []) {
    let signature;
    try {
      signature = readFileSync(`${file}.sig`, "utf8").trim();
    } catch {
      console.error(`missing ${file}.sig: build with TAURI_SIGNING_PRIVATE_KEY set`);
      process.exit(1);
    }
    platforms[platform] = { signature, url: `${SITE}/releases/${version}/${encodeURIComponent(name)}` };
  }
}
if (!Object.keys(platforms).length) {
  console.error("no updater bundles found (.app.tar.gz, -setup.exe, .AppImage)");
  process.exit(1);
}

// Platforms can be published separately (macOS from a Mac, Windows/Linux from CI): when the live
// manifest is for the same version, the platforms already there are kept.
let live = null;
try {
  const res = await fetch(`${SITE}/updates/latest.json`, { cache: "no-store" });
  if (res.ok) live = await res.json();
} catch {
  // nothing published yet
}
const cmp = (a, b) => a.split(".").map(Number).reduce((r, x, i) => r || x - (b.split(".").map(Number)[i] ?? 0), 0);
if (live && cmp(live.version, version) > 0) {
  console.error(`steerglass.com already offers ${live.version}, newer than ${version}`);
  process.exit(1);
}
const sameVersion = live?.version === version;
for (const platform of Object.keys(platforms)) {
  if (sameVersion && live.platforms?.[platform]) {
    console.error(`${platform} is already published for ${version}: bump the version in src-tauri/tauri.conf.json`);
    process.exit(1);
  }
}
const manifest = {
  version,
  notes: releaseNotes || (sameVersion ? live.notes : ""),
  pub_date: sameVersion ? live.pub_date : new Date().toISOString(),
  platforms: { ...(sameVersion ? live.platforms : {}), ...platforms },
};
// Checksums, in the format of `sha256sum -c`. The release folder is immutable, so its list is only
// written by the first publish of a version; the list for download/ keeps the entries of the
// platforms not rebuilt this time.
const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const sumsOf = (dir) => new Map(readdirSync(dir).filter((f) => f !== "sha256sums.txt").map((f) => [f, sha256(join(dir, f))]));
const sumsText = (sums) => [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([f, h]) => `${h}  ${f}`).join("\n") + "\n";
if (!sameVersion) writeFileSync(join(releaseDir, "sha256sums.txt"), sumsText(sumsOf(releaseDir)));
const downloadSums = new Map();
try {
  const res = await fetch(`${SITE}/download/sha256sums.txt`, { cache: "no-store" });
  if (res.ok) for (const [, h, f] of (await res.text()).matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)) downloadSums.set(f, h);
} catch {
  // first list
}
for (const [f, h] of sumsOf(downloadDir)) downloadSums.set(f, h);
writeFileSync(join(downloadDir, "sha256sums.txt"), sumsText(downloadSums));

mkdirSync(join(stage, "updates"));
writeFileSync(join(stage, "updates", "latest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`Steerglass ${version}`);
console.log(`  updater: ${Object.keys(platforms).join(", ")}${sameVersion ? ` (added to ${Object.keys(live.platforms).join(", ")})` : ""}`);
console.log(`  downloads: ${downloads.join(", ") || "(none)"}`);
console.log(`  staged in ${stage}`);
if (dryRun) process.exit(0);

// One SSH connection for every transfer: some servers reset quick successive connections.
const ssh = `ssh -o ControlMaster=auto -o ControlPath=${join(stage, "ssh.sock")} -o ControlPersist=60`;
// A published file is cached for a year by Cloudflare and clients: never overwrite one, bump the version.
let existing = "";
try {
  existing = execFileSync("rsync", ["--list-only", "-e", ssh, `${REMOTE}/releases/${version}/`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch {
  // not published yet
}
const published = new Set(existing.split("\n").map((l) => l.trim().split(/\s+/).pop()));
const clash = readdirSync(releaseDir).filter((f) => published.has(f));
if (clash.length) {
  console.error(`already on the server in releases/${version}: ${clash.join(", ")}. Bump the version in src-tauri/tauri.conf.json`);
  process.exit(1);
}

// macOS' rsync has no --chmod: make the staged files world-readable instead (-a keeps the permissions).
execFileSync("chmod", ["-R", "u=rwX,go=rX", stage]);
const rsync = (...a) => execFileSync("rsync", ["-av", "-e", ssh, ...a], { stdio: "inherit" });
rsync(`${stage}/releases/`, `${REMOTE}/releases/`);
// Only the platforms built this time are replaced; the others keep their previous download.
rsync(`${stage}/download/`, `${REMOTE}/download/`);
uploadLinuxRepos(repos, (...a) => rsync(...a.slice(0, -1), `${REMOTE}/${a.at(-1)}`));
rsync(`${stage}/updates/latest.json`, `${REMOTE}/updates/latest.json`);
console.log(`Published: ${SITE}/updates/latest.json`);

// Homebrew: `brew install --cask davidebettio/tap/steerglass`. The cask points at the immutable release
// file, so it can only be updated once that is online. A failure here doesn't undo the release.
const dmg = readdirSync(releaseDir).find((f) => f.endsWith("_universal.dmg"));
if (dmg) {
  try {
    updateHomebrewCask(version, sha256(join(releaseDir, dmg)), dmg);
  } catch (e) {
    console.error(`Homebrew cask not updated (${e.message.split("\n")[0]}): run it again later with`);
    console.error(`  node scripts/homebrew-cask.mjs ${version}`);
  }
}

// The GitHub Release gets the installers too (not the updater-only .app.tar.gz). A failure here
// doesn't undo the release either.
const installers = readdirSync(releaseDir).filter((f) => /\.(dmg|exe|msi|appimage|deb|rpm)$/.test(f));
try {
  githubRelease(version, installers.map((f) => join(releaseDir, f)));
} catch (e) {
  console.error(`GitHub Release not updated (${e.message.split("\n")[0]}): run it again later with`);
  console.error(`  node scripts/github-release.mjs ${version} <installers>`);
}
