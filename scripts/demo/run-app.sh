#!/bin/sh
# Starts a release build of Steerglass on the demo clusters only: its own home (settings) and the
# kubeconfigs from scripts/demo/home/.kube.
# Quit your own Steerglass first: both would share the WebKit storage.
set -eu
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
APP="$ROOT/src-tauri/target/release/bundle/macos/Steerglass.app/Contents/MacOS/steerglass"
DEMO_HOME="$(pwd)/home"
CONF="$DEMO_HOME/Library/Application Support/com.steerglass.app"
mkdir -p "$CONF"
HOME="$DEMO_HOME" STEERGLASS_KUBE_DIR="$DEMO_HOME/.kube" KUBECONFIG= exec "$APP"
