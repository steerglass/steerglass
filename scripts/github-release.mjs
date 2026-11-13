#!/usr/bin/env node
// Creates the GitHub Release of a version (github.com/steerglass/steerglass/releases) with the
// installers attached, the same files published on steerglass.com. Installed copies keep updating
// from steerglass.com: the GitHub Release is for people who browse the repository.
//
// publish-release.mjs calls it after every publish. macOS and Windows/Linux are published
// separately, so it can run more than once for a version: the release is created the first time,
// later runs only add the files it doesn't have yet (and refresh sha256sums.txt).
//
//   node scripts/github-release.mjs <version> <file>...
//
// Uses the GitHub CLI (gh), signed in with write access to the repository. The tag v<version> must
// already be on GitHub.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "steerglass/steerglass";
const SITE = "https://steerglass.com";
const SUMS = "sha256sums.txt";

const gh = (...args) => execFileSync("gh", ["-R", REPO, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The release notes: the changelog entry of the version, then how to install. */
export function releaseNotes(version) {
  const entry = JSON.parse(readFileSync(new URL("../website/changelog.json", import.meta.url))).find((e) => e.version === version);
  const items = entry ? entry.items.map((i) => `- ${i}`).join("\n") : "";
  return `${items}

## Install

- **macOS** 11+: \`brew install --cask davidebettio/tap/steerglass\`, or the \`.dmg\` below (Apple Silicon and Intel, signed and notarized).
- **Windows** 10+: the \`-setup.exe\` or the \`.msi\` below.
- **Linux**: the [apt and dnf repositories](${SITE}/install/#linux), or the \`.deb\`, \`.rpm\` or AppImage below (x86_64 and arm64).

Installed copies update themselves from steerglass.com, and every update is signed. Every download, with checksums: ${SITE}/install/
`;
}

export function githubRelease(version, files) {
  const tag = `v${version}`;
  const dir = mkdtempSync(join(tmpdir(), "steerglass-gh-release-"));
  let assets = [];
  try {
    assets = JSON.parse(gh("release", "view", tag, "--json", "assets")).assets.map((a) => a.name);
  } catch {
    const entry = JSON.parse(readFileSync(new URL("../website/changelog.json", import.meta.url))).find((e) => e.version === version);
    const notesFile = join(dir, "notes.md");
    writeFileSync(notesFile, releaseNotes(version));
    gh("release", "create", tag, "--verify-tag", "--title", `Steerglass ${version}${entry ? `: ${entry.title}` : ""}`, "--notes-file", notesFile);
    console.log(`GitHub Release ${tag} created`);
  }

  // Never replace a file already attached: a published file stays as it is, like on steerglass.com.
  const added = files.filter((f) => !assets.includes(basename(f)));
  if (!added.length) {
    console.log(`GitHub Release ${tag}: every file is already attached`);
    return;
  }
  const sums = new Map();
  if (assets.includes(SUMS)) {
    gh("release", "download", tag, "--pattern", SUMS, "--dir", dir);
    for (const [, h, f] of readFileSync(join(dir, SUMS), "utf8").matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)) sums.set(f, h);
  }
  for (const f of added) sums.set(basename(f), createHash("sha256").update(readFileSync(f)).digest("hex"));
  writeFileSync(join(dir, SUMS), [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([f, h]) => `${h}  ${f}`).join("\n") + "\n");
  gh("release", "upload", tag, ...added);
  gh("release", "upload", tag, "--clobber", join(dir, SUMS));
  console.log(`GitHub Release ${tag}: attached ${added.map((f) => basename(f)).join(", ")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, ...files] = process.argv.slice(2);
  if (!version || !files.length) {
    console.error("usage: github-release.mjs <version> <file>...");
    process.exit(1);
  }
  githubRelease(version, files);
}
