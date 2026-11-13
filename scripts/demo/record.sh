#!/bin/sh
# Records the demo: drives the demo app (run-app.sh) through the scenes while ffmpeg records its
# window. Usage: record.sh <out.mp4>. Keep hands off the Mac while it runs.
set -eu
cd "$(dirname "$0")"
OUT=${1:?usage: record.sh out.mp4}
. ./drive.sh
SCALE=2   # Retina

typeslow() { sg_front; sg_slowtype "$1"; }
filter() { sg_click 550 600; sleep 0.3; sg_key 53; sleep 0.3; sg_type "/"; sleep 0.2; sg_char a command; typeslow "$1"; }
# go to a resource kind through the command palette
nav() { sg_click 550 600; sleep 0.3; sg_key 53; sleep 0.3; sg_char k command; sleep 0.4; typeslow "$1"; sleep 0.4; sg_key 36; sleep 1.2; }
mark() { echo "$(( $(date +%s) - T0 )) $1" >> "$OUT.scenes"; }

# --- clean slate (the debug container of the last take stays in its pod: start from a new one)
kubectl --kubeconfig home/.kube/shop-dev.yaml -n payments delete pod -l app=ledger --wait=true >/dev/null 2>&1 || true
kubectl --kubeconfig home/.kube/shop-dev.yaml -n payments wait pod -l app=ledger --for=condition=Ready --timeout=60s >/dev/null
sg_place; sleep 0.5
sg_click 550 600; sg_key 53; sleep 0.2; sg_key 53; sleep 0.2
sg_click 31 317; sleep 1   # Pods: the kind the clusters open on
# All namespaces: N opens the namespace picker, where it is the first entry
sg_type n; sleep 0.6; sg_key 36; sleep 0.6
sg_char 0 command; sleep 1.5
cliclick -e 0 "m:$((WX + 1300)),$((WY + 700))"
sleep 1

# --- record
rm -f "$OUT" "$OUT.scenes"
ffmpeg -loglevel error -f avfoundation -capture_cursor 1 -capture_mouse_clicks 1 -framerate 30 -i "1:none" \
  -vf "crop=$((WW * SCALE)):$((WH * SCALE)):$((WX * SCALE)):$((WY * SCALE))" \
  -c:v libx264 -preset veryfast -crf 14 -pix_fmt yuv420p "$OUT" < /dev/null &
FF=$!
T0=$(date +%s)
sleep 1.5

mark overview
sleep 2.5; sg_move 700 165; sleep 2.2; sg_move 1100 260; sleep 1

mark multicluster
sg_click 72 210; sleep 1.4
sg_click 72 234 cmd; sleep 0.6
sg_click 72 162 cmd; sleep 0.6
sg_click 72 258 cmd; sleep 0.6
sg_click 72 186 cmd; sleep 2.6
sg_move 760 420; sleep 1.2

mark filter
sg_type "/"; sleep 0.3; typeslow "status:bad"; sleep 1.8
sg_key 125; sleep 0.5; sg_key 125; sleep 0.6

mark logs
sg_type "l"; sleep 3.6

mark resources
filter "reconciler"; sleep 0.8
sg_key 125; sleep 0.3; sg_key 36; sleep 1.8
sg_click 1011 73; sleep 1.2; sg_click 1290 121; sleep 3.4

mark shell
filter "redis-0"; sleep 0.8
sg_key 125; sleep 0.4; sg_type "s"; sleep 2.2
typeslow "redis-cli ping"; sg_key 36; sleep 1.2
typeslow "redis-cli dbsize"; sg_key 36; sleep 2

mark debug
filter "ledger"; sleep 0.8
sg_key 125; sleep 0.4; sg_type "s"; sleep 2.2
sg_move 1367 170; sleep 0.5; sg_click 1367 170; sleep 3.2
typeslow "ps"; sg_key 36; sleep 2.2

mark node
nav "nodes"
filter "dev-server"; sleep 0.6
sg_key 125; sleep 0.4; sg_type "s"; sleep 1.4
sg_move 1138 173; sleep 0.4; sg_click 1138 173; sleep 3.6
typeslow "hostname && uptime"; sg_key 36; sleep 2.2

mark config
nav "configmaps"
filter "partner"; sleep 0.6
sg_key 125; sleep 0.3; sg_key 36; sleep 1.2
sg_move 1237 227; sleep 3.4

mark prod
nav "deployments"
filter "refund"; sleep 0.6
sg_key 125; sleep 0.3; sg_key 36; sleep 1
sg_type "r"; sleep 0.8
sg_move 884 234; sleep 2.4; sg_move 807 234; sleep 0.5; sg_click 807 234; sleep 1

mark portforward
nav "services"
sg_type "/"; sleep 0.2; sg_char a command; typeslow "redis"; sleep 0.8
sg_key 125; sleep 0.3; sg_key 36; sleep 1.4
sg_move 968 180; sleep 0.6; sg_click 968 180; sleep 2.4
sg_move 1150 181; sleep 1.6

mark end
sg_char 0 command; sleep 2.5

kill -INT $FF
wait $FF || true
echo "recorded $OUT ($(( $(date +%s) - T0 ))s)"

# --- tidy up: stop the forward, so the next take starts the same way
nav "services"
sg_type "/"; sleep 0.2; sg_char a command; sg_type "redis"; sleep 0.6
sg_key 125; sleep 0.3; sg_key 36; sleep 1.2
sg_click 1218 181; sleep 0.5
sg_click 550 600; sg_key 53; sleep 0.2; sg_key 53
