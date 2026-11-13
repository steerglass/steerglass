#!/bin/sh
# Publishes website/ to steerglass.com. What releases publish (installers, updates, the Linux
# repositories) lives next to it on the server and is left alone.
set -eu
cd "$(dirname "$0")/.."
# The upload destination (user@host:/path), from the environment or .secrets/release.env.
[ -n "${STEERGLASS_REMOTE:-}" ] || { [ -f .secrets/release.env ] && . ./.secrets/release.env; }
: "${STEERGLASS_REMOTE:?set STEERGLASS_REMOTE (e.g. user@host:/var/www/steerglass) or add it to .secrets/release.env}"
if grep -rl UMAMI_WEBSITE_ID website >/dev/null; then echo "set the Umami website id in the pages first (UMAMI_WEBSITE_ID)" >&2; exit 1; fi
node scripts/stamp-assets.mjs
changed=$(node scripts/seo.mjs)
rsync -av --delete \
  --exclude updates/ --exclude releases/ --exclude download/ --exclude apt/ --exclude rpm/ \
  website/ "$STEERGLASS_REMOTE/"
# Bing & co. hear about the pages that changed; Google reads the sitemap.
[ -z "$changed" ] || node scripts/seo.mjs --ping $changed
