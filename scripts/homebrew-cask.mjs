#!/usr/bin/env node
// Updates the Homebrew cask in github.com/davidebettio/homebrew-tap (Casks/steerglass.rb), so that
// `brew install --cask davidebettio/tap/steerglass` installs the given version. publish-release.mjs
// calls it after a release with a macOS build; on its own it fetches the published .dmg to hash it:
//
//   node scripts/homebrew-cask.mjs <version>
//
// Uses the GitHub CLI (gh), signed in with write access to the tap.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const TAP = "davidebettio/homebrew-tap";
const PATH = "Casks/steerglass.rb";
const SITE = "https://steerglass.com";

export function cask(version, sha256, dmg) {
  return `cask "steerglass" do
  version "${version}"
  sha256 "${sha256}"

  url "${SITE}/releases/#{version}/${dmg.replaceAll(version, "#{version}")}"
  name "Steerglass"
  desc "Fast desktop client for many Kubernetes clusters"
  homepage "${SITE}/"

  livecheck do
    url "${SITE}/updates/latest.json"
    strategy :json do |json|
      json["version"]
    end
  end

  auto_updates true
  depends_on macos: ">= :big_sur"

  app "Steerglass.app"

  zap trash: [
    "~/Library/Application Support/com.steerglass.app",
    "~/Library/Caches/com.steerglass.app",
    "~/Library/Saved Application State/com.steerglass.app.savedState",
    "~/Library/WebKit/com.steerglass.app",
  ]
end
`;
}

export function updateHomebrewCask(version, sha256, dmg) {
  const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let sha = "";
  try {
    sha = gh("api", `repos/${TAP}/contents/${PATH}`, "--jq", ".sha");
  } catch {
    // first version of the cask
  }
  gh("api", "-X", "PUT", `repos/${TAP}/contents/${PATH}`,
    "-f", `message=steerglass ${version}`,
    "-f", `content=${Buffer.from(cask(version, sha256, dmg)).toString("base64")}`,
    ...(sha ? ["-f", `sha=${sha}`] : []));
  console.log(`Homebrew: ${TAP} updated to ${version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: homebrew-cask.mjs <version>");
    process.exit(1);
  }
  const dmg = `steerglass_${version}_universal.dmg`;
  const res = await fetch(`${SITE}/releases/${version}/${dmg}`);
  if (!res.ok) {
    console.error(`${dmg} is not published (${res.status})`);
    process.exit(1);
  }
  updateHomebrewCask(version, createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex"), dmg);
}
