//! Converts raw Kubernetes objects into compact table rows, kubectl-style.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    Ok,
    Warn,
    Error,
    Neutral,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub uid: String,
    pub name: String,
    pub namespace: Option<String>,
    pub created: Option<String>,
    pub cells: Vec<String>,
    pub health: Health,
    /// Pods: when a container last restarted, shown as "3m ago" next to the restart count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_restart: Option<String>,
}

/// `last_restart` is left out: it only changes along with the restart count, and from server tables
/// it is estimated from a relative time ("5m ago"), so it drifts between otherwise equal updates.
impl PartialEq for Row {
    fn eq(&self, o: &Self) -> bool {
        self.uid == o.uid && self.name == o.name && self.namespace == o.namespace && self.created == o.created && self.cells == o.cells && self.health == o.health
    }
}

/// Extra columns shown for a kind, after Name/Namespace and before Age.
pub fn columns(group: &str, kind: &str) -> Vec<&'static str> {
    match (group, kind) {
        ("", "Pod") => vec!["Ready", "Status", "Restarts", "Node", "IP"],
        ("apps", "Deployment") => vec!["Ready", "Up-to-date", "Available", "Images"],
        ("apps", "StatefulSet") => vec!["Ready", "Images"],
        ("apps", "DaemonSet") => vec!["Desired", "Current", "Ready", "Available"],
        ("apps", "ReplicaSet") => vec!["Desired", "Current", "Ready"],
        ("batch", "Job") => vec!["Completions", "Status"],
        ("batch", "CronJob") => vec!["Schedule", "Suspend", "Active", "Last schedule"],
        ("", "Service") => vec!["Type", "Cluster IP", "External IP", "Ports"],
        ("networking.k8s.io", "Ingress") => vec!["Class", "Hosts", "Address"],
        ("", "ConfigMap") => vec!["Data"],
        ("", "Secret") => vec!["Type", "Data"],
        ("", "PersistentVolumeClaim") => vec!["Status", "Volume", "Capacity", "Access", "Storage class"],
        ("", "PersistentVolume") => vec!["Capacity", "Access", "Reclaim", "Status", "Claim"],
        ("", "Node") => vec!["Status", "Roles", "Version", "Internal IP"],
        ("", "Namespace") => vec!["Status"],
        ("", "ResourceQuota") => vec!["Usage", "Most used", "Resources"],
        ("", "LimitRange") => vec!["Limits"],
        ("", "Event") | ("events.k8s.io", "Event") => vec!["Type", "Reason", "Object", "Count", "Message"],
        ("autoscaling", "HorizontalPodAutoscaler") => vec!["Reference", "Min", "Max", "Replicas"],
        ("", "ServiceAccount") => vec!["Secrets"],
        ("", "Endpoints") => vec!["Endpoints"],
        ("rbac.authorization.k8s.io", "RoleBinding")
        | ("rbac.authorization.k8s.io", "ClusterRoleBinding") => vec!["Role", "Subjects"],
        _ => vec!["Status"],
    }
}

fn s(v: &Value, path: &[&str]) -> String {
    get(v, path).map(value_str).unwrap_or_default()
}

fn get<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p)?;
    }
    if cur.is_null() { None } else { Some(cur) }
}

fn value_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn i(v: &Value, path: &[&str]) -> i64 {
    get(v, path).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn arr<'a>(v: &'a Value, path: &[&str]) -> &'a [Value] {
    get(v, path).and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
}

fn images(v: &Value) -> String {
    arr(v, &["spec", "template", "spec", "containers"])
        .iter()
        .map(|c| {
            let img = s(c, &["image"]);
            img.rsplit('/').next().unwrap_or(&img).to_string()
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn condition<'a>(v: &'a Value, ty: &str) -> Option<&'a Value> {
    arr(v, &["status", "conditions"]).iter().find(|c| c.get("type").and_then(|t| t.as_str()) == Some(ty))
}

fn ratio_health(ready: i64, want: i64) -> Health {
    if want == 0 {
        Health::Neutral
    } else if ready >= want {
        Health::Ok
    } else if ready == 0 {
        Health::Error
    } else {
        Health::Warn
    }
}

pub fn to_row(group: &str, kind: &str, obj: &Value) -> Row {
    let meta = obj.get("metadata").unwrap_or(&Value::Null);
    let (cells, health) = cells_for(group, kind, obj);
    let mut row = with_meta(meta, cells, health);
    if group.is_empty() && kind == "Pod" {
        row.last_restart = pod_last_restart(obj);
    }
    row
}

/// Latest `lastState.terminated.finishedAt` among the pod's containers.
fn pod_last_restart(o: &Value) -> Option<String> {
    arr(o, &["status", "containerStatuses"])
        .iter()
        .chain(arr(o, &["status", "initContainerStatuses"]))
        .filter_map(|c| get(c, &["lastState", "terminated", "finishedAt"]).and_then(|v| v.as_str()))
        .max()
        .map(String::from)
}

/// "5m", "2m30s", "3h4m", "2d", "3y" (kubectl's short durations) → seconds.
fn parse_short_duration(s: &str) -> Option<i64> {
    let (mut total, mut n, mut any) = (0i64, 0i64, false);
    for ch in s.chars() {
        if let Some(d) = ch.to_digit(10) {
            n = n * 10 + d as i64;
            continue;
        }
        total += n * match ch {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            'd' => 86400,
            'y' => 365 * 86400,
            _ => return None,
        };
        n = 0;
        any = true;
    }
    any.then_some(total)
}

fn with_meta(meta: &Value, cells: Vec<String>, mut health: Health) -> Row {
    let name = s(meta, &["name"]);
    let namespace = get(meta, &["namespace"]).map(value_str);
    let uid = get(meta, &["uid"])
        .map(value_str)
        .unwrap_or_else(|| format!("{}/{}", namespace.clone().unwrap_or_default(), name));
    let created = get(meta, &["creationTimestamp"]).map(value_str);
    if get(meta, &["deletionTimestamp"]).is_some() {
        health = Health::Warn;
    }
    Row { uid, name, namespace, created, cells, health, last_restart: None }
}

// ---------------------------------------------------------------- server-side tables

/// Columns of the API server's table (what `kubectl get` prints) that a kind's row is built from.
/// None: the row needs the full object (CRDs, and CronJob, whose "Last Schedule" is a relative
/// time that would go stale in a live view).
fn table_columns(group: &str, kind: &str) -> Option<&'static [&'static str]> {
    Some(match (group, kind) {
        ("", "Pod") => &["Ready", "Status", "Restarts", "Node", "IP"],
        ("apps", "Deployment") => &["Ready", "Up-to-date", "Available", "Images"],
        ("apps", "StatefulSet") => &["Ready", "Images"],
        ("apps", "DaemonSet") => &["Desired", "Current", "Ready", "Available"],
        ("apps", "ReplicaSet") => &["Desired", "Current", "Ready"],
        // "Status" is printed since Kubernetes 1.30; older servers fall back to full objects.
        ("batch", "Job") => &["Completions", "Status"],
        ("", "Service") => &["Type", "Cluster-IP", "External-IP", "Port(s)"],
        ("networking.k8s.io", "Ingress") => &["Class", "Hosts", "Address"],
        ("", "ConfigMap") => &["Data"],
        ("", "Secret") => &["Type", "Data"],
        ("", "PersistentVolumeClaim") => &["Status", "Volume", "Capacity", "Access Modes", "StorageClass"],
        ("", "PersistentVolume") => &["Capacity", "Access Modes", "Reclaim Policy", "Status", "Claim"],
        ("", "Node") => &["Status", "Roles", "Version", "Internal-IP"],
        ("", "Namespace") => &["Status"],
        ("", "Event") | ("events.k8s.io", "Event") => &["Type", "Reason", "Object", "Count", "Message"],
        ("autoscaling", "HorizontalPodAutoscaler") => &["Reference", "MinPods", "MaxPods", "Replicas"],
        ("", "ServiceAccount") => &["Secrets"],
        ("", "Endpoints") => &["Endpoints"],
        ("rbac.authorization.k8s.io", "RoleBinding") | ("rbac.authorization.k8s.io", "ClusterRoleBinding") => {
            &["Role", "Users", "Groups", "ServiceAccounts"]
        }
        _ => return None,
    })
}

pub fn uses_table(group: &str, kind: &str) -> bool {
    table_columns(group, kind).is_some()
}

/// Positions of the needed columns in the server's `columnDefinitions`, or None when one is
/// missing (older servers): the caller then builds rows from full objects.
pub fn table_layout(group: &str, kind: &str, defs: &[Value]) -> Option<Vec<usize>> {
    table_columns(group, kind)?
        .iter()
        .map(|want| defs.iter().position(|d| d.get("name").and_then(|n| n.as_str()) == Some(want)))
        .collect()
}

/// Builds a row from a server table row (`cells` + the object's metadata), with the same columns
/// and health as [`to_row`].
pub fn table_row(group: &str, kind: &str, layout: &[usize], cells: &[Value], meta: &Value) -> Row {
    let c = |n: usize| {
        let v = layout.get(n).and_then(|&i| cells.get(i)).map(value_str).unwrap_or_default();
        match v.as_str() {
            "<none>" | "<unset>" => String::new(),
            _ => v,
        }
    };
    let num = |n: usize| c(n).parse::<i64>().unwrap_or(0);
    let mut last_restart = None;
    let (cells, health) = match (group, kind) {
        ("", "Pod") => {
            let ready = c(0);
            let (r, total) = ratio(&ready);
            // "3 (5m ago)": the relative part would go stale in a live view, so it becomes a timestamp.
            let raw = c(2);
            let mut parts = raw.splitn(2, ' ');
            let restarts = parts.next().unwrap_or("").to_string();
            last_restart = parts
                .next()
                .and_then(|p| p.trim_start_matches('(').strip_suffix(" ago)"))
                .and_then(parse_short_duration)
                .map(|secs| (chrono::Utc::now() - chrono::Duration::seconds(secs)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
            let status = c(1);
            let health = pod_health(&status, r, total);
            (vec![ready, status, restarts, c(3), c(4)], health)
        }
        ("apps", "Deployment") => {
            let ready = c(0);
            let (r, want) = ratio(&ready);
            (vec![ready, c(1), c(2), short_images(&c(3))], ratio_health(r, want))
        }
        ("apps", "StatefulSet") => {
            let ready = c(0);
            let (r, want) = ratio(&ready);
            (vec![ready, short_images(&c(1))], ratio_health(r, want))
        }
        ("apps", "DaemonSet") => (vec![c(0), c(1), c(2), c(3)], ratio_health(num(2), num(0))),
        ("apps", "ReplicaSet") => (vec![c(0), c(1), c(2)], ratio_health(num(2), num(0))),
        ("batch", "Job") => {
            let status = c(1);
            let h = match status.as_str() {
                "Failed" | "FailureTarget" => Health::Error,
                "Complete" | "SuccessCriteriaMet" => Health::Ok,
                _ => Health::Neutral,
            };
            (vec![c(0), status], h)
        }
        ("", "Service") => {
            let ty = c(0);
            let ext = c(2);
            let h = if ty == "LoadBalancer" && (ext.is_empty() || ext == "<pending>") { Health::Warn } else { Health::Neutral };
            (vec![ty, c(1), if ext.is_empty() { "-".into() } else { ext }, c(3).replace(',', " ")], h)
        }
        ("networking.k8s.io", "Ingress") => (vec![c(0), c(1).replace(',', ", "), c(2).replace(',', ", ")], Health::Neutral),
        ("", "ConfigMap") => (vec![c(0)], Health::Neutral),
        ("", "Secret") => (vec![c(0), c(1)], Health::Neutral),
        ("", "PersistentVolumeClaim") => {
            let phase = c(0);
            let h = if phase == "Bound" { Health::Ok } else { Health::Warn };
            (vec![phase, c(1), c(2), c(3), c(4)], h)
        }
        ("", "PersistentVolume") => {
            let phase = c(3);
            let h = match phase.as_str() {
                "Bound" | "Available" => Health::Ok,
                "Failed" => Health::Error,
                _ => Health::Warn,
            };
            (vec![c(0), c(1), c(2), phase, c(4)], h)
        }
        ("", "Node") => {
            let status = c(0);
            let parts: Vec<&str> = status.split(',').collect();
            let h = if !parts.contains(&"Ready") {
                Health::Error
            } else if parts.contains(&"SchedulingDisabled") {
                Health::Warn
            } else {
                Health::Ok
            };
            let roles = c(1);
            (vec![status, if roles.is_empty() { "<none>".into() } else { roles }, c(2), c(3)], h)
        }
        ("", "Namespace") => {
            let phase = c(0);
            let h = if phase == "Active" { Health::Ok } else { Health::Warn };
            (vec![phase], h)
        }
        ("", "Event") | ("events.k8s.io", "Event") => {
            let ty = c(0);
            let h = if ty == "Warning" { Health::Warn } else { Health::Neutral };
            let count = c(3);
            (vec![ty, c(1), c(2), if count.is_empty() { "1".into() } else { count }, c(4)], h)
        }
        ("autoscaling", "HorizontalPodAutoscaler") => {
            let (cur, max) = (num(3), num(2));
            let h = if cur >= max && max > 0 { Health::Warn } else { Health::Neutral };
            let min = c(1);
            (vec![c(0), if min.is_empty() { "1".into() } else { min }, c(2), c(3)], h)
        }
        ("", "ServiceAccount") => (vec![c(0)], Health::Neutral),
        ("", "Endpoints") => {
            let eps = c(0);
            let h = if eps.is_empty() { Health::Warn } else { Health::Ok };
            (vec![eps], h)
        }
        ("rbac.authorization.k8s.io", "RoleBinding") | ("rbac.authorization.k8s.io", "ClusterRoleBinding") => {
            let subjects: Vec<String> = [("User", c(1)), ("Group", c(2)), ("ServiceAccount", c(3))]
                .iter()
                .flat_map(|(k, list)| list.split(", ").filter(|x| !x.is_empty()).map(move |x| format!("{k}:{x}")).collect::<Vec<_>>())
                .collect();
            (vec![c(0), subjects.join(", ")], Health::Neutral)
        }
        _ => (vec![String::new()], Health::Neutral),
    };
    let mut row = with_meta(meta, cells, health);
    row.last_restart = last_restart;
    row
}

/// "2/3" → (2, 3).
fn ratio(s: &str) -> (i64, i64) {
    let mut it = s.split('/').map(|x| x.trim().parse::<i64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0))
}

/// The server prints full image references, comma-separated: keep only the last path segment.
fn short_images(list: &str) -> String {
    list.split(',')
        .filter(|x| !x.is_empty())
        .map(|img| img.rsplit('/').next().unwrap_or(img))
        .collect::<Vec<_>>()
        .join(", ")
}

fn cells_for(group: &str, kind: &str, o: &Value) -> (Vec<String>, Health) {
    match (group, kind) {
        ("", "Pod") => pod(o),
        ("apps", "Deployment") => {
            let want = i(o, &["spec", "replicas"]);
            let ready = i(o, &["status", "readyReplicas"]);
            (
                vec![
                    format!("{ready}/{want}"),
                    i(o, &["status", "updatedReplicas"]).to_string(),
                    i(o, &["status", "availableReplicas"]).to_string(),
                    images(o),
                ],
                ratio_health(ready, want),
            )
        }
        ("apps", "StatefulSet") => {
            let want = i(o, &["spec", "replicas"]);
            let ready = i(o, &["status", "readyReplicas"]);
            (vec![format!("{ready}/{want}"), images(o)], ratio_health(ready, want))
        }
        ("apps", "DaemonSet") => {
            let want = i(o, &["status", "desiredNumberScheduled"]);
            let ready = i(o, &["status", "numberReady"]);
            (
                vec![
                    want.to_string(),
                    i(o, &["status", "currentNumberScheduled"]).to_string(),
                    ready.to_string(),
                    i(o, &["status", "numberAvailable"]).to_string(),
                ],
                ratio_health(ready, want),
            )
        }
        ("apps", "ReplicaSet") => {
            let want = i(o, &["spec", "replicas"]);
            let ready = i(o, &["status", "readyReplicas"]);
            (
                vec![want.to_string(), i(o, &["status", "replicas"]).to_string(), ready.to_string()],
                ratio_health(ready, want),
            )
        }
        ("batch", "Job") => {
            let want = get(o, &["spec", "completions"]).and_then(|v| v.as_i64()).unwrap_or(1);
            let done = i(o, &["status", "succeeded"]);
            let failed = condition(o, "Failed").map(|c| s(c, &["status"]) == "True").unwrap_or(false);
            let complete = condition(o, "Complete").map(|c| s(c, &["status"]) == "True").unwrap_or(false);
            let (status, h) = if failed {
                ("Failed", Health::Error)
            } else if complete {
                ("Complete", Health::Ok)
            } else if i(o, &["status", "active"]) > 0 {
                ("Running", Health::Neutral)
            } else {
                ("Pending", Health::Neutral)
            };
            (vec![format!("{done}/{want}"), status.into()], h)
        }
        ("batch", "CronJob") => (
            vec![
                s(o, &["spec", "schedule"]),
                get(o, &["spec", "suspend"]).and_then(|v| v.as_bool()).unwrap_or(false).to_string(),
                arr(o, &["status", "active"]).len().to_string(),
                s(o, &["status", "lastScheduleTime"]),
            ],
            Health::Neutral,
        ),
        ("", "Service") => {
            let ext: Vec<String> = arr(o, &["status", "loadBalancer", "ingress"])
                .iter()
                .map(|x| {
                    let ip = s(x, &["ip"]);
                    if ip.is_empty() { s(x, &["hostname"]) } else { ip }
                })
                .chain(arr(o, &["spec", "externalIPs"]).iter().map(value_str))
                .collect();
            let ports: Vec<String> = arr(o, &["spec", "ports"])
                .iter()
                .map(|p| {
                    let port = i(p, &["port"]);
                    let np = i(p, &["nodePort"]);
                    let proto = s(p, &["protocol"]);
                    if np > 0 { format!("{port}:{np}/{proto}") } else { format!("{port}/{proto}") }
                })
                .collect();
            let ty = s(o, &["spec", "type"]);
            let health = if ty == "LoadBalancer" && ext.is_empty() { Health::Warn } else { Health::Neutral };
            (
                vec![
                    ty,
                    s(o, &["spec", "clusterIP"]),
                    if ext.is_empty() { "-".into() } else { ext.join(",") },
                    ports.join(" "),
                ],
                health,
            )
        }
        ("networking.k8s.io", "Ingress") => {
            let hosts: Vec<String> = arr(o, &["spec", "rules"]).iter().map(|r| s(r, &["host"])).collect();
            let addr: Vec<String> = arr(o, &["status", "loadBalancer", "ingress"])
                .iter()
                .map(|x| {
                    let ip = s(x, &["ip"]);
                    if ip.is_empty() { s(x, &["hostname"]) } else { ip }
                })
                .collect();
            (vec![s(o, &["spec", "ingressClassName"]), hosts.join(", "), addr.join(", ")], Health::Neutral)
        }
        ("", "ConfigMap") => {
            let n = o.get("data").and_then(|d| d.as_object()).map(|m| m.len()).unwrap_or(0)
                + o.get("binaryData").and_then(|d| d.as_object()).map(|m| m.len()).unwrap_or(0);
            (vec![n.to_string()], Health::Neutral)
        }
        ("", "Secret") => {
            let n = o.get("data").and_then(|d| d.as_object()).map(|m| m.len()).unwrap_or(0);
            (vec![s(o, &["type"]), n.to_string()], Health::Neutral)
        }
        ("", "PersistentVolumeClaim") => {
            let phase = s(o, &["status", "phase"]);
            let h = if phase == "Bound" { Health::Ok } else { Health::Warn };
            (
                vec![
                    phase,
                    s(o, &["spec", "volumeName"]),
                    s(o, &["status", "capacity", "storage"]),
                    access_modes(arr(o, &["spec", "accessModes"])),
                    s(o, &["spec", "storageClassName"]),
                ],
                h,
            )
        }
        ("", "PersistentVolume") => {
            let phase = s(o, &["status", "phase"]);
            let h = match phase.as_str() {
                "Bound" | "Available" => Health::Ok,
                "Failed" => Health::Error,
                _ => Health::Warn,
            };
            let claim = get(o, &["spec", "claimRef"])
                .map(|c| format!("{}/{}", s(c, &["namespace"]), s(c, &["name"])))
                .unwrap_or_default();
            (
                vec![
                    s(o, &["spec", "capacity", "storage"]),
                    access_modes(arr(o, &["spec", "accessModes"])),
                    s(o, &["spec", "persistentVolumeReclaimPolicy"]),
                    phase,
                    claim,
                ],
                h,
            )
        }
        ("", "Node") => {
            let ready = condition(o, "Ready").map(|c| s(c, &["status"]) == "True").unwrap_or(false);
            let unsched = get(o, &["spec", "unschedulable"]).and_then(|v| v.as_bool()).unwrap_or(false);
            let mut status = if ready { "Ready".to_string() } else { "NotReady".to_string() };
            if unsched {
                status.push_str(",SchedulingDisabled");
            }
            let roles: Vec<String> = o
                .pointer("/metadata/labels")
                .and_then(|l| l.as_object())
                .map(|l| {
                    l.keys()
                        .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/").map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let ip = arr(o, &["status", "addresses"])
                .iter()
                .find(|a| s(a, &["type"]) == "InternalIP")
                .map(|a| s(a, &["address"]))
                .unwrap_or_default();
            let h = if !ready { Health::Error } else if unsched { Health::Warn } else { Health::Ok };
            (
                vec![
                    status,
                    if roles.is_empty() { "<none>".into() } else { roles.join(",") },
                    s(o, &["status", "nodeInfo", "kubeletVersion"]),
                    ip,
                ],
                h,
            )
        }
        ("", "Namespace") => {
            let phase = s(o, &["status", "phase"]);
            let h = if phase == "Active" { Health::Ok } else { Health::Warn };
            (vec![phase], h)
        }
        ("", "Event") => {
            let ty = s(o, &["type"]);
            let h = if ty == "Warning" { Health::Warn } else { Health::Neutral };
            let obj = format!("{}/{}", s(o, &["involvedObject", "kind"]).to_lowercase(), s(o, &["involvedObject", "name"]));
            let count = get(o, &["count"]).and_then(|v| v.as_i64()).unwrap_or(1);
            (vec![ty, s(o, &["reason"]), obj, count.to_string(), s(o, &["message"])], h)
        }
        ("events.k8s.io", "Event") => {
            let ty = s(o, &["type"]);
            let h = if ty == "Warning" { Health::Warn } else { Health::Neutral };
            let obj = format!("{}/{}", s(o, &["regarding", "kind"]).to_lowercase(), s(o, &["regarding", "name"]));
            let count = get(o, &["series", "count"]).and_then(|v| v.as_i64()).unwrap_or(1);
            (vec![ty, s(o, &["reason"]), obj, count.to_string(), s(o, &["note"])], h)
        }
        ("autoscaling", "HorizontalPodAutoscaler") => {
            let cur = i(o, &["status", "currentReplicas"]);
            let max = i(o, &["spec", "maxReplicas"]);
            let h = if cur >= max && max > 0 { Health::Warn } else { Health::Neutral };
            (
                vec![
                    format!("{}/{}", s(o, &["spec", "scaleTargetRef", "kind"]), s(o, &["spec", "scaleTargetRef", "name"])),
                    get(o, &["spec", "minReplicas"]).and_then(|v| v.as_i64()).unwrap_or(1).to_string(),
                    max.to_string(),
                    cur.to_string(),
                ],
                h,
            )
        }
        ("", "ServiceAccount") => (vec![arr(o, &["secrets"]).len().to_string()], Health::Neutral),
        ("", "Endpoints") => {
            let eps: Vec<String> = arr(o, &["subsets"])
                .iter()
                .flat_map(|ss| {
                    let ports: Vec<i64> = arr(ss, &["ports"]).iter().map(|p| i(p, &["port"])).collect();
                    arr(ss, &["addresses"]).iter().flat_map(move |a| {
                        let ip = s(a, &["ip"]);
                        let ports = ports.clone();
                        ports.into_iter().map(move |p| format!("{ip}:{p}"))
                    })
                })
                .collect();
            let h = if eps.is_empty() { Health::Warn } else { Health::Ok };
            let text = if eps.len() > 4 {
                format!("{} + {} more", eps[..4].join(","), eps.len() - 4)
            } else {
                eps.join(",")
            };
            (vec![text], h)
        }
        ("rbac.authorization.k8s.io", "RoleBinding") | ("rbac.authorization.k8s.io", "ClusterRoleBinding") => {
            let subjects: Vec<String> = arr(o, &["subjects"])
                .iter()
                .map(|x| format!("{}:{}", s(x, &["kind"]), s(x, &["name"])))
                .collect();
            (
                vec![format!("{}/{}", s(o, &["roleRef", "kind"]), s(o, &["roleRef", "name"])), subjects.join(", ")],
                Health::Neutral,
            )
        }
        ("", "ResourceQuota") => resource_quota(o),
        ("", "LimitRange") => {
            let types: Vec<String> = arr(o, &["spec", "limits"]).iter().map(|l| s(l, &["type"])).collect();
            (vec![types.join(", ")], Health::Neutral)
        }
        _ => generic_status(o),
    }
}

/// A quota's fullest resource: `status.used` against `status.hard` (the spec the server enforces).
/// Warn from 80%, error when full, since new pods are then refused.
fn resource_quota(o: &Value) -> (Vec<String>, Health) {
    let hard = get(o, &["status", "hard"]).or_else(|| get(o, &["spec", "hard"])).and_then(|h| h.as_object());
    let used = get(o, &["status", "used"]);
    let Some(hard) = hard else { return (vec![String::new(), String::new(), "0".into()], Health::Neutral) };
    let mut top: Option<(f64, &str, String, String)> = None;
    for (res, h) in hard {
        let h = value_str(h);
        let u = used.and_then(|x| x.get(res)).map(value_str).unwrap_or_else(|| "0".into());
        let (Some(hv), Some(uv)) = (quantity(&h), quantity(&u)) else { continue };
        let share = if hv > 0.0 { uv / hv } else if uv > 0.0 { 1.0 } else { 0.0 };
        if top.as_ref().is_none_or(|t| share > t.0) {
            top = Some((share, res, u, h));
        }
    }
    let n = hard.len().to_string();
    match top {
        Some((share, res, u, h)) => {
            let health = if share >= 1.0 { Health::Error } else if share >= 0.8 { Health::Warn } else { Health::Ok };
            (vec![format!("{}%", (share * 100.0).round() as i64), format!("{res} {u} / {h}"), n], health)
        }
        None => (vec![String::new(), String::new(), n], Health::Neutral),
    }
}

/// Any Kubernetes quantity ("2", "500m", "4Gi", "1k") as a number.
pub fn quantity(q: &str) -> Option<f64> {
    crate::metrics::parse_bytes(q).or_else(|| crate::metrics::parse_cpu(q))
}

fn access_modes(modes: &[Value]) -> String {
    modes
        .iter()
        .map(|m| match m.as_str().unwrap_or("") {
            "ReadWriteOnce" => "RWO",
            "ReadOnlyMany" => "ROX",
            "ReadWriteMany" => "RWX",
            "ReadWriteOncePod" => "RWOP",
            other => other,
        }.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// For CRDs and other kinds: derive a status from the common `Ready` condition or `status.phase`.
fn generic_status(o: &Value) -> (Vec<String>, Health) {
    for ty in ["Ready", "Available", "Synced", "Healthy"] {
        if let Some(c) = condition(o, ty) {
            let st = s(c, &["status"]);
            let reason = s(c, &["reason"]);
            let h = match st.as_str() {
                "True" => Health::Ok,
                "False" => Health::Error,
                _ => Health::Warn,
            };
            let label = if st == "True" { ty.to_string() } else if reason.is_empty() { format!("Not{ty}") } else { reason };
            return (vec![label], h);
        }
    }
    if let Some(phase) = get(o, &["status", "phase"]).and_then(|p| p.as_str()) {
        let h = match phase {
            "Running" | "Active" | "Bound" | "Succeeded" | "Ready" | "Healthy" => Health::Ok,
            "Failed" | "Error" => Health::Error,
            _ => Health::Neutral,
        };
        return (vec![phase.to_string()], h);
    }
    if let Some(health) = get(o, &["status", "health", "status"]).and_then(|p| p.as_str()) {
        // Argo CD Applications.
        let h = match health {
            "Healthy" => Health::Ok,
            "Degraded" | "Missing" => Health::Error,
            "Progressing" | "Suspended" => Health::Warn,
            _ => Health::Neutral,
        };
        let sync = s(o, &["status", "sync", "status"]);
        return (vec![if sync.is_empty() { health.into() } else { format!("{health} · {sync}") }], h);
    }
    (vec![String::new()], Health::Neutral)
}

/// Mirrors the status column logic of `kubectl get pods`.
fn pod(o: &Value) -> (Vec<String>, Health) {
    let phase = s(o, &["status", "phase"]);
    let mut reason = {
        let r = s(o, &["status", "reason"]);
        if r.is_empty() { phase.clone() } else { r }
    };
    let statuses = arr(o, &["status", "containerStatuses"]);
    let total = arr(o, &["spec", "containers"]).len();
    let mut ready = 0;
    let mut restarts = 0;

    let mut init_reason: Option<String> = None;
    let inits = arr(o, &["status", "initContainerStatuses"]);
    for (idx, c) in inits.iter().enumerate() {
        restarts += i(c, &["restartCount"]);
        if let Some(t) = get(c, &["state", "terminated"]) {
            if i(t, &["exitCode"]) == 0 {
                continue;
            }
            let r = s(t, &["reason"]);
            init_reason = Some(if r.is_empty() { format!("Init:ExitCode:{}", i(t, &["exitCode"])) } else { format!("Init:{r}") });
            break;
        }
        if let Some(w) = get(c, &["state", "waiting"]) {
            let r = s(w, &["reason"]);
            if !r.is_empty() && r != "PodInitializing" {
                init_reason = Some(format!("Init:{r}"));
                break;
            }
        }
        // Sidecar (restartable) init containers that are running don't block.
        if get(c, &["state", "running"]).is_some() && get(c, &["started"]).and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        init_reason = Some(format!("Init:{}/{}", idx, inits.len()));
        break;
    }

    let mut has_running = false;
    for c in statuses.iter().rev() {
        restarts += i(c, &["restartCount"]);
        if get(c, &["ready"]).and_then(|v| v.as_bool()).unwrap_or(false) {
            ready += 1;
        }
        if init_reason.is_some() {
            continue;
        }
        if let Some(w) = get(c, &["state", "waiting"]) {
            let r = s(w, &["reason"]);
            if !r.is_empty() {
                reason = r;
            }
        } else if let Some(t) = get(c, &["state", "terminated"]) {
            let r = s(t, &["reason"]);
            reason = if !r.is_empty() {
                r
            } else if let Some(sig) = get(t, &["signal"]).and_then(|v| v.as_i64()).filter(|x| *x != 0) {
                format!("Signal:{sig}")
            } else {
                format!("ExitCode:{}", i(t, &["exitCode"]))
            };
        } else if get(c, &["state", "running"]).is_some() && get(c, &["ready"]).and_then(|v| v.as_bool()).unwrap_or(false) {
            has_running = true;
        }
    }
    if let Some(r) = init_reason {
        reason = r;
    } else if reason == "Completed" && has_running {
        reason = "Running".into();
    }
    if get(o, &["metadata", "deletionTimestamp"]).is_some() {
        reason = "Terminating".into();
    }

    let health = pod_health(&reason, ready, total as i64);

    (
        vec![
            format!("{ready}/{total}"),
            reason,
            restarts.to_string(),
            s(o, &["spec", "nodeName"]),
            s(o, &["status", "podIP"]),
        ],
        health,
    )
}

fn pod_health(reason: &str, ready: i64, total: i64) -> Health {
    match reason {
        "Running" if ready == total => Health::Ok,
        "Running" => Health::Warn,
        "Succeeded" | "Completed" => Health::Neutral,
        "Pending" | "ContainerCreating" | "PodInitializing" | "Terminating" => Health::Warn,
        r if r.starts_with("Init:") && r.chars().nth(5).is_some_and(|ch| ch.is_ascii_digit()) => Health::Warn,
        _ => Health::Error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pod_crashloop() {
        let p = json!({
            "metadata": {"name": "a", "namespace": "ns", "uid": "1"},
            "spec": {"containers": [{"name": "c"}], "nodeName": "n1"},
            "status": {"phase": "Running", "containerStatuses": [
                {"ready": false, "restartCount": 7, "state": {"waiting": {"reason": "CrashLoopBackOff"}}}
            ]}
        });
        let r = to_row("", "Pod", &p);
        assert_eq!(r.cells[0], "0/1");
        assert_eq!(r.cells[1], "CrashLoopBackOff");
        assert_eq!(r.cells[2], "7");
        assert_eq!(r.health, Health::Error);
    }

    #[test]
    fn pod_running() {
        let p = json!({
            "metadata": {"name": "a", "uid": "1"},
            "spec": {"containers": [{"name": "c"}, {"name": "d"}]},
            "status": {"phase": "Running", "containerStatuses": [
                {"ready": true, "restartCount": 0, "state": {"running": {}}},
                {"ready": true, "restartCount": 1, "state": {"running": {}}}
            ]}
        });
        let r = to_row("", "Pod", &p);
        assert_eq!(r.cells[0], "2/2");
        assert_eq!(r.cells[1], "Running");
        assert_eq!(r.health, Health::Ok);
    }

    #[test]
    fn deployment_partial() {
        let d = json!({"metadata": {"name": "d", "uid": "2"}, "spec": {"replicas": 3, "template": {"spec": {"containers": [{"image": "ghcr.io/org/app:1.2"}]}}}, "status": {"readyReplicas": 2}});
        let r = to_row("apps", "Deployment", &d);
        assert_eq!(r.cells[0], "2/3");
        assert_eq!(r.cells[3], "app:1.2");
        assert_eq!(r.health, Health::Warn);
    }

    #[test]
    fn table_pod() {
        let defs: Vec<Value> = ["Name", "Ready", "Status", "Restarts", "Age", "IP", "Node", "Nominated Node", "Readiness Gates"]
            .iter()
            .map(|n| json!({"name": n}))
            .collect();
        let layout = table_layout("", "Pod", &defs).expect("layout");
        let cells = [json!("a"), json!("1/2"), json!("Running"), json!("3 (5m ago)"), json!("1d"), json!("10.0.0.1"), json!("n1"), json!("<none>"), json!("<none>")];
        let meta = json!({"name": "a", "namespace": "ns", "uid": "1", "creationTimestamp": "2026-01-01T00:00:00Z"});
        let r = table_row("", "Pod", &layout, &cells, &meta);
        assert_eq!(r.cells, vec!["1/2", "Running", "3", "n1", "10.0.0.1"]);
        assert_eq!(r.health, Health::Warn);
        let restarted = chrono::DateTime::parse_from_rfc3339(r.last_restart.as_deref().expect("last restart")).unwrap();
        let ago = chrono::Utc::now().signed_duration_since(restarted).num_seconds();
        assert!((295..=305).contains(&ago), "{ago}");
        assert_eq!((r.uid.as_str(), r.namespace.as_deref()), ("1", Some("ns")));
    }

    #[test]
    fn short_durations() {
        assert_eq!(parse_short_duration("45s"), Some(45));
        assert_eq!(parse_short_duration("2m30s"), Some(150));
        assert_eq!(parse_short_duration("3h4m"), Some(3 * 3600 + 240));
        assert_eq!(parse_short_duration("2d"), Some(2 * 86400));
        assert_eq!(parse_short_duration("soon"), None);
    }

    #[test]
    fn pod_last_restart_from_object() {
        let p = json!({"metadata": {"name": "a", "uid": "1"}, "spec": {"containers": [{}, {}]}, "status": {"phase": "Running", "containerStatuses": [
            {"ready": true, "restartCount": 1, "state": {"running": {}}, "lastState": {"terminated": {"finishedAt": "2026-10-01T10:00:00Z"}}},
            {"ready": true, "restartCount": 2, "state": {"running": {}}, "lastState": {"terminated": {"finishedAt": "2026-10-02T10:00:00Z"}}}
        ]}});
        assert_eq!(to_row("", "Pod", &p).last_restart.as_deref(), Some("2026-10-02T10:00:00Z"));
    }

    #[test]
    fn table_missing_column_falls_back() {
        // Jobs printed without "Status" (Kubernetes before 1.30).
        let defs: Vec<Value> = ["Name", "Completions", "Duration", "Age"].iter().map(|n| json!({"name": n})).collect();
        assert!(table_layout("batch", "Job", &defs).is_none());
        assert!(!uses_table("cert-manager.io", "Certificate"));
    }

    #[test]
    fn table_node_and_deployment() {
        let node = table_row("", "Node", &[0, 1, 2, 3], &[json!("Ready,SchedulingDisabled"), json!("<none>"), json!("v1.35"), json!("10.0.0.2")], &json!({"name": "n"}));
        assert_eq!(node.cells[1], "<none>");
        assert_eq!(node.health, Health::Warn);
        let dep = table_row("apps", "Deployment", &[0, 1, 2, 3], &[json!("0/2"), json!(2), json!(0), json!("ghcr.io/org/app:1,nginx:1.27")], &json!({"name": "d"}));
        assert_eq!(dep.cells, vec!["0/2", "2", "0", "app:1, nginx:1.27"]);
        assert_eq!(dep.health, Health::Error);
    }

    #[test]
    fn quota_fullest_resource() {
        let o = json!({"metadata": {"name": "q", "uid": "1"}, "status": {
            "hard": {"pods": "10", "requests.cpu": "2", "requests.memory": "4Gi"},
            "used": {"pods": "3", "requests.cpu": "1800m", "requests.memory": "1Gi"}}});
        let r = to_row("", "ResourceQuota", &o);
        assert_eq!(r.cells, vec!["90%", "requests.cpu 1800m / 2", "3"]);
        assert_eq!(r.health, Health::Warn);
        let full = json!({"metadata": {"name": "q", "uid": "1"}, "status": {"hard": {"pods": "2"}, "used": {"pods": "2"}}});
        assert_eq!(to_row("", "ResourceQuota", &full).health, Health::Error);
        let empty = json!({"metadata": {"name": "q", "uid": "1"}, "spec": {"hard": {"pods": "5"}}});
        assert_eq!(to_row("", "ResourceQuota", &empty).cells[0], "0%");
    }

    #[test]
    fn generic_ready_condition() {
        let c = json!({"metadata": {"name": "x", "uid": "3"}, "status": {"conditions": [{"type": "Ready", "status": "False", "reason": "Pending"}]}});
        let r = to_row("cert-manager.io", "Certificate", &c);
        assert_eq!(r.cells, vec!["Pending"]);
        assert_eq!(r.health, Health::Error);
    }
}
