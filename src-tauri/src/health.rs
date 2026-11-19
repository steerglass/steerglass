//! What needs attention in a cluster.
//!
//! [`quick`] runs every minute while the overview is open: failing pods, nodes, jobs and cron jobs,
//! workloads with no replica ready or a stuck rollout, claims and load balancers stuck waiting, ingresses pointing at nothing, Gateway API objects
//! that weren't accepted, autoscalers that can't scale, and recent Warning events about anything.
//! [`scan`] runs on demand and adds every custom resource the cluster serves, judged by the common
//! status conditions (see `rows::conditions_status`), plus a few built-in kinds.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures::{StreamExt, stream};
use kube::Client;
use kube::api::ListParams;
use kube::core::Request;
use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};
use crate::rows::{Health, Row, arr, cronjob_problem, get, s, to_row};
use crate::state::{AppState, KindRef};
use crate::table::list_rows;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warn,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub group: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub reason: String,
    /// When the problem started, as far as it is known (last restart, creation, last event).
    pub since: Option<String>,
    pub severity: Severity,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub items: Vec<Issue>,
    /// How many resource kinds were checked.
    pub kinds: usize,
    /// Kinds that couldn't be read (no permission, timeouts), as `Kind.group`.
    pub skipped: Vec<String>,
}

const MAX_QUICK: usize = 100;
const MAX_SCAN: usize = 500;
/// Pending claims and load balancers without an address are normal for a few minutes.
const SETTLE_MINUTES: i64 = 5;
/// Warning events older than this are history, not a current problem.
const EVENT_MINUTES: i64 = 15;
const SCAN_PARALLEL: usize = 6;

/// Identifies an object: group, kind, namespace, name.
type ObjKey = (String, String, Option<String>, String);

/// Collects issues, one per object.
#[derive(Default)]
struct Found {
    items: Vec<Issue>,
    seen: HashSet<ObjKey>,
}

impl Found {
    fn push(&mut self, i: Issue) {
        if self.seen.insert((i.group.clone(), i.kind.clone(), i.namespace.clone(), i.name.clone())) {
            self.items.push(i);
        }
    }

    fn row(&mut self, group: &str, kind: &str, r: Row, reason: String, severity: Severity, since: Option<String>) {
        self.push(Issue { group: group.into(), kind: kind.into(), namespace: r.namespace, name: r.name, reason, since, severity });
    }

    /// Nodes first (they affect everything on them), then errors, then the most recent.
    fn finish(mut self, max: usize) -> Vec<Issue> {
        self.items.sort_by(|a, b| {
            (a.kind != "Node").cmp(&(b.kind != "Node")).then(a.severity.cmp(&b.severity)).then_with(|| b.since.cmp(&a.since))
        });
        self.items.truncate(max);
        self.items
    }
}

fn time(ts: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(ts).ok().map(|t| t.with_timezone(&Utc))
}

fn older_than(ts: Option<&str>, minutes: i64, now: DateTime<Utc>) -> bool {
    ts.and_then(time).is_none_or(|t| now - t > chrono::Duration::minutes(minutes))
}

/// Full objects from a list URL, at most `max`. For the few kinds whose rows lack what's needed.
async fn list_json(client: &Client, url: &str, fields: Option<&str>, max: usize) -> std::result::Result<Vec<Value>, String> {
    let req = Request::new(url);
    let mut lp = ListParams::default().limit(500);
    lp.field_selector = fields.map(String::from);
    let mut out = Vec::new();
    loop {
        let list: Value = client
            .request(req.list(&lp).map_err(|e| e.to_string())?)
            .await
            .map_err(|e| Error::from(e).to_string())?;
        out.extend(list["items"].as_array().into_iter().flatten().cloned());
        match list.pointer("/metadata/continue").and_then(|c| c.as_str()).filter(|c| !c.is_empty()) {
            Some(c) if out.len() < max => lp.continue_token = Some(c.into()),
            _ => return Ok(out),
        }
    }
}

fn cell(r: &Row, n: usize) -> String {
    r.cells.get(n).cloned().unwrap_or_default()
}

/// The checks behind the overview's "Needs attention" list.
pub async fn quick(client: &Client) -> Result<Vec<Issue>> {
    let now = Utc::now();
    let (pods, nodes, jobs, deploys, sets, daemons, claims, services) = tokio::join!(
        list_rows(client, "/api/v1/pods", "", "Pod"),
        list_rows(client, "/api/v1/nodes", "", "Node"),
        list_rows(client, "/apis/batch/v1/jobs", "batch", "Job"),
        // Full objects: the rollout conditions aren't in the server table.
        list_json(client, "/apis/apps/v1/deployments", None, 5000),
        list_rows(client, "/apis/apps/v1/statefulsets", "apps", "StatefulSet"),
        list_rows(client, "/apis/apps/v1/daemonsets", "apps", "DaemonSet"),
        list_rows(client, "/api/v1/persistentvolumeclaims", "", "PersistentVolumeClaim"),
        list_rows(client, "/api/v1/services", "", "Service"),
    );
    if let (Err(e), Err(_), Err(_)) = (&pods, &nodes, &jobs) {
        return Err(Error::msg(e.clone()));
    }
    const GW: &str = "gateway.networking.k8s.io";
    let (ingresses, classes, scalers, events, gateways, routes, cronjobs) = tokio::join!(
        list_json(client, "/apis/networking.k8s.io/v1/ingresses", None, 5000),
        list_json(client, "/apis/networking.k8s.io/v1/ingressclasses", None, 500),
        list_json(client, "/apis/autoscaling/v2/horizontalpodautoscalers", None, 5000),
        list_json(client, "/api/v1/events", Some("type=Warning"), 3000),
        list_rows(client, "/apis/gateway.networking.k8s.io/v1/gateways", GW, "Gateway"),
        list_rows(client, "/apis/gateway.networking.k8s.io/v1/httproutes", GW, "HTTPRoute"),
        list_json(client, "/apis/batch/v1/cronjobs", None, 5000),
    );
    let deploys = deploys.map(|items| items.iter().map(|o| (to_row("apps", "Deployment", o), o.clone())).collect::<Vec<_>>());

    // What exists, for the kinds listed here: Warning events about anything else of those kinds
    // are about deleted objects (a controller still retrying a cleanup), not current problems.
    let mut known = Known::default();
    for (group, kind, rows) in [
        ("", "Pod", &pods), ("", "Node", &nodes), ("batch", "Job", &jobs),
        ("apps", "StatefulSet", &sets), ("apps", "DaemonSet", &daemons), ("", "PersistentVolumeClaim", &claims), ("", "Service", &services),
    ] {
        if let Ok(rows) = rows {
            known.rows(group, kind, rows);
        }
    }
    if let Ok(d) = &deploys {
        known.rows("apps", "Deployment", &d.iter().map(|(r, _)| r.clone()).collect::<Vec<_>>());
    }
    for (group, kind, items) in [
        ("networking.k8s.io", "Ingress", &ingresses), ("autoscaling", "HorizontalPodAutoscaler", &scalers), ("batch", "CronJob", &cronjobs),
    ] {
        if let Ok(items) = items {
            known.objects(group, kind, items);
        }
    }

    let mut f = Found::default();
    let failing = |rows: std::result::Result<Vec<Row>, String>| rows.unwrap_or_default().into_iter().filter(|r| r.health == Health::Error);
    for r in failing(nodes) {
        f.row("", "Node", r.clone(), cell(&r, 0), Severity::Error, None);
    }
    for r in failing(pods) {
        let since = r.last_restart.clone().or(r.created.clone());
        f.row("", "Pod", r.clone(), cell(&r, 1), Severity::Error, since);
    }
    for r in failing(jobs.clone()) {
        f.row("batch", "Job", r.clone(), cell(&r, 1), Severity::Error, r.created.clone());
    }
    let failed_jobs: Vec<Row> = jobs.as_ref().map(|j| j.iter().filter(|r| r.health == Health::Error).cloned().collect()).unwrap_or_default();
    for i in cronjob_issues(cronjobs.as_deref().unwrap_or_default(), &failed_jobs) {
        f.push(i);
    }
    // A rollout that can't proceed (quota, admission, deadline), even while old replicas serve.
    for (r, o) in deploys.unwrap_or_default() {
        if let Some((reason, since)) = rollout_problem(&o) {
            f.row("apps", "Deployment", r, reason, Severity::Error, since);
        } else if r.health == Health::Error {
            let reason = workload_reason("Deployment", &r);
            f.row("apps", "Deployment", r, reason, Severity::Error, None);
        }
    }
    // No replica ready at all (partial ones show up through their failing pods).
    for (kind, rows) in [("StatefulSet", sets), ("DaemonSet", daemons)] {
        for r in failing(rows) {
            let reason = workload_reason(kind, &r);
            f.row("apps", kind, r, reason, Severity::Error, None);
        }
    }
    for r in claims.unwrap_or_default() {
        let phase = cell(&r, 0);
        if phase != "Bound" && older_than(r.created.as_deref(), SETTLE_MINUTES, now) {
            let sev = if phase == "Lost" { Severity::Error } else { Severity::Warn };
            f.row("", "PersistentVolumeClaim", r.clone(), phase, sev, r.created.clone());
        }
    }
    let services = services.ok();
    for r in services.iter().flatten() {
        if cell(r, 0) == "LoadBalancer" && cell(r, 2) == "-" && older_than(r.created.as_deref(), SETTLE_MINUTES, now) {
            f.row("", "Service", r.clone(), "No external IP assigned".into(), Severity::Warn, r.created.clone());
        }
    }
    for (kind, rows) in [("Gateway", gateways), ("HTTPRoute", routes)] {
        for r in failing(rows) {
            f.row(GW, kind, r.clone(), cell(&r, 0), Severity::Error, r.created.clone());
        }
    }
    if let Ok(ingresses) = ingresses {
        let classes = classes.ok().map(|c| c.iter().map(|x| s(x, &["metadata", "name"])).collect::<HashSet<_>>());
        let services = services.map(|rows| rows.into_iter().map(|r| (r.namespace.unwrap_or_default(), r.name)).collect::<HashSet<_>>());
        for i in ingress_issues(&ingresses, classes.as_ref(), services.as_ref(), now) {
            f.push(i);
        }
    }
    for i in scaler_issues(scalers.as_deref().unwrap_or_default()) {
        f.push(i);
    }
    // Last: objects already listed keep their more specific reason.
    for i in event_issues(&events.unwrap_or_default(), now) {
        if known.exists(&i) {
            f.push(i);
        }
    }
    Ok(f.finish(MAX_QUICK))
}

/// The objects of the kinds [`quick`] lists.
#[derive(Default)]
struct Known {
    kinds: HashSet<(String, String)>,
    objects: HashSet<ObjKey>,
}

impl Known {
    fn rows(&mut self, group: &str, kind: &str, rows: &[Row]) {
        self.kinds.insert((group.into(), kind.into()));
        self.objects.extend(rows.iter().map(|r| (group.into(), kind.into(), r.namespace.clone(), r.name.clone())));
    }

    fn objects(&mut self, group: &str, kind: &str, items: &[Value]) {
        self.kinds.insert((group.into(), kind.into()));
        self.objects.extend(items.iter().map(|o| {
            let ns = get(o, &["metadata", "namespace"]).and_then(|v| v.as_str()).map(String::from);
            (group.into(), kind.into(), ns, s(o, &["metadata", "name"]))
        }));
    }

    /// False only for an object of a listed kind that wasn't in the list.
    fn exists(&self, i: &Issue) -> bool {
        !self.kinds.contains(&(i.group.clone(), i.kind.clone()))
            || self.objects.contains(&(i.group.clone(), i.kind.clone(), i.namespace.clone(), i.name.clone()))
    }
}

fn workload_reason(kind: &str, r: &Row) -> String {
    match kind {
        "DaemonSet" => format!("{}/{} ready", cell(r, 2), cell(r, 0)),
        _ => format!("{} ready", cell(r, 0)),
    }
}

/// Ingresses whose class or backend Service doesn't exist, or that never got an address.
fn ingress_issues(items: &[Value], classes: Option<&HashSet<String>>, services: Option<&HashSet<(String, String)>>, now: DateTime<Utc>) -> Vec<Issue> {
    let mut out = Vec::new();
    for o in items {
        let ns = s(o, &["metadata", "namespace"]);
        let created = get(o, &["metadata", "creationTimestamp"]).and_then(|v| v.as_str()).map(String::from);
        let issue = |reason: String, severity| Issue {
            group: "networking.k8s.io".into(),
            kind: "Ingress".into(),
            namespace: Some(ns.clone()),
            name: s(o, &["metadata", "name"]),
            reason,
            since: created.clone(),
            severity,
        };
        let class = s(o, &["spec", "ingressClassName"]);
        if let Some(classes) = classes
            && !class.is_empty()
            && !classes.contains(&class)
        {
            out.push(issue(format!("IngressClass \"{class}\" doesn't exist"), Severity::Error));
            continue;
        }
        if let Some(services) = services {
            let backends = arr(o, &["spec", "rules"])
                .iter()
                .flat_map(|r| arr(r, &["http", "paths"]))
                .map(|p| s(p, &["backend", "service", "name"]))
                .chain(std::iter::once(s(o, &["spec", "defaultBackend", "service", "name"])))
                .filter(|n| !n.is_empty());
            let mut missing: Vec<String> = backends.filter(|n| !services.contains(&(ns.clone(), n.clone()))).collect();
            missing.dedup();
            if let Some(first) = missing.first() {
                let more = if missing.len() > 1 { format!(" (and {} more)", missing.len() - 1) } else { String::new() };
                out.push(issue(format!("Backend Service \"{first}\" doesn't exist{more}"), Severity::Error));
                continue;
            }
        }
        if arr(o, &["status", "loadBalancer", "ingress"]).is_empty() && older_than(created.as_deref(), SETTLE_MINUTES, now) {
            out.push(issue("No address assigned by the ingress controller".into(), Severity::Warn));
        }
    }
    out
}

/// Cron jobs whose last run failed, or that never succeeded (see `rows::cronjob_problem`). Also
/// while a run is active, which Argo CD can't judge: failed Jobs it created since its last success
/// (named `<cronjob>-<schedule>`) show runs keep failing.
fn cronjob_issues(items: &[Value], failed_jobs: &[Row]) -> Vec<Issue> {
    items
        .iter()
        .filter_map(|o| {
            let ns = get(o, &["metadata", "namespace"]).and_then(|v| v.as_str());
            let name = s(o, &["metadata", "name"]);
            let suspended = get(o, &["spec", "suspend"]).and_then(|v| v.as_bool()) == Some(true);
            let last_ok = get(o, &["status", "lastSuccessfulTime"]).and_then(|v| v.as_str());
            let failed_since = failed_jobs
                .iter()
                .filter(|j| {
                    j.namespace.as_deref() == ns
                        && j.name.strip_prefix(&name).and_then(|x| x.strip_prefix('-')).is_some_and(|x| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit()))
                        && last_ok.is_none_or(|ok| j.created.as_deref().is_some_and(|c| c > ok))
                })
                .count();
            let scheduled = get(o, &["status", "lastScheduleTime"]).and_then(|v| v.as_str()).map(String::from);
            // The failed Jobs kept are capped by failedJobsHistoryLimit, so no count: since when.
            let (reason, h, since) = match cronjob_problem(o) {
                Some((r, h)) => (r.to_string(), h, scheduled),
                None if !suspended && failed_since > 0 => ("Runs failing since the last success".into(), Health::Error, last_ok.map(String::from).or(scheduled)),
                None => return None,
            };
            Some(Issue {
                group: "batch".into(),
                kind: "CronJob".into(),
                namespace: ns.map(String::from),
                name,
                reason,
                since,
                severity: if h == Health::Error { Severity::Error } else { Severity::Warn },
            })
        })
        .collect()
}

/// A Deployment whose controller can't create pods (`ReplicaFailure`: quota, admission webhooks,
/// pod security) or whose rollout ran past its deadline, like Argo CD's "Degraded".
fn rollout_problem(o: &Value) -> Option<(String, Option<String>)> {
    let paused = get(o, &["spec", "paused"]).and_then(|v| v.as_bool()) == Some(true);
    let conds = arr(o, &["status", "conditions"]);
    let since = |c: &Value| get(c, &["lastTransitionTime"]).and_then(|v| v.as_str()).map(String::from);
    if let Some(c) = conds.iter().find(|c| s(c, &["type"]) == "ReplicaFailure" && s(c, &["status"]) == "True") {
        let msg = s(c, &["message"]);
        let reason = s(c, &["reason"]);
        let text = if msg.is_empty() { reason } else { format!("{reason}: {msg}") };
        return Some((text.chars().take(200).collect(), since(c)));
    }
    let c = conds.iter().find(|c| s(c, &["type"]) == "Progressing" && s(c, &["reason"]) == "ProgressDeadlineExceeded")?;
    (!paused).then(|| ("Rollout stuck: progress deadline exceeded".into(), since(c)))
}

/// Autoscalers that can't read their metrics or reach their target.
fn scaler_issues(items: &[Value]) -> Vec<Issue> {
    let mut out = Vec::new();
    for o in items {
        let bad = arr(o, &["status", "conditions"]).iter().find(|c| {
            let ty = s(c, &["type"]);
            (ty == "AbleToScale" || ty == "ScalingActive") && s(c, &["status"]) == "False" && s(c, &["reason"]) != "ScalingDisabled"
        });
        if let Some(c) = bad {
            out.push(Issue {
                group: "autoscaling".into(),
                kind: "HorizontalPodAutoscaler".into(),
                namespace: get(o, &["metadata", "namespace"]).and_then(|v| v.as_str()).map(String::from),
                name: s(o, &["metadata", "name"]),
                reason: s(c, &["reason"]),
                since: get(c, &["lastTransitionTime"]).and_then(|v| v.as_str()).map(String::from),
                severity: Severity::Warn,
            });
        }
    }
    out
}

/// One issue per object with a Warning event in the last few minutes: the latest one, with its count.
fn event_issues(events: &[Value], now: DateTime<Utc>) -> Vec<Issue> {
    let mut latest: HashMap<ObjKey, (DateTime<Utc>, i64, &Value)> = HashMap::new();
    for e in events {
        let when = ["lastTimestamp", "eventTime"]
            .iter()
            .filter_map(|k| e.get(*k).and_then(|v| v.as_str()))
            .chain(get(e, &["series", "lastObservedTime"]).and_then(|v| v.as_str()))
            .chain(get(e, &["metadata", "creationTimestamp"]).and_then(|v| v.as_str()))
            .find_map(time);
        let Some(when) = when.filter(|t| now - *t <= chrono::Duration::minutes(EVENT_MINUTES)) else { continue };
        let obj = e.get("involvedObject").unwrap_or(&Value::Null);
        let api = s(obj, &["apiVersion"]);
        let group = api.split_once('/').map(|(g, _)| g.to_string()).unwrap_or_default();
        let kind = s(obj, &["kind"]);
        let name = s(obj, &["name"]);
        if kind.is_empty() || name.is_empty() {
            continue;
        }
        let ns = get(obj, &["namespace"]).and_then(|v| v.as_str()).filter(|n| !n.is_empty()).map(String::from);
        let count = get(e, &["count"]).and_then(|v| v.as_i64()).or_else(|| get(e, &["series", "count"]).and_then(|v| v.as_i64())).unwrap_or(1);
        let slot = latest.entry((group, kind, ns, name)).or_insert((when, 0, e));
        slot.1 += count;
        if when >= slot.0 {
            slot.0 = when;
            slot.2 = e;
        }
    }
    latest
        .into_iter()
        .map(|((group, kind, namespace, name), (when, count, e))| {
            let msg = s(e, &["message"]);
            let msg = msg.lines().next().unwrap_or("").trim();
            let mut reason = s(e, &["reason"]);
            if !msg.is_empty() {
                reason = format!("{reason}: {msg}");
            }
            if reason.chars().count() > 200 {
                reason = format!("{}…", reason.chars().take(200).collect::<String>());
            }
            if count > 1 {
                reason = format!("{reason} (×{count})");
            }
            Issue { group, kind, namespace, name, reason, since: Some(when.to_rfc3339()), severity: Severity::Warn }
        })
        .collect()
}

/// API groups that ship with Kubernetes: only the kinds listed in [`BUILTIN_SCANNED`] are swept,
/// the rest either have no health (ConfigMaps, RBAC) or are covered by [`quick`].
const BUILTIN_GROUPS: &[&str] = &[
    "", "apps", "batch", "autoscaling", "policy", "extensions", "rbac.authorization.k8s.io", "networking.k8s.io",
    "storage.k8s.io", "coordination.k8s.io", "discovery.k8s.io", "events.k8s.io", "admissionregistration.k8s.io",
    "certificates.k8s.io", "node.k8s.io", "scheduling.k8s.io", "flowcontrol.apiserver.k8s.io", "apiextensions.k8s.io",
    "apiregistration.k8s.io", "authentication.k8s.io", "authorization.k8s.io", "resource.k8s.io", "metrics.k8s.io",
    "internal.apiserver.k8s.io", "storagemigration.k8s.io",
    // kube-storage-version-migrator (GKE and others): finished or failed one-off migrations, not health.
    "migration.k8s.io",
];
const BUILTIN_SCANNED: &[(&str, &str)] = &[
    ("apps", "Deployment"),
    ("apps", "StatefulSet"),
    ("apps", "DaemonSet"),
    ("", "PersistentVolume"),
    ("", "Namespace"),
    ("", "ResourceQuota"),
    ("apiregistration.k8s.io", "APIService"),
];

fn scanned(k: &KindRef) -> bool {
    if BUILTIN_GROUPS.contains(&k.group.as_str()) {
        BUILTIN_SCANNED.contains(&(k.group.as_str(), k.kind.as_str()))
    } else {
        true
    }
}

fn row_reason(group: &str, kind: &str, r: &Row) -> String {
    let reason = match (group, kind) {
        ("apps", "Deployment" | "StatefulSet" | "DaemonSet") => workload_reason(kind, r),
        ("", "PersistentVolume") => cell(r, 3),
        ("", "ResourceQuota") => format!("{} used ({})", cell(r, 0), cell(r, 1)),
        _ => cell(r, 0),
    };
    if reason.trim().is_empty() { "Unhealthy".into() } else { reason }
}

/// Every custom resource (and a few more built-in kinds) whose status says it isn't healthy.
/// It doesn't repeat [`quick`]: the overview shows both, the quick checks kept current.
pub async fn scan(state: &AppState, context: &str) -> Result<Scan> {
    let client = state.client(context).await?;
    let kinds = crate::commands::kinds_for(state, context, false).await?;
    let targets: Vec<KindRef> = kinds.iter().filter(|k| scanned(k)).cloned().collect();
    let sweep = stream::iter(targets.iter().cloned())
        .map(|k| {
            let client = client.clone();
            async move {
                let url = crate::commands::dyn_api(client.clone(), &k, None).resource_url().to_string();
                let rows = match tokio::time::timeout(Duration::from_secs(20), list_rows(&client, &url, &k.group, &k.kind)).await {
                    Ok(r) => r,
                    Err(_) => Err("timed out".into()),
                };
                (k, rows)
            }
        })
        .buffer_unordered(SCAN_PARALLEL)
        .collect::<Vec<_>>();
    let swept = sweep.await;

    let mut f = Found::default();
    let mut skipped = Vec::new();
    for (k, rows) in swept {
        let Ok(rows) = rows else {
            skipped.push(if k.group.is_empty() { k.kind.clone() } else { format!("{}.{}", k.kind, k.group) });
            continue;
        };
        for r in rows {
            let severity = match r.health {
                Health::Error => Severity::Error,
                Health::Warn => Severity::Warn,
                _ => continue,
            };
            let reason = row_reason(&k.group, &k.kind, &r);
            let since = r.created.clone();
            f.row(&k.group, &k.kind, r, reason, severity, since);
        }
    }
    skipped.sort();
    Ok(Scan { items: f.finish(MAX_SCAN), kinds: targets.len(), skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(s: &str) -> DateTime<Utc> {
        time(s).unwrap()
    }

    #[test]
    fn ingress_problems() {
        let now = at("2026-11-18T12:00:00Z");
        let ing = |name: &str, class: &str, svc: &str, addr: bool| {
            json!({
                "metadata": {"name": name, "namespace": "shop", "creationTimestamp": "2026-11-18T10:00:00Z"},
                "spec": {"ingressClassName": class, "rules": [{"http": {"paths": [{"backend": {"service": {"name": svc}}}]}}]},
                "status": {"loadBalancer": {"ingress": if addr { json!([{"ip": "10.0.0.1"}]) } else { json!([]) }}}
            })
        };
        let items = [ing("ok", "nginx", "web", true), ing("noclass", "traefik", "web", true), ing("nosvc", "nginx", "gone", true), ing("noaddr", "nginx", "web", false)];
        let classes: HashSet<String> = ["nginx".to_string()].into();
        let services: HashSet<(String, String)> = [("shop".to_string(), "web".to_string())].into();
        let found = ingress_issues(&items, Some(&classes), Some(&services), now);
        let names: Vec<_> = found.iter().map(|i| (i.name.as_str(), i.severity)).collect();
        assert_eq!(names, [("noclass", Severity::Error), ("nosvc", Severity::Error), ("noaddr", Severity::Warn)]);
        assert!(found[1].reason.contains("\"gone\""));
        // Without the lists (no permission) only the address is checked.
        assert_eq!(ingress_issues(&items, None, None, now).len(), 1);
    }

    #[test]
    fn recent_warning_events_grouped() {
        let now = at("2026-11-18T12:00:00Z");
        let ev = |name: &str, reason: &str, last: &str, count: i64| {
            json!({
                "involvedObject": {"apiVersion": "networking.k8s.io/v1", "kind": "Ingress", "namespace": "shop", "name": name},
                "reason": reason, "message": "something\nmore", "lastTimestamp": last, "count": count, "type": "Warning"
            })
        };
        let events = [
            ev("a", "Sync", "2026-11-18T11:50:00Z", 2),
            ev("a", "Rejected", "2026-11-18T11:58:00Z", 1),
            ev("old", "Sync", "2026-11-18T10:00:00Z", 1),
        ];
        let found = event_issues(&events, now);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].group, "networking.k8s.io");
        assert!(found[0].reason.starts_with("Rejected: something"), "{}", found[0].reason);
        assert!(found[0].reason.ends_with("(×3)"));
    }

    #[test]
    fn scaler_problems() {
        let h = json!({"metadata": {"name": "web", "namespace": "shop"}, "status": {"conditions": [
            {"type": "AbleToScale", "status": "True"},
            {"type": "ScalingActive", "status": "False", "reason": "FailedGetResourceMetric"}
        ]}});
        let off = json!({"metadata": {"name": "off"}, "status": {"conditions": [
            {"type": "ScalingActive", "status": "False", "reason": "ScalingDisabled"}
        ]}});
        let found = scaler_issues(&[h, off]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].reason, "FailedGetResourceMetric");
    }

    #[test]
    fn cronjob_problems() {
        let cj = |status: Value| json!({"metadata": {"name": "backup", "namespace": "ops"}, "spec": {}, "status": status});
        let failed = cj(json!({"lastScheduleTime": "2026-11-19T10:00:00Z", "lastSuccessfulTime": "2026-11-19T09:00:30Z"}));
        let ok = cj(json!({"lastScheduleTime": "2026-11-19T10:00:00Z", "lastSuccessfulTime": "2026-11-19T10:00:40Z"}));
        let running = cj(json!({"lastScheduleTime": "2026-11-19T10:00:00Z", "lastSuccessfulTime": "2026-11-19T09:00:30Z", "active": [{"name": "backup-1"}]}));
        let never = cj(json!({"lastScheduleTime": "2026-11-19T10:00:00Z"}));
        let fresh = cj(json!({}));
        let found = cronjob_issues(&[failed, ok, running.clone(), never, fresh], &[]);
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].reason.as_str(), found[0].severity), ("Last run failed", Severity::Error));
        assert_eq!((found[1].reason.as_str(), found[1].severity), ("No successful run yet", Severity::Warn));

        // Running again, but the runs since the last success failed.
        let job = |name: &str, created: &str| Row {
            uid: String::new(), name: name.into(), namespace: Some("ops".into()), created: Some(created.into()),
            cells: vec![], health: Health::Error, last_restart: None,
        };
        let failed_jobs = [job("backup-29918100", "2026-11-19T09:30:00Z"), job("backup-29918160", "2026-11-19T09:45:00Z"), job("backup-29917000", "2026-11-18T08:00:00Z"), job("backup-db-29918100", "2026-11-19T09:30:00Z")];
        let found = cronjob_issues(&[running], &failed_jobs);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].reason, "Runs failing since the last success");
        assert_eq!(found[0].since.as_deref(), Some("2026-11-19T09:00:30Z"));
    }

    #[test]
    fn rollout_problems() {
        let quota = json!({"spec": {}, "status": {"conditions": [
            {"type": "ReplicaFailure", "status": "True", "reason": "FailedCreate", "message": "pods \"web-1\" is forbidden: exceeded quota", "lastTransitionTime": "2026-11-19T10:00:00Z"}
        ]}});
        let (reason, since) = rollout_problem(&quota).unwrap();
        assert!(reason.starts_with("FailedCreate: pods"), "{reason}");
        assert_eq!(since.as_deref(), Some("2026-11-19T10:00:00Z"));
        let stuck = json!({"spec": {}, "status": {"conditions": [{"type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded"}]}});
        assert!(rollout_problem(&stuck).unwrap().0.contains("deadline"));
        let paused = json!({"spec": {"paused": true}, "status": {"conditions": [{"type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded"}]}});
        assert!(rollout_problem(&paused).is_none());
        let fine = json!({"spec": {}, "status": {"conditions": [{"type": "Progressing", "status": "True", "reason": "NewReplicaSetAvailable"}]}});
        assert!(rollout_problem(&fine).is_none());
    }

    #[test]
    fn sweep_scope() {
        let k = |g: &str, kind: &str| KindRef { group: g.into(), version: "v1".into(), kind: kind.into(), plural: String::new(), namespaced: true, verbs: vec![] };
        assert!(scanned(&k("cert-manager.io", "Certificate")));
        assert!(scanned(&k("apps", "Deployment")));
        assert!(!scanned(&k("", "ConfigMap")));
        assert!(!scanned(&k("", "Secret")));
        assert!(!scanned(&k("", "Pod")));
    }
}

/// Prints what the overview would list, quick checks and full scan:
/// `KC_TEST_CONTEXT=<ctx> cargo test --lib live_health -- --ignored --nocapture`
#[cfg(test)]
mod live_tests {
    #[tokio::test]
    #[ignore]
    async fn live_health() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        crate::kubeconfig::fix_path_env();
        let Ok(ctx) = std::env::var("KC_TEST_CONTEXT") else { return };
        let state = crate::state::AppState::new(std::env::temp_dir().join("steerglass-test/settings.json"));
        let client = state.client(&ctx).await.expect("client");
        let t = std::time::Instant::now();
        let quick = super::quick(&client).await.expect("quick");
        println!("quick: {} issues in {:?}", quick.len(), t.elapsed());
        for i in quick.iter().take(25) {
            println!("  {:?} {}/{} {:?}/{}: {}", i.severity, i.group, i.kind, i.namespace, i.name, i.reason);
        }
        let t = std::time::Instant::now();
        let scan = super::scan(&state, &ctx).await.expect("scan");
        println!("scan: {} kinds, {} issues, skipped {:?}, in {:?}", scan.kinds, scan.items.len(), scan.skipped, t.elapsed());
        let mut by_kind: std::collections::BTreeMap<String, Vec<&super::Issue>> = Default::default();
        for i in &scan.items {
            by_kind.entry(format!("{}/{}", i.group, i.kind)).or_default().push(i);
        }
        for (k, list) in by_kind {
            println!("  {k}: {}", list.len());
            for i in list.iter().take(3) {
                println!("      {:?} {:?}/{}: {}", i.severity, i.namespace, i.name, i.reason);
            }
        }
    }
}
