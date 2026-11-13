use std::sync::Arc;
use std::time::Duration;

use k8s_openapi::api::core::v1::{Namespace, Node, Pod};
use kube::api::{Api, DeleteParams, DynamicObject, ListParams, Patch, PatchParams, PostParams};
use kube::discovery::{Discovery, Scope};
use kube::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::error::{Error, Result};
use crate::kubeconfig::{LoadReport, Settings};
use crate::state::{AppState, KindRef};

const FIELD_MANAGER: &str = "steerglass";

pub fn dyn_api(client: Client, kind: &KindRef, namespace: Option<&str>) -> Api<DynamicObject> {
    let ar = kind.api_resource();
    match (kind.namespaced, namespace.filter(|n| !n.is_empty())) {
        (true, Some(ns)) => Api::namespaced_with(client, ns, &ar),
        _ => Api::all_with(client, &ar),
    }
}

// ---------------------------------------------------------------- contexts

#[tauri::command]
pub fn list_contexts(state: State<'_, AppState>) -> LoadReport {
    state.report.read().clone()
}

#[tauri::command]
pub fn reload_contexts(state: State<'_, AppState>) -> LoadReport {
    state.reload()
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.read().clone()
}

#[tauri::command]
pub fn update_settings(state: State<'_, AppState>, settings: Settings) -> Result<LoadReport> {
    *state.settings.write() = settings;
    state.save_settings()?;
    Ok(state.reload())
}

/// Remembers access to a user-picked file or folder (needed inside the macOS sandbox).
/// Files are also added as kubeconfig sources.
#[tauri::command]
pub fn grant_access(state: State<'_, AppState>, path: String) -> Result<LoadReport> {
    use base64::Engine;
    let data = crate::sandbox::create(&path).map_err(Error::Msg)?;
    {
        let mut s = state.settings.write();
        if !data.is_empty() {
            s.bookmarks.insert(path.clone(), base64::engine::general_purpose::STANDARD.encode(data));
        }
        let p = std::path::PathBuf::from(&path);
        if p.is_file() && !s.extra_kubeconfigs.contains(&p) {
            s.extra_kubeconfigs.push(p);
        }
    }
    state.save_settings()?;
    Ok(state.reload())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub sandboxed: bool,
    pub kube_dir: Option<String>,
}

#[tauri::command]
pub fn environment() -> Environment {
    Environment {
        sandboxed: crate::sandbox::is_sandboxed(),
        kube_dir: crate::kubeconfig::kube_dir().map(|p| p.display().to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterSummary {
    pub version: String,
    pub platform: String,
    pub nodes: usize,
    pub nodes_ready: usize,
    pub pods: Option<i64>,
    pub namespaces: Option<usize>,
    pub latency_ms: u128,
}

/// Node count and how many are Ready. Reads the server-side table (a few bytes per node) rather than
/// the full Node objects, which list every cached image and weigh tens of KB each.
async fn node_counts(client: &Client) -> Result<(usize, usize)> {
    let req = http::Request::get("/api/v1/nodes?includeObject=None")
        .header(http::header::ACCEPT, "application/json;as=Table;v=v1;g=meta.k8s.io, application/json")
        .body(Vec::new())
        .map_err(|e| Error::msg(e.to_string()))?;
    let table: serde_json::Value = client.request(req).await?;
    let status_col = table["columnDefinitions"]
        .as_array()
        .and_then(|cols| cols.iter().position(|c| c["name"] == "Status"));
    let (Some(col), Some(rows)) = (status_col, table["rows"].as_array()) else {
        // Not a Table (very old or unusual API servers): count from the full objects.
        let list = Api::<Node>::all(client.clone()).list(&ListParams::default()).await?;
        let ready = list
            .items
            .iter()
            .filter(|n| {
                n.status
                    .as_ref()
                    .and_then(|s| s.conditions.as_ref())
                    .is_some_and(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
            })
            .count();
        return Ok((list.items.len(), ready));
    };
    // Status reads "Ready", "Ready,SchedulingDisabled", "NotReady", …
    let ready = rows
        .iter()
        .filter(|r| r["cells"][col].as_str().is_some_and(|s| s.split(',').any(|p| p == "Ready")))
        .count();
    Ok((rows.len(), ready))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub kind: &'static str,
    pub namespace: Option<String>,
    pub name: String,
    pub reason: String,
    /// When the problem started, as far as it is known (last restart, creation).
    pub since: Option<String>,
}

const MAX_ISSUES: usize = 50;

/// What needs attention in a cluster: failing pods, nodes that aren't ready, failed jobs.
/// Kinds the user can't list are skipped; the call fails only when none can be read.
#[tauri::command]
pub async fn cluster_issues(state: State<'_, AppState>, context: String) -> Result<Vec<Issue>> {
    let fut = async {
        let client = state.client(&context).await?;
        let (pods, nodes, jobs) = tokio::join!(
            crate::table::list_rows(&client, "/api/v1/pods", "", "Pod"),
            crate::table::list_rows(&client, "/api/v1/nodes", "", "Node"),
            crate::table::list_rows(&client, "/apis/batch/v1/jobs", "batch", "Job"),
        );
        if let (Err(e), Err(_), Err(_)) = (&pods, &nodes, &jobs) {
            return Err(Error::msg(e.clone()));
        }
        let failing = |rows: std::result::Result<Vec<crate::rows::Row>, String>| {
            rows.unwrap_or_default().into_iter().filter(|r| r.health == crate::rows::Health::Error)
        };
        let mut issues: Vec<Issue> = Vec::new();
        for r in failing(pods) {
            issues.push(Issue { kind: "Pod", reason: r.cells.get(1).cloned().unwrap_or_default(), since: r.last_restart.or(r.created), namespace: r.namespace, name: r.name });
        }
        for r in failing(nodes) {
            issues.push(Issue { kind: "Node", reason: r.cells.first().cloned().unwrap_or_default(), since: None, namespace: None, name: r.name });
        }
        for r in failing(jobs) {
            issues.push(Issue { kind: "Job", reason: r.cells.get(1).cloned().unwrap_or_default(), since: r.created, namespace: r.namespace, name: r.name });
        }
        // Nodes first (they affect everything on them), then the most recent problems.
        issues.sort_by(|a, b| (a.kind != "Node").cmp(&(b.kind != "Node")).then_with(|| b.since.cmp(&a.since)));
        issues.truncate(MAX_ISSUES);
        Ok(issues)
    };
    match tokio::time::timeout(Duration::from_secs(30), fut).await {
        Ok(r) => r,
        Err(_) => Err(Error::msg("timed out")),
    }
}

/// Lightweight health probe used by the multi-cluster overview.
#[tauri::command]
pub async fn cluster_summary(state: State<'_, AppState>, context: String) -> Result<ClusterSummary> {
    let fut = async {
        let client = state.client(&context).await?;
        let started = std::time::Instant::now();
        let info = client.apiserver_version().await?;
        let latency_ms = started.elapsed().as_millis();
        crate::timing("first cluster reachable");

        let pods_api: Api<Pod> = Api::all(client.clone());
        let ns_api: Api<Namespace> = Api::all(client.clone());
        let all = ListParams::default();
        let one = ListParams::default().limit(1);
        let (nodes, pods, nss) = tokio::join!(node_counts(&client), pods_api.list_metadata(&one), ns_api.list_metadata(&all));
        let (nodes_total, nodes_ready) = nodes.unwrap_or((0, 0));
        let pods = pods
            .ok()
            .map(|l| l.metadata.remaining_item_count.unwrap_or(0) + l.items.len() as i64);
        Ok::<_, Error>(ClusterSummary {
            version: info.git_version,
            platform: info.platform,
            nodes: nodes_total,
            nodes_ready,
            pods,
            namespaces: nss.ok().map(|l| l.items.len()),
            latency_ms,
        })
    };
    match tokio::time::timeout(Duration::from_secs(20), fut).await {
        Ok(r) => {
            if r.is_err() {
                // Drop a possibly broken client (expired credentials, etc.) so the next try reconnects.
                state.forget_client(&context);
            }
            r
        }
        Err(_) => {
            state.forget_client(&context);
            Err(Error::msg("timed out connecting to the cluster"))
        }
    }
}

#[tauri::command]
pub async fn list_namespaces(state: State<'_, AppState>, context: String) -> Result<Vec<String>> {
    let client = state.client(&context).await?;
    let api: Api<Namespace> = Api::all(client);
    match api.list_metadata(&ListParams::default()).await {
        Ok(list) => {
            let mut names: Vec<String> = list.items.into_iter().filter_map(|n| n.metadata.name).collect();
            names.sort();
            Ok(names)
        }
        // Users with namespace-scoped RBAC can't list namespaces: fall back to the context default.
        Err(kube::Error::Api(s)) if s.code == 403 => {
            Ok(state.default_namespace(&context).into_iter().collect())
        }
        Err(e) => Err(e.into()),
    }
}

// ---------------------------------------------------------------- discovery

async fn run_discovery(client: Client) -> Result<Vec<KindRef>> {
    let discovery = match Discovery::new(client.clone()).run_aggregated().await {
        Ok(d) => d,
        Err(_) => Discovery::new(client).run().await?,
    };
    let mut out = Vec::new();
    for group in discovery.groups() {
        for (ar, caps) in group.recommended_resources() {
            if !caps.supports_operation("list") || !caps.supports_operation("watch") {
                continue;
            }
            out.push(KindRef {
                group: ar.group.clone(),
                version: ar.version.clone(),
                kind: ar.kind.clone(),
                plural: ar.plural.clone(),
                namespaced: matches!(caps.scope, Scope::Namespaced),
                verbs: caps.operations.clone(),
            });
        }
    }
    // Prefer the core events API over events.k8s.io: it is what kubectl shows by default.
    out.retain(|k| !(k.group == "events.k8s.io" && k.kind == "Event"));
    out.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.group.cmp(&b.group)));
    Ok(out)
}

pub async fn kinds_for(state: &AppState, context: &str, refresh: bool) -> Result<Arc<Vec<KindRef>>> {
    if !refresh && let Some(k) = state.discovery.lock().get(context) {
        return Ok(k.clone());
    }
    let client = state.client(context).await?;
    let kinds = Arc::new(run_discovery(client).await?);
    state.discovery.lock().insert(context.to_string(), kinds.clone());
    Ok(kinds)
}

#[tauri::command]
pub async fn discover(state: State<'_, AppState>, context: String, refresh: Option<bool>) -> Result<Vec<KindRef>> {
    Ok(kinds_for(&state, &context, refresh.unwrap_or(false)).await?.as_ref().clone())
}

// ---------------------------------------------------------------- objects

fn clean(mut v: Value) -> Value {
    if let Some(meta) = v.get_mut("metadata").and_then(|m| m.as_object_mut()) {
        meta.remove("managedFields");
    }
    v
}

#[tauri::command]
pub async fn get_object(
    state: State<'_, AppState>,
    context: String,
    kind: KindRef,
    namespace: Option<String>,
    name: String,
) -> Result<Value> {
    let api = dyn_api(state.client(&context).await?, &kind, namespace.as_deref());
    let obj = api.get(&name).await?;
    Ok(clean(serde_json::to_value(obj)?))
}

#[tauri::command]
pub async fn get_yaml(
    state: State<'_, AppState>,
    context: String,
    kind: KindRef,
    namespace: Option<String>,
    name: String,
) -> Result<String> {
    let v = get_object(state, context, kind, namespace, name).await?;
    Ok(serde_yaml::to_string(&v)?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    yaml: String,
    /// Edits Kubernetes ignored: fields under `status`, which only the cluster writes.
    ignored: Vec<IgnoredEdit>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredEdit {
    path: String,
    /// The `spec` field of the same name, when there is one: where the change belongs.
    spec_path: Option<String>,
}

/// Replaces an object with the edited YAML (optimistic concurrency via resourceVersion).
/// `original` is the YAML the editor loaded, used to tell which `status` fields were edited.
#[tauri::command]
pub async fn replace_yaml(
    state: State<'_, AppState>,
    context: String,
    kind: KindRef,
    namespace: Option<String>,
    name: String,
    yaml: String,
    original: Option<String>,
) -> Result<Saved> {
    let value: Value = serde_yaml::from_str(&yaml)?;
    let ignored = original
        .and_then(|o| serde_yaml::from_str::<Value>(&o).ok())
        .map(|o| ignored_status_edits(&o, &value))
        .unwrap_or_default();
    let obj: DynamicObject = serde_json::from_value(value)?;
    if obj.metadata.name.as_deref() != Some(name.as_str()) {
        return Err(Error::msg("metadata.name cannot be changed"));
    }
    let api = dyn_api(state.client(&context).await?, &kind, namespace.as_deref());
    let saved = api.replace(&name, &PostParams { field_manager: Some(FIELD_MANAGER.into()), ..Default::default() }, &obj).await?;
    Ok(Saved { yaml: serde_yaml::to_string(&clean(serde_json::to_value(saved)?))?, ignored })
}

/// The `status` fields that differ between the loaded and the edited object.
fn ignored_status_edits(original: &Value, edited: &Value) -> Vec<IgnoredEdit> {
    let mut paths = Vec::new();
    diff_paths(original.get("status").unwrap_or(&Value::Null), edited.get("status").unwrap_or(&Value::Null), "status", &mut paths);
    paths
        .into_iter()
        .map(|path| {
            // status.replicas -> spec.replicas, when spec has that field (only plain object keys).
            let rest = &path["status".len()..];
            let spec_path = (!rest.is_empty() && !rest.contains('['))
                .then(|| format!("spec{rest}"))
                .filter(|p| edited.pointer(&format!("/{}", p.replace('.', "/"))).is_some());
            IgnoredEdit { path, spec_path }
        })
        .collect()
}

fn diff_paths(a: &Value, b: &Value, path: &str, out: &mut Vec<String>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let mut keys: Vec<&String> = x.keys().chain(y.keys().filter(|k| !x.contains_key(*k))).collect();
            keys.sort();
            for k in keys {
                diff_paths(x.get(k).unwrap_or(&Value::Null), y.get(k).unwrap_or(&Value::Null), &format!("{path}.{k}"), out);
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                diff_paths(p, q, &format!("{path}[{i}]"), out);
            }
        }
        _ if a != b => out.push(path.to_string()),
        _ => {}
    }
}

/// Server-side applies one or more YAML documents (like `kubectl apply`).
#[tauri::command]
pub async fn apply_manifest(
    state: State<'_, AppState>,
    context: String,
    yaml: String,
    default_namespace: Option<String>,
) -> Result<Vec<String>> {
    let kinds = kinds_for(&state, &context, false).await?;
    let client = state.client(&context).await?;
    let mut applied = Vec::new();
    let docs = serde_yaml::Deserializer::from_str(&yaml)
        .map(Value::deserialize)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for value in docs.into_iter().filter(|v| !v.is_null()) {
        let api_version = value.get("apiVersion").and_then(|v| v.as_str()).unwrap_or_default();
        let kind_name = value.get("kind").and_then(|v| v.as_str()).unwrap_or_default();
        let (group, version) = match api_version.split_once('/') {
            Some((g, v)) => (g, v),
            None => ("", api_version),
        };
        let kind = kinds
            .iter()
            .find(|k| k.group == group && k.kind == kind_name)
            .cloned()
            .map(|mut k| {
                k.version = version.to_string();
                k
            })
            .ok_or_else(|| Error::msg(format!("unknown resource type {api_version}/{kind_name}")))?;
        let obj: DynamicObject = serde_json::from_value(value)?;
        let name = obj.metadata.name.clone().ok_or_else(|| Error::msg("metadata.name is required"))?;
        let ns = obj.metadata.namespace.clone().or_else(|| default_namespace.clone());
        let api = dyn_api(client.clone(), &kind, ns.as_deref().or(Some("default")));
        api.patch(&name, &PatchParams::apply(FIELD_MANAGER).force(), &Patch::Apply(&obj)).await?;
        applied.push(format!("{}/{}", kind.kind.to_lowercase(), name));
    }
    Ok(applied)
}

#[tauri::command]
pub async fn delete_object(
    state: State<'_, AppState>,
    context: String,
    kind: KindRef,
    namespace: Option<String>,
    name: String,
    force: Option<bool>,
) -> Result<()> {
    let api = dyn_api(state.client(&context).await?, &kind, namespace.as_deref());
    let dp = if force.unwrap_or(false) {
        DeleteParams { grace_period_seconds: Some(0), ..Default::default() }
    } else {
        DeleteParams::default()
    };
    api.delete(&name, &dp).await?;
    Ok(())
}

async fn merge_patch(state: &AppState, context: &str, kind: &KindRef, namespace: Option<&str>, name: &str, patch: Value) -> Result<()> {
    let api = dyn_api(state.client(context).await?, kind, namespace);
    api.patch(name, &PatchParams { field_manager: Some(FIELD_MANAGER.into()), ..Default::default() }, &Patch::Merge(&patch))
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn scale(
    state: State<'_, AppState>,
    context: String,
    kind: KindRef,
    namespace: Option<String>,
    name: String,
    replicas: i32,
) -> Result<()> {
    merge_patch(&state, &context, &kind, namespace.as_deref(), &name, json!({"spec": {"replicas": replicas}})).await
}

/// Equivalent to `kubectl rollout restart`.
#[tauri::command]
pub async fn rollout_restart(
    state: State<'_, AppState>,
    context: String,
    kind: KindRef,
    namespace: Option<String>,
    name: String,
) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let patch = json!({"spec": {"template": {"metadata": {"annotations": {"kubectl.kubernetes.io/restartedAt": now}}}}});
    merge_patch(&state, &context, &kind, namespace.as_deref(), &name, patch).await
}

#[tauri::command]
pub async fn set_cordon(state: State<'_, AppState>, context: String, name: String, cordon: bool) -> Result<()> {
    let kind = KindRef {
        group: String::new(),
        version: "v1".into(),
        kind: "Node".into(),
        plural: "nodes".into(),
        namespaced: false,
        verbs: vec![],
    };
    merge_patch(&state, &context, &kind, None, &name, json!({"spec": {"unschedulable": cordon}})).await
}

#[tauri::command]
pub async fn suspend_cronjob(
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    name: String,
    suspend: bool,
) -> Result<()> {
    let kind = KindRef {
        group: "batch".into(),
        version: "v1".into(),
        kind: "CronJob".into(),
        plural: "cronjobs".into(),
        namespaced: true,
        verbs: vec![],
    };
    merge_patch(&state, &context, &kind, Some(&namespace), &name, json!({"spec": {"suspend": suspend}})).await
}


#[cfg(test)]
mod status_edit_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_status_edits_and_the_matching_spec_field() {
        let original = json!({"spec": {"replicas": 3}, "status": {"replicas": 3, "readyReplicas": 3, "conditions": [{"type": "Available"}]}});
        let edited = json!({"spec": {"replicas": 3}, "status": {"replicas": 5, "readyReplicas": 3, "conditions": [{"type": "Ready"}]}});
        assert_eq!(
            ignored_status_edits(&original, &edited),
            vec![
                IgnoredEdit { path: "status.conditions[0].type".into(), spec_path: None },
                IgnoredEdit { path: "status.replicas".into(), spec_path: Some("spec.replicas".into()) },
            ]
        );
    }

    #[test]
    fn spec_edits_are_not_reported() {
        let original = json!({"spec": {"replicas": 3}, "status": {"replicas": 3}});
        let edited = json!({"spec": {"replicas": 5}, "status": {"replicas": 3}});
        assert!(ignored_status_edits(&original, &edited).is_empty());
    }
}

/// True in builds for the Mac App Store, which updates the app itself.
#[tauri::command]
pub fn app_store_build() -> bool {
    cfg!(feature = "appstore")
}
