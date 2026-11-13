#!/usr/bin/env bash
# Builds a signed .pkg ready for Mac App Store upload.
#
# Prerequisites (one-time, see docs/DISTRIBUTION.md):
#   - "Apple Distribution" and "3rd Party Mac Developer Installer" certificates in the keychain
#   - src-tauri/macos/embedded.provisionprofile (Mac App Store profile for com.steerglass.app)
#   - TEAMID replaced with your team id in src-tauri/macos/AppStore.entitlements
#
# Usage: APPLE_TEAM_ID=XXXXXXXXXX scripts/build-appstore.sh [--upload]
set -euo pipefail
cd "$(dirname "$0")/.."

: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"
APP_CERT="${APP_CERT:-Apple Distribution}"
INSTALLER_CERT="${INSTALLER_CERT:-3rd Party Mac Developer Installer}"
PROFILE=src-tauri/macos/embedded.provisionprofile
[[ -f "$PROFILE" ]] || { echo "missing $PROFILE"; exit 1; }

ENT=$(mktemp)
sed "s/TEAMID/$APPLE_TEAM_ID/g" src-tauri/macos/AppStore.entitlements > "$ENT"

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

# The App Store build leaves out the built-in updater: the store updates the app.
APPLE_SIGNING_IDENTITY="$APP_CERT" pnpm tauri build \
  --target universal-apple-darwin \
  --bundles app \
  --features appstore \
  --config src-tauri/tauri.appstore.conf.json

APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Steerglass.app"
# Re-sign with the resolved entitlements (team id substituted).
codesign --force --options runtime --sign "$APP_CERT" --entitlements "$ENT" "$APP"
codesign --verify --deep --strict "$APP"

PKG="src-tauri/target/Steerglass-appstore.pkg"
productbuild --component "$APP" /Applications --sign "$INSTALLER_CERT" "$PKG"
echo "Built $PKG"

if [[ "${1:-}" == "--upload" ]]; then
  : "${APPLE_API_KEY_ID:?set APPLE_API_KEY_ID}" "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"
  xcrun altool --upload-package "$PKG" --type macos \
    --apiKey "$APPLE_API_KEY_ID" --apiIssuer "$APPLE_API_ISSUER"
fi
