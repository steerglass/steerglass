#!/bin/sh
# Realistic-looking workloads for a demo cluster: web services, a cache, workers that log, a job,
# a cronjob and (per flavour) some trouble. Usage: workloads.sh <kubeconfig> <context> <flavour>
#   flavour: prod (healthy + one crashing worker), prod2 (healthy), staging (image pull error), dev, data
set -eu
KC=$1; CTX=$2; FLAVOUR=$3
k() { kubectl --kubeconfig "$KC" --context "$CTX" "$@"; }

for ns in shop payments monitoring; do k create namespace $ns --dry-run=client -o yaml | k apply -f - >/dev/null; done

web() { # name namespace replicas port
  cat <<YAML | k apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: { name: $1, namespace: $2, labels: { app: $1 } }
spec:
  replicas: $3
  selector: { matchLabels: { app: $1 } }
  template:
    metadata: { labels: { app: $1 } }
    spec:
      containers:
        - name: $1
          image: nginx:1.27-alpine
          ports: [{ name: http, containerPort: 80 }]
          resources: { requests: { cpu: 50m, memory: 32Mi }, limits: { cpu: 200m, memory: 96Mi } }
---
apiVersion: v1
kind: Service
metadata: { name: $1, namespace: $2 }
spec:
  selector: { app: $1 }
  ports: [{ name: http, port: $4, targetPort: http }]
YAML
}

worker() { # name namespace message [cpu-busy]
  busy=${4:-}
  if [ -n "$busy" ]; then req=150m; lim=300m; else req=20m; lim=100m; fi
  cat <<YAML | k apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: { name: $1, namespace: $2, labels: { app: $1 } }
spec:
  replicas: 1
  selector: { matchLabels: { app: $1 } }
  template:
    metadata: { labels: { app: $1 } }
    spec:
      containers:
        - name: $1
          image: busybox:1.37
          command: ["sh", "-c"]
          args:
            - |
              ${busy:+(while true; do :; done) &}
              i=0
              while true; do
                i=\$((i+1))
                lvl=INFO; [ \$((i % 11)) -eq 0 ] && lvl=WARN; [ \$((i % 37)) -eq 0 ] && lvl=ERROR
                echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ) \$lvl $3 id=\$((RANDOM % 90000 + 10000)) took=\$((RANDOM % 240 + 8))ms"
                sleep 0.\$((RANDOM % 8 + 2))
              done
          resources: { requests: { cpu: $req, memory: 16Mi }, limits: { cpu: $lim, memory: 64Mi } }
YAML
}

web storefront shop 3 80
web checkout-api shop 2 8080
web catalog shop 2 8080
web payments-api payments 2 8443
worker order-events shop "processed order event"
worker payment-reconciler payments "reconciled payment" busy
worker metrics-exporter monitoring "scraped targets"

cat <<YAML | k apply -f - >/dev/null
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: redis, namespace: shop }
spec:
  serviceName: redis
  replicas: 1
  selector: { matchLabels: { app: redis } }
  template:
    metadata: { labels: { app: redis } }
    spec:
      containers:
        - name: redis
          image: redis:7.4-alpine
          ports: [{ name: redis, containerPort: 6379 }]
          resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { memory: 128Mi } }
---
apiVersion: v1
kind: Service
metadata: { name: redis, namespace: shop }
spec:
  selector: { app: redis }
  ports: [{ name: redis, port: 6379, targetPort: redis }]
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly-report, namespace: shop }
spec:
  schedule: "*/10 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers: [{ name: report, image: busybox:1.37, command: ["sh", "-c", "echo building report; sleep 3; echo done"] }]
---
apiVersion: batch/v1
kind: Job
metadata: { name: db-migrate-2026-11-01, namespace: shop }
spec:
  template:
    spec:
      restartPolicy: Never
      containers: [{ name: migrate, image: busybox:1.37, command: ["sh", "-c", "echo applying 14 migrations; sleep 2; echo ok"] }]
YAML

case $FLAVOUR in
  prod) # a worker that keeps crashing: shows up in "Needs attention"
    cat <<YAML | k apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: { name: refund-worker, namespace: payments, labels: { app: refund-worker } }
spec:
  replicas: 1
  selector: { matchLabels: { app: refund-worker } }
  template:
    metadata: { labels: { app: refund-worker } }
    spec:
      containers:
        - name: refund-worker
          image: busybox:1.37
          command: ["sh", "-c", "echo 'starting refund-worker v2.4.1'; echo 'connecting to payments-db:5432'; sleep 4; echo 'FATAL: password authentication failed for user \"refunds\"' >&2; exit 1"]
          resources: { requests: { cpu: 20m, memory: 16Mi } }
YAML
    k -n shop scale deployment storefront --replicas=40 >/dev/null
    k -n shop scale deployment catalog --replicas=12 >/dev/null ;;
  prod2)
    k -n shop scale deployment storefront --replicas=36 >/dev/null
    k -n payments scale deployment payments-api --replicas=10 >/dev/null ;;
  data) # many small batch pods
    worker spark-executor monitoring "partition done"
    k -n monitoring scale deployment spark-executor --replicas=48 >/dev/null ;;
  staging) # a bad image tag
    k -n shop set image deployment/catalog catalog=nginx:1.27-alpine-typo >/dev/null ;;
  dev) # a service built on a distroless image: no shell inside, for the debug container
    k -n shop scale deployment storefront --replicas=1 >/dev/null
    cat <<YAML | k apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: { name: ledger, namespace: payments, labels: { app: ledger } }
spec:
  replicas: 1
  selector: { matchLabels: { app: ledger } }
  template:
    metadata: { labels: { app: ledger } }
    spec:
      containers:
        - name: ledger
          image: registry.k8s.io/pause:3.10
          resources: { requests: { cpu: 10m, memory: 8Mi } }
YAML
    ;;
esac
k apply -f "$(dirname "$0")/configmaps.yaml" >/dev/null
# the partner CA expires in 12 days: the certificate view shows it as expiring soon
tmp=$(mktemp -d)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 12 -subj "/O=Partner Payments Ltd/CN=api.partner-payments.example" \
  -addext "subjectAltName=DNS:api.partner-payments.example,DNS:*.partner-payments.example" -keyout "$tmp/k" -out "$tmp/ca.crt" 2>/dev/null
k -n shop create configmap partner-ca --from-file=ca.crt="$tmp/ca.crt" --dry-run=client -o yaml | k apply -f - >/dev/null
rm -rf "$tmp"
# quotas: count-only (pods without requests keep starting); payments sits near its pod limit
pay=$(k -n payments get pods --no-headers 2>/dev/null | wc -l | tr -d ' ')
k apply -f - >/dev/null <<YAML
apiVersion: v1
kind: ResourceQuota
metadata: { name: shop-quota, namespace: shop }
spec: { hard: { pods: "100", services: "15", configmaps: "30", secrets: "20", persistentvolumeclaims: "10" } }
---
apiVersion: v1
kind: ResourceQuota
metadata: { name: payments-quota, namespace: payments }
spec: { hard: { pods: "$(( pay + 2 ))", services: "10", configmaps: "10" } }
---
apiVersion: v1
kind: LimitRange
metadata: { name: shop-defaults, namespace: shop }
spec:
  limits:
  - type: Container
    defaultRequest: { cpu: 10m, memory: 16Mi }
    default: { cpu: 500m, memory: 256Mi }
    max: { cpu: "2", memory: 2Gi }
YAML
echo "$CTX: workloads applied ($FLAVOUR)"
