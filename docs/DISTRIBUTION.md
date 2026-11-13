# Distribution

How Steerglass builds are made and published. Most of this is only useful to maintainers: to build
and run Steerglass yourself, see the README.

| Channel | Build | Notes |
| --- | --- | --- |
| **Direct** (steerglass.com) | `pnpm tauri build` | Main channel: signed builds that update themselves |
| **Homebrew** | cask in the `homebrew-tap` repository | Updated by `publish-release.mjs` |
| **Linux repositories** | `.deb`, `.rpm` from CI | Signed apt and dnf repositories on steerglass.com |
| **Mac App Store** (optional) | `scripts/build-appstore.sh` (`--features appstore`) | Sandboxed, see limitations |

## 1. Direct distribution (macOS, Windows, Linux)

macOS is built, signed and notarized on a Mac (`scripts/release-mac.sh`); CI
(`.github/workflows/release.yml`) builds Windows and Linux (x86_64 and arm64) and keeps the bundles as
workflow artifacts. It needs the repository secret `TAURI_SIGNING_PRIVATE_KEY` (contents of
`.secrets/updater.key`).

Windows: sign with an EV/OV code-signing certificate or Azure Trusted Signing
(`bundle.windows.signCommand` in `tauri.conf.json`) to avoid SmartScreen warnings.

### Secrets and settings

Everything private lives in `.secrets/`, which is git-ignored:

| File | What it is |
| --- | --- |
| `updater.key` | Signs updates; its public key is `plugins.updater.pubkey` in `tauri.conf.json` |
| `repo-signing.key` | Signs the apt and dnf repositories; public half in `website/keys/` |
| `apple.env` | Notarization credentials (see below) |
| `release.env` | `STEERGLASS_REMOTE=user@host:/path`: where releases and the website are uploaded |

**Back up `updater.key`**: without it no installed copy will accept a new version.

### Releases and automatic updates

Direct builds update themselves from **steerglass.com** (Tauri updater plugin; App Store builds don't
include it). The app checks `https://steerglass.com/updates/latest.json` 10 s after launch and then every
6 hours; when there's a newer version it shows a card with *Update and restart*. Settings → Updates has
the current version and a *Check for updates* button.

The site is a static folder on a web server (`STEERGLASS_REMOTE`):

| Path | Content | Cache |
| --- | --- | --- |
| `/` | `website/` | normal |
| `/releases/<version>/` | every file of that version | immutable |
| `/download/` | stable names linked from the landing page (`steerglass-mac.dmg`, …; every published name is lowercase) | no-cache |
| `/updates/latest.json` | manifest the app polls | no-cache |

To release a version:

1. bump `version` in `src-tauri/tauri.conf.json` (and `Cargo.toml`, `package.json`) and add an entry to
   `website/changelog.json`;
2. macOS: `scripts/release-mac.sh --notes "What's new"` builds, signs, notarizes and publishes;
3. Windows/Linux: push a `v<version>` tag (or run the *Release (Windows, Linux)* workflow by hand), then
   publish its artifacts: `gh run download <run id> -D dist-ci && node scripts/publish-release.mjs dist-ci`.
   Platforms can be published at different times for the same version: the script keeps the platforms
   already in `latest.json` and refuses to replace a platform or a file that is already online;
4. website: `sh scripts/deploy-site.sh`.

A published version is never overwritten (Cloudflare and clients cache `/releases/` for a year): to fix
a release, publish a new version. `publish-release.mjs` refuses to publish a version that already exists.

`--dry-run` stages everything locally and prints what it would publish.

**macOS signing (one-time).** Builds must be signed with a *Developer ID Application* certificate and
notarized, or Gatekeeper blocks them (and the updater). With the Apple Developer account:

1. Xcode → Settings → Accounts → add the account → *Manage Certificates…* → `+` → *Developer ID Application*;
2. write `.secrets/apple.env` with the notarization credentials, either an App Store Connect API key
   ```sh
   APPLE_API_KEY=XXXXXXXXXX            # key id
   APPLE_API_ISSUER=xxxxxxxx-xxxx-…    # issuer id (App Store Connect → Users and Access → Integrations)
   APPLE_API_KEY_PATH=$HOME/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
   ```
   or an app-specific password (account.apple.com → Sign-In and Security → App-Specific Passwords)
   ```sh
   APPLE_ID=you@example.com
   APPLE_PASSWORD=xxxx-xxxx-xxxx-xxxx
   APPLE_TEAM_ID=XXXXXXXXXX
   ```
   `scripts/release-mac.sh` picks the certificate from the keychain and notarizes with these.

## 2. Mac App Store

One-time setup in App Store Connect / developer portal:

1. Register the bundle id `com.steerglass.app` and create the app record.
2. Create *Apple Distribution* and *3rd Party Mac Developer Installer* certificates.
3. Create a *Mac App Store* provisioning profile, save it as `src-tauri/macos/embedded.provisionprofile`.

Then:

```sh
APPLE_TEAM_ID=XXXXXXXXXX scripts/build-appstore.sh            # builds a signed .pkg
APPLE_TEAM_ID=… APPLE_API_KEY_ID=… APPLE_API_ISSUER=… scripts/build-appstore.sh --upload
```

### Sandbox limitations (important)

The Mac App Store requires the App Sandbox (`src-tauri/macos/AppStore.entitlements`):

- **Kubeconfig access** – the app asks for `~/.kube` read access through a *temporary exception*
  entitlement. If App Review rejects it, remove it: users then click **Grant access to ~/.kube…**
  once, and access is remembered with security-scoped bookmarks (already implemented).
- **Exec credential plugins** (`gke-gcloud-auth-plugin`, `aws eks get-token`, `kubelogin`, `oidc-login`)
  run inside the sandbox and cannot read their own credentials in `~/.config/gcloud`, `~/.aws`, …
  Clusters using token, client-certificate or static OIDC auth work; GKE/EKS/AKS with exec plugins
  generally don't. Making them work in the store build requires native in-app sign-in for each cloud
  (Google OAuth, AWS SSO/SigV4 token generation, Azure AD) — the main roadmap item for the MAS edition.
