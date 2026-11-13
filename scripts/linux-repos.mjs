#!/usr/bin/env node
// Builds the signed apt and dnf repositories served from steerglass.com/apt and steerglass.com/rpm.
// publish-release.mjs calls it for every release with .deb/.rpm files; it can also be run on its own
// to (re)publish the repositories for packages already released:
//
//   node scripts/linux-repos.mjs [--dry-run] <.deb/.rpm files or folders>...
//
// The indexes only list the packages passed in (the latest version): package managers only need that.
// The tools run in Docker (Debian for apt-ftparchive, Fedora for rpmsign/createrepo_c), signing with
// .secrets/repo-signing.key, whose public half is website/keys/steerglass.{asc,gpg}.
//
// Layout on the server (the folder STEERGLASS_REMOTE points to, see remote.mjs):
//   apt/pool/main/*.deb                packages, never overwritten
//   apt/dists/stable/...               Release, InRelease, Packages: replaced on every publish
//   rpm/packages/*.rpm                 packages (signed with the repository key), never overwritten
//   rpm/repodata/...                   createrepo_c metadata + repomd.xml.asc: replaced
//   rpm/steerglass.repo                the file users drop in /etc/yum.repos.d
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remote as releaseRemote } from "./remote.mjs";

const SITE = "https://steerglass.com";
const KEY = fileURLToPath(new URL("../.secrets/repo-signing.key", import.meta.url));
const DEBIAN = "debian:13-slim";
const FEDORA = "fedora:43";

// Imports the repository key into a throwaway keyring inside the container.
const IMPORT_KEY = 'export GNUPGHOME=$(mktemp -d); gpg --batch --quiet --import /key; FPR=$(gpg --with-colons --list-secret-keys | awk -F: \'/^fpr/{print $10; exit}\')';

const REPO_FILE = `[steerglass]
name=Steerglass
baseurl=${SITE}/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=${SITE}/keys/steerglass.asc
`;

const docker = (image, mounts, script) =>
  execFileSync("docker", ["run", "--rm", ...mounts.flatMap((m) => ["-v", m]), image, "sh", "-euc", script], { stdio: "inherit" });

/**
 * Builds out/apt and out/rpm from the given packages. Returns the signed copy of each .rpm (by its
 * lowercase name): that copy is the one to publish everywhere, so every download carries the signature.
 */
export function buildLinuxRepos(files, out) {
  if (!existsSync(KEY)) throw new Error(`missing ${KEY}: the repository signing key`);
  const debs = files.filter((f) => f.endsWith(".deb"));
  const rpms = files.filter((f) => f.endsWith(".rpm"));
  const input = mkdtempSync(join(tmpdir(), "steerglass-pkgs-"));
  for (const f of [...debs, ...rpms]) copyFileSync(f, join(input, basename(f).toLowerCase()));
  const mounts = [`${KEY}:/key:ro`, `${input}:/in:ro`, `${resolve(out)}:/out`];

  if (debs.length) {
    mkdirSync(join(out, "apt"), { recursive: true });
    docker(DEBIAN, mounts, `
      export DEBIAN_FRONTEND=noninteractive
      apt-get -qq update && apt-get -qq install -y --no-install-recommends apt-utils gnupg >/dev/null
      ${IMPORT_KEY}
      cd /out/apt && mkdir -p pool/main && cp /in/*.deb pool/main/
      for arch in amd64 arm64; do
        d=dists/stable/main/binary-$arch && mkdir -p $d
        apt-ftparchive --arch $arch packages pool > $d/Packages && gzip -9kn $d/Packages
      done
      apt-ftparchive \\
        -o APT::FTPArchive::Release::Origin=Steerglass -o APT::FTPArchive::Release::Label=Steerglass \\
        -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable \\
        -o APT::FTPArchive::Release::Architectures="amd64 arm64" -o APT::FTPArchive::Release::Components=main \\
        -o APT::FTPArchive::Release::Description="Steerglass, the fast multi-cluster Kubernetes desktop app" \\
        release dists/stable > /tmp/Release && mv /tmp/Release dists/stable/Release
      gpg --batch --yes --local-user $FPR --clearsign -o dists/stable/InRelease dists/stable/Release
      gpg --batch --yes --local-user $FPR -abs -o dists/stable/Release.gpg dists/stable/Release
    `);
  }

  const signed = new Map();
  if (rpms.length) {
    mkdirSync(join(out, "rpm"), { recursive: true });
    docker(FEDORA, mounts, `
      dnf -q -y install rpm-sign createrepo_c gnupg2 >/dev/null 2>&1
      ${IMPORT_KEY}
      cd /out/rpm && mkdir -p packages && cp /in/*.rpm packages/
      rpmsign --define "_gpg_name $FPR" --addsign packages/*.rpm >/dev/null
      createrepo_c --quiet --general-compress-type=gz .
      gpg --batch --yes --local-user $FPR --detach-sign --armor repodata/repomd.xml
    `);
    writeFileSync(join(out, "rpm", "steerglass.repo"), REPO_FILE);
    for (const f of readdirSync(join(out, "rpm", "packages"))) signed.set(f, join(out, "rpm", "packages", f));
  }
  return signed;
}

/** Uploads the repositories: packages first, then the indexes that point at them. */
export function uploadLinuxRepos(out, rsync) {
  // The folders first: rsync doesn't create missing parents of its destination.
  for (const repo of ["apt", "rpm"]) if (existsSync(join(out, repo))) rsync("--include=*/", "--exclude=*", join(out, repo), "");
  if (existsSync(join(out, "apt"))) {
    rsync(`${out}/apt/pool/`, "apt/pool/");
    rsync("--delete", `${out}/apt/dists/`, "apt/dists/");
  }
  if (existsSync(join(out, "rpm"))) {
    rsync("--exclude", "*.sig", `${out}/rpm/packages/`, "rpm/packages/");
    rsync("--delete", `${out}/rpm/repodata/`, "rpm/repodata/");
    rsync(`${out}/rpm/steerglass.repo`, "rpm/steerglass.repo");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") && args.splice(args.indexOf("--dry-run"), 1);
  const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : [p]);
  const files = args.flatMap(walk).filter((f) => /\.(deb|rpm)$/.test(f));
  if (!files.length) {
    console.error("usage: linux-repos.mjs [--dry-run] <.deb/.rpm files or folders>...");
    process.exit(1);
  }
  const out = mkdtempSync(join(tmpdir(), "steerglass-repos-"));
  buildLinuxRepos(files, out);
  console.log(`repositories built in ${out}`);
  if (dryRun) process.exit(0);
  const remote = releaseRemote();
  const ssh = `ssh -o ControlMaster=auto -o ControlPath=${join(out, "ssh.sock")} -o ControlPersist=60`;
  execFileSync("chmod", ["-R", "a+rX", out]);
  uploadLinuxRepos(out, (...a) => {
    const [dest] = a.splice(-1);
    execFileSync("rsync", ["-rltv", "-e", ssh, ...a, `${remote}/${dest}`], { stdio: "inherit" });
  });
  console.log(`Published: ${SITE}/apt and ${SITE}/rpm`);
}
