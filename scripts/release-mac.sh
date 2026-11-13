#!/usr/bin/env bash
# Builds the universal macOS release (Developer ID signed + notarized, with updater bundle)
# and publishes it to steerglass.com.
#
# One-time setup (see docs/DISTRIBUTION.md, "Direct download"):
#   - a "Developer ID Application" certificate of your Apple Developer team in the keychain
#   - .secrets/apple.env with the notarization credentials: an App Store Connect API key
#     (APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH) or APPLE_ID, APPLE_PASSWORD
#     (app-specific password) and APPLE_TEAM_ID
#   - .secrets/updater.key (update signing key, created with `pnpm tauri signer generate`)
#
# Usage: scripts/release-mac.sh [--notes "What's new"] [--no-publish]
set -euo pipefail
cd "$(dirname "$0")/.."

publish=1
notes=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-publish) publish=0 ;;
    --notes) notes="$2"; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
  shift
done

[[ -f .secrets/updater.key ]] || { echo "missing .secrets/updater.key"; exit 1; }
export TAURI_SIGNING_PRIVATE_KEY="$(cat .secrets/updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

if [[ -f .secrets/apple.env ]]; then
  set -a; source .secrets/apple.env; set +a
fi
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -1)
fi
if [[ -z "$APPLE_SIGNING_IDENTITY" ]]; then
  echo "No 'Developer ID Application' certificate in the keychain: the build would be unsigned and Gatekeeper would block it."
  echo "Create it in Xcode > Settings > Accounts > Manage Certificates (see docs/DISTRIBUTION.md)."
  exit 1
fi
export APPLE_SIGNING_IDENTITY
# Notarization: App Store Connect API key (APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH)
# or Apple ID with an app-specific password (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID).
if [[ -z "${APPLE_API_KEY:-}${APPLE_ID:-}" ]]; then
  echo "Notarization credentials missing in .secrets/apple.env: macOS would block the downloaded app."
  exit 1
fi

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
pnpm tauri build --target universal-apple-darwin

bundle=src-tauri/target/universal-apple-darwin/release/bundle
# Tauri notarizes the .app; the .dmg around it needs its own ticket or Gatekeeper warns on open.
dmg=$(ls "$bundle"/dmg/*.dmg)
if [[ -n "${APPLE_API_KEY:-}" ]]; then
  xcrun notarytool submit "$dmg" --wait --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"
else
  xcrun notarytool submit "$dmg" --wait --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
fi
xcrun stapler staple "$dmg"
spctl -a -t install "$dmg"
if [[ $publish == 1 ]]; then
  node scripts/publish-release.mjs --notes "$notes" "$bundle/macos" "$bundle/dmg"
else
  node scripts/publish-release.mjs --dry-run --notes "$notes" "$bundle/macos" "$bundle/dmg"
fi
