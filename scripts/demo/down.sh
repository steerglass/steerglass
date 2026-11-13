#!/bin/sh
# Deletes the demo clusters and their kubeconfigs.
set -eu
cd "$(dirname "$0")"
for name in shop-prod-eu shop-prod-us shop-staging shop-dev data-platform; do k3d cluster delete "$name" >/dev/null 2>&1 || true; done
rm -rf home
