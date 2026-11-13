#!/bin/sh
# Creates the local demo clusters (k3d) and their kubeconfigs in scripts/demo/home/.kube, never
# touching ~/.kube. Run the app on them with scripts/demo/run-app.sh. Remove with down.sh.
set -eu
cd "$(dirname "$0")"
KUBE=home/.kube
mkdir -p "$KUBE"
IMAGES="nginx:1.27-alpine redis:7.4-alpine busybox:1.37 registry.k8s.io/pause:3.10"
for i in $IMAGES; do docker image inspect "$i" >/dev/null 2>&1 || docker pull -q "$i" >/dev/null; done

# context name : flavour
for spec in shop-prod-eu:prod shop-prod-us:prod2 shop-staging:staging shop-dev:dev data-platform:data; do
  name=${spec%%:*}; flavour=${spec##*:}
  if ! k3d cluster list "$name" >/dev/null 2>&1; then
    k3d cluster create "$name" --servers 1 --agents 0 --no-lb --wait \
      --k3s-arg "--disable=traefik@server:0" \
      --kubeconfig-update-default=false --kubeconfig-switch-context=false >/dev/null
  fi
  k3d image import -c "$name" $IMAGES >/dev/null 2>&1
  file="$KUBE/$name.yaml"
  k3d kubeconfig get "$name" | sed "s/k3d-$name/$name/g" > "$file"
  sh workloads.sh "$file" "$name" "$flavour"
done
echo "Demo clusters ready: $(ls $KUBE | tr '\n' ' ')"
