//! CPU and memory usage from metrics-server (`metrics.k8s.io`), next to the requests and limits of
//! the pod specs, plus a history sampled while a cluster is open: metrics-server only knows "now".

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use kube::Client;
use kube::api::ListParams;
use kube::core::Request;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::error::{Error, Result};
use crate::state::AppState;

/// Pod specs (for requests and limits) are re-read at most this often…
const SPECS_MAX_AGE: Duration = Duration::from_secs(120);
/// …or sooner when metrics mention a pod we don't know, but not more often than this.
const SPECS_MIN_AGE: Duration = Duration::from_secs(20);
/// Full-resolution samples are kept this long, then one per minute up to `KEEP_COARSE_MS`.
const KEEP_FINE_MS: i64 = 60 * 60 * 1000;
const KEEP_COARSE_MS: i64 = 24 * 60 * 60 * 1000;
const COARSE_STEP_MS: i64 = 60 * 1000;
/// Pods not sampled for this long (deleted, or their cluster closed) are forgotten.
const FORGET_AFTER_MS: i64 = 30 * 60 * 1000;
const TOP_PODS: usize = 6;

// ---------------------------------------------------------------- quantities

/// Kubernetes CPU quantity ("250m", "1", "0.5", "123456789n") in cores.
pub fn parse_cpu(q: &str) -> Option<f64> {
    let q = q.trim();
    let (num, scale) = match q.char_indices().last()? {
        (i, 'n') => (&q[..i], 1e-9),
        (i, 'u') => (&q[..i], 1e-6),
        (i, 'm') => (&q[..i], 1e-3),
        (i, 'k') => (&q[..i], 1e3),
        _ => (q, 1.0),
    };
    num.parse::<f64>().ok().map(|n| n * scale)
}

/// Kubernetes memory quantity ("128Mi", "1G", "123456Ki", "1e9") in bytes.
pub fn parse_bytes(q: &str) -> Option<f64> {
    let q = q.trim();
    const BIN: [(&str, f64); 6] = [("Ki", 1024.0), ("Mi", 1048576.0), ("Gi", 1073741824.0), ("Ti", 1099511627776.0), ("Pi", 1125899906842624.0), ("Ei", 1152921504606846976.0)];
    for (suffix, mult) in BIN {
        if let Some(n) = q.strip_suffix(suffix) {
            return n.parse::<f64>().ok().map(|n| n * mult);
        }
    }
    const DEC: [(&str, f64); 7] = [("k", 1e3), ("K", 1e3), ("M", 1e6), ("G", 1e9), ("T", 1e12), ("P", 1e15), ("E", 1e18)];
    for (suffix, mult) in DEC {
        if let Some(n) = q.strip_suffix(suffix) {
            return n.parse::<f64>().ok().map(|n| n * mult);
        }
    }
    if let Some(n) = q.strip_suffix('m') {
        return n.parse::<f64>().ok().map(|n| n / 1000.0);
    }
    q.parse::<f64>().ok()
}

// ---------------------------------------------------------------- state

#[derive(Clone, Default)]
struct ContainerSpec {
    name: String,
    req_cpu: f64,
    req_mem: f64,
    lim_cpu: Option<f64>,
    lim_mem: Option<f64>,
}

#[derive(Clone, Default)]
struct PodSpec {
    node: Option<String>,
    /// Running or pending: counts towards the node's requests.
    active: bool,
    containers: Vec<ContainerSpec>,
}

impl PodSpec {
    fn requests(&self) -> (f64, f64) {
        self.containers.iter().fold((0.0, 0.0), |(c, m), k| (c + k.req_cpu, m + k.req_mem))
    }
    /// The pod's limit is only defined when every container has one.
    fn limits(&self) -> (Option<f64>, Option<f64>) {
        let all = |f: fn(&ContainerSpec) -> Option<f64>| self.containers.iter().map(f).sum::<Option<f64>>();
        (all(|k| k.lim_cpu), all(|k| k.lim_mem))
    }
}

struct Specs {
    at: Instant,
    pods: HashMap<(String, String), PodSpec>,
}

#[derive(Clone, Copy, Serialize)]
pub struct Sample {
    /// Unix time in ms.
    t: i64,
    /// Cores.
    cpu: f32,
    /// Bytes.
    mem: f32,
}

#[derive(Default)]
struct History {
    fine: VecDeque<Sample>,
    coarse: VecDeque<Sample>,
    containers: Vec<ContainerSample>,
}

impl History {
    fn push(&mut self, s: Sample) {
        if self.fine.back().is_some_and(|l| l.t >= s.t) {
            return;
        }
        self.fine.push_back(s);
        while self.fine.front().is_some_and(|f| s.t - f.t > KEEP_FINE_MS) {
            let old = self.fine.pop_front().unwrap_or(s);
            if self.coarse.back().is_none_or(|c| old.t - c.t >= COARSE_STEP_MS) {
                self.coarse.push_back(old);
            }
        }
        while self.coarse.front().is_some_and(|c| s.t - c.t > KEEP_COARSE_MS) {
            self.coarse.pop_front();
        }
    }
    fn last_t(&self) -> i64 {
        self.fine.back().map(|s| s.t).unwrap_or(0)
    }
    fn latest(&self) -> Option<Sample> {
        self.fine.back().copied()
    }
}

/// Lives in [`AppState`]: pod specs and usage history per context.
#[derive(Default)]
pub struct Metrics {
    specs: Mutex<HashMap<String, Specs>>,
    /// (context, namespace, pod) → history.
    history: Mutex<HashMap<(String, String, String), History>>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn get_req(url: &str) -> Result<http::Request<Vec<u8>>> {
    http::Request::get(url).body(Vec::new()).map_err(|e| Error::msg(e.to_string()))
}

/// GET on the metrics API; `None` when metrics-server isn't installed or reachable.
async fn metrics_get(client: &Client, url: &str) -> Result<Option<Value>> {
    match client.request::<Value>(get_req(url)?).await {
        Ok(v) => Ok(Some(v)),
        Err(kube::Error::Api(st)) if matches!(st.code, 404 | 503) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn str_at<'a>(v: &'a Value, ptr: &str) -> Option<&'a str> {
    v.pointer(ptr).and_then(|x| x.as_str())
}

fn pod_spec(item: &Value) -> PodSpec {
    let phase = str_at(item, "/status/phase").unwrap_or("");
    PodSpec {
        node: str_at(item, "/spec/nodeName").map(String::from),
        active: !matches!(phase, "Succeeded" | "Failed"),
        containers: item
            .pointer("/spec/containers")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
            .map(|c| ContainerSpec {
                name: str_at(c, "/name").unwrap_or("").to_string(),
                req_cpu: str_at(c, "/resources/requests/cpu").and_then(parse_cpu).unwrap_or(0.0),
                req_mem: str_at(c, "/resources/requests/memory").and_then(parse_bytes).unwrap_or(0.0),
                lim_cpu: str_at(c, "/resources/limits/cpu").and_then(parse_cpu),
                lim_mem: str_at(c, "/resources/limits/memory").and_then(parse_bytes),
            })
            .collect(),
    }
}

/// Every pod's spec in the cluster (requests and limits change rarely: cached).
async fn fetch_specs(client: &Client) -> Result<HashMap<(String, String), PodSpec>> {
    let req = Request::new("/api/v1/pods");
    let mut lp = ListParams::default().limit(500);
    let mut pods = HashMap::new();
    loop {
        let list: Value = client.request(req.list(&lp).map_err(|e| Error::msg(e.to_string()))?).await?;
        for item in list["items"].as_array().into_iter().flatten() {
            let ns = str_at(item, "/metadata/namespace").unwrap_or("").to_string();
            let name = str_at(item, "/metadata/name").unwrap_or("").to_string();
            pods.insert((ns, name), pod_spec(item));
        }
        match str_at(&list, "/metadata/continue").filter(|c| !c.is_empty()) {
            Some(c) => lp.continue_token = Some(c.to_string()),
            None => return Ok(pods),
        }
    }
}

impl Metrics {
    /// Refreshes the context's pod specs when stale, or when `missing` pods aren't in them yet.
    async fn ensure_specs(&self, ctx: &str, client: &Client, missing: bool) {
        let stale = match self.specs.lock().get(ctx) {
            None => true,
            Some(s) => s.at.elapsed() > SPECS_MAX_AGE || (missing && s.at.elapsed() > SPECS_MIN_AGE),
        };
        if !stale {
            return;
        }
        // Without permission to list pods, usage still shows, only without requests and limits.
        let pods = fetch_specs(client).await.unwrap_or_default();
        self.specs.lock().insert(ctx.to_string(), Specs { at: Instant::now(), pods });
    }

    fn spec(&self, ctx: &str, ns: &str, name: &str) -> Option<PodSpec> {
        self.specs.lock().get(ctx).and_then(|s| s.pods.get(&(ns.to_string(), name.to_string())).cloned())
    }

    fn record(&self, ctx: &str, ns: &str, name: &str, sample: Sample, containers: Vec<ContainerSample>) {
        let mut h = self.history.lock();
        let entry = h.entry((ctx.to_string(), ns.to_string(), name.to_string())).or_default();
        entry.push(sample);
        entry.containers = containers;
    }

    fn forget_stale(&self) {
        let cutoff = now_ms() - FORGET_AFTER_MS;
        self.history.lock().retain(|_, h| h.last_t() >= cutoff);
    }
}

/// Latest usage per container: (name, cores, bytes).
type ContainerSample = (String, f64, f64);

/// One pod in a metrics-server response.
struct PodMetrics {
    ns: String,
    name: String,
    cpu: f64,
    mem: f64,
    containers: Vec<ContainerSample>,
}

fn parse_pod_metrics(item: &Value) -> PodMetrics {
    let ns = str_at(item, "/metadata/namespace").unwrap_or("").to_string();
    let name = str_at(item, "/metadata/name").unwrap_or("").to_string();
    let containers: Vec<ContainerSample> = item["containers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            (
                str_at(c, "/name").unwrap_or("").to_string(),
                str_at(c, "/usage/cpu").and_then(parse_cpu).unwrap_or(0.0),
                str_at(c, "/usage/memory").and_then(parse_bytes).unwrap_or(0.0),
            )
        })
        .collect();
    let (cpu, mem) = containers.iter().fold((0.0, 0.0), |(c, m), k| (c + k.1, m + k.2));
    PodMetrics { ns, name, cpu, mem, containers }
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodUsage {
    namespace: String,
    name: String,
    cpu: f64,
    mem: f64,
    cpu_request: f64,
    mem_request: f64,
    cpu_limit: Option<f64>,
    mem_limit: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodUsageReport {
    /// False when the cluster has no (reachable) metrics-server.
    available: bool,
    pods: Vec<PodUsage>,
}

/// Current usage of every pod in the context (one namespace when given), recorded into the history.
/// The UI calls it every few seconds for the open clusters.
#[tauri::command]
pub async fn pod_usage(state: State<'_, AppState>, context: String, namespace: Option<String>) -> Result<PodUsageReport> {
    pod_usage_in(&state, context, namespace).await
}

async fn pod_usage_in(state: &AppState, context: String, namespace: Option<String>) -> Result<PodUsageReport> {
    let client = state.client(&context).await?;
    let url = match namespace.as_deref().filter(|n| !n.is_empty()) {
        Some(ns) => format!("/apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods"),
        None => "/apis/metrics.k8s.io/v1beta1/pods".to_string(),
    };
    let Some(list) = metrics_get(&client, &url).await? else {
        return Ok(PodUsageReport { available: false, pods: Vec::new() });
    };
    let m = &state.metrics;
    let items: Vec<_> = list["items"].as_array().into_iter().flatten().map(parse_pod_metrics).collect();
    let missing = items.iter().any(|p| m.spec(&context, &p.ns, &p.name).is_none());
    m.ensure_specs(&context, &client, missing).await;
    let t = now_ms();
    let pods = items
        .into_iter()
        .map(|PodMetrics { ns, name, cpu, mem, containers }| {
            m.record(&context, &ns, &name, Sample { t, cpu: cpu as f32, mem: mem as f32 }, containers);
            let spec = m.spec(&context, &ns, &name).unwrap_or_default();
            let (cpu_request, mem_request) = spec.requests();
            let (cpu_limit, mem_limit) = spec.limits();
            PodUsage { namespace: ns, name, cpu, mem, cpu_request, mem_request, cpu_limit, mem_limit }
        })
        .collect();
    m.forget_stale();
    Ok(PodUsageReport { available: true, pods })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerUsage {
    name: String,
    cpu: f64,
    mem: f64,
    cpu_limit: Option<f64>,
    mem_limit: Option<f64>,
    cpu_request: f64,
    mem_request: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodHistory {
    available: bool,
    samples: Vec<Sample>,
    containers: Vec<ContainerUsage>,
    cpu_request: f64,
    mem_request: f64,
    cpu_limit: Option<f64>,
    mem_limit: Option<f64>,
}

/// A pod's usage over the last `seconds`, from the history; fetched on the spot if there is none yet.
#[tauri::command]
pub async fn pod_history(state: State<'_, AppState>, context: String, namespace: String, name: String, seconds: i64) -> Result<PodHistory> {
    pod_history_in(&state, context, namespace, name, seconds).await
}

async fn pod_history_in(state: &AppState, context: String, namespace: String, name: String, seconds: i64) -> Result<PodHistory> {
    let m = &state.metrics;
    let key = (context.clone(), namespace.clone(), name.clone());
    let fresh = m.history.lock().get(&key).is_some_and(|h| now_ms() - h.last_t() < 30_000);
    let client = state.client(&context).await?;
    if !fresh {
        let url = format!("/apis/metrics.k8s.io/v1beta1/namespaces/{namespace}/pods/{name}");
        match metrics_get(&client, &url).await {
            Ok(Some(item)) => {
                let p = parse_pod_metrics(&item);
                m.record(&context, &namespace, &name, Sample { t: now_ms(), cpu: p.cpu as f32, mem: p.mem as f32 }, p.containers);
            }
            Ok(None) if !m.history.lock().contains_key(&key) => {
                return Ok(PodHistory { available: false, samples: vec![], containers: vec![], cpu_request: 0.0, mem_request: 0.0, cpu_limit: None, mem_limit: None });
            }
            // Not measured yet (just started) or a transient error: show what we have.
            _ => {}
        }
    }
    let missing = m.spec(&context, &namespace, &name).is_none();
    m.ensure_specs(&context, &client, missing).await;
    let spec = m.spec(&context, &namespace, &name).unwrap_or_default();
    let since = now_ms() - seconds.clamp(60, KEEP_COARSE_MS / 1000) * 1000;
    let h = m.history.lock();
    let (samples, current) = match h.get(&key) {
        Some(h) => (
            h.coarse.iter().chain(h.fine.iter()).filter(|s| s.t >= since).copied().collect(),
            h.containers.clone(),
        ),
        None => (Vec::new(), Vec::new()),
    };
    let containers = current
        .into_iter()
        .map(|(cname, cpu, mem)| {
            let c = spec.containers.iter().find(|c| c.name == cname).cloned().unwrap_or_default();
            ContainerUsage { name: cname, cpu, mem, cpu_limit: c.lim_cpu, mem_limit: c.lim_mem, cpu_request: c.req_cpu, mem_request: c.req_mem }
        })
        .collect();
    let (cpu_request, mem_request) = spec.requests();
    let (cpu_limit, mem_limit) = spec.limits();
    Ok(PodHistory { available: true, samples, containers, cpu_request, mem_request, cpu_limit, mem_limit })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeUsage {
    name: String,
    cpu: Option<f64>,
    mem: Option<f64>,
    cpu_allocatable: f64,
    mem_allocatable: f64,
    cpu_requested: f64,
    mem_requested: f64,
    pods: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopPod {
    namespace: String,
    name: String,
    cpu: f64,
    mem: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeUsageReport {
    available: bool,
    nodes: Vec<NodeUsage>,
    top: Vec<TopPod>,
}

/// Per node: usage, allocatable capacity and what the pods on it request; plus the busiest pods.
#[tauri::command]
pub async fn node_usage(state: State<'_, AppState>, context: String) -> Result<NodeUsageReport> {
    node_usage_in(&state, context).await
}

async fn node_usage_in(state: &AppState, context: String) -> Result<NodeUsageReport> {
    let client = state.client(&context).await?;
    let m = &state.metrics;
    let (usage, nodes) = tokio::join!(
        metrics_get(&client, "/apis/metrics.k8s.io/v1beta1/nodes"),
        client.request::<Value>(get_req("/api/v1/nodes")?)
    );
    let nodes = nodes?;
    let usage = usage.unwrap_or(None);
    let used: HashMap<String, (f64, f64)> = usage
        .as_ref()
        .and_then(|u| u["items"].as_array())
        .into_iter()
        .flatten()
        .map(|n| {
            (
                str_at(n, "/metadata/name").unwrap_or("").to_string(),
                (
                    str_at(n, "/usage/cpu").and_then(parse_cpu).unwrap_or(0.0),
                    str_at(n, "/usage/memory").and_then(parse_bytes).unwrap_or(0.0),
                ),
            )
        })
        .collect();
    m.ensure_specs(&context, &client, false).await;
    let mut requested: HashMap<String, (f64, f64, usize)> = HashMap::new();
    if let Some(specs) = m.specs.lock().get(&context) {
        for spec in specs.pods.values().filter(|p| p.active) {
            if let Some(node) = &spec.node {
                let (c, mm) = spec.requests();
                let e = requested.entry(node.clone()).or_default();
                e.0 += c;
                e.1 += mm;
                e.2 += 1;
            }
        }
    }
    let nodes = nodes["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|n| {
            let name = str_at(n, "/metadata/name").unwrap_or("").to_string();
            let (cpu_requested, mem_requested, pods) = requested.get(&name).copied().unwrap_or_default();
            let u = used.get(&name);
            NodeUsage {
                cpu: u.map(|u| u.0),
                mem: u.map(|u| u.1),
                cpu_allocatable: str_at(n, "/status/allocatable/cpu").and_then(parse_cpu).unwrap_or(0.0),
                mem_allocatable: str_at(n, "/status/allocatable/memory").and_then(parse_bytes).unwrap_or(0.0),
                cpu_requested,
                mem_requested,
                pods,
                name,
            }
        })
        .collect();
    // The busiest pods, from the samples taken in the last minute.
    let recent = now_ms() - 60_000;
    let mut top: Vec<TopPod> = m
        .history
        .lock()
        .iter()
        .filter(|((ctx, ..), h)| *ctx == context && h.last_t() >= recent)
        .filter_map(|((_, ns, name), h)| h.latest().map(|s| TopPod { namespace: ns.clone(), name: name.clone(), cpu: s.cpu as f64, mem: s.mem as f64 }))
        .collect();
    top.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
    top.truncate(TOP_PODS);
    Ok(NodeUsageReport { available: usage.is_some(), nodes, top })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantities() {
        assert_eq!(parse_cpu("250m"), Some(0.25));
        assert_eq!(parse_cpu("2"), Some(2.0));
        assert_eq!(parse_cpu("1500000n"), Some(0.0015));
        assert_eq!(parse_bytes("128Mi"), Some(128.0 * 1048576.0));
        assert_eq!(parse_bytes("1G"), Some(1e9));
        assert_eq!(parse_bytes("1e3"), Some(1000.0));
        assert_eq!(parse_bytes("2048Ki"), Some(2.0 * 1048576.0));
        assert_eq!(parse_bytes("junk"), None);
    }

    #[test]
    fn history_downsamples_old_samples() {
        let mut h = History::default();
        let start = 0;
        // Two hours of samples every 15 s.
        for i in 0..(2 * 60 * 4) {
            h.push(Sample { t: start + i * 15_000, cpu: 1.0, mem: 1.0 });
        }
        assert!(h.fine.len() <= 241, "{}", h.fine.len());
        // The hour that aged out is kept at one sample per minute.
        assert!((59..=61).contains(&h.coarse.len()), "{}", h.coarse.len());
    }

    #[test]
    fn pod_limits_need_every_container() {
        let spec = PodSpec {
            node: None,
            active: true,
            containers: vec![
                ContainerSpec { name: "a".into(), req_cpu: 0.1, req_mem: 1.0, lim_cpu: Some(0.5), lim_mem: Some(2.0) },
                ContainerSpec { name: "b".into(), req_cpu: 0.2, req_mem: 1.0, lim_cpu: None, lim_mem: Some(2.0) },
            ],
        };
        assert_eq!(spec.limits(), (None, Some(4.0)));
        let (c, m) = spec.requests();
        assert!((c - 0.3).abs() < 1e-9 && m == 2.0);
    }
}

/// Read-only check against a real cluster: `KC_TEST_CONTEXT=<ctx> cargo test --lib live_metrics -- --ignored --nocapture`
#[cfg(test)]
mod live_tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn live_metrics() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        crate::kubeconfig::fix_path_env();
        let Ok(ctx) = std::env::var("KC_TEST_CONTEXT") else { return };
        let state = AppState::new(std::env::temp_dir().join("steerglass-test/settings.json"));
        let t = Instant::now();
        let usage = pod_usage_in(&state, ctx.clone(), None).await.expect("pod usage");
        println!("pod_usage: available {}, {} pods in {:?}", usage.available, usage.pods.len(), t.elapsed());
        let with_limits = usage.pods.iter().filter(|p| p.cpu_limit.is_some()).count();
        println!("  {} with a CPU limit, {} with a CPU request", with_limits, usage.pods.iter().filter(|p| p.cpu_request > 0.0).count());
        if let Some(p) = usage.pods.iter().max_by(|a, b| a.cpu.total_cmp(&b.cpu)) {
            println!("  busiest: {}/{} cpu {:.3} cores mem {:.0} MiB, request {:.3} limit {:?}", p.namespace, p.name, p.cpu, p.mem / 1048576.0, p.cpu_request, p.cpu_limit);
            let h = pod_history_in(&state, ctx.clone(), p.namespace.clone(), p.name.clone(), 3600).await.expect("history");
            println!("  history: {} samples, {} containers", h.samples.len(), h.containers.len());
        }
        let t = Instant::now();
        let nodes = node_usage_in(&state, ctx.clone()).await.expect("node usage");
        println!("node_usage: available {}, {} nodes in {:?}, top {}", nodes.available, nodes.nodes.len(), t.elapsed(), nodes.top.len());
        for n in nodes.nodes.iter().take(3) {
            println!(
                "  {}: cpu {:?}/{:.1} (req {:.2}), mem {:?}/{:.1} GiB (req {:.1}), {} pods",
                n.name,
                n.cpu.map(|c| (c * 100.0).round() / 100.0),
                n.cpu_allocatable,
                n.cpu_requested,
                n.mem.map(|m| (m / 1073741824.0 * 10.0).round() / 10.0),
                n.mem_allocatable / 1073741824.0,
                n.mem_requested / 1073741824.0,
                n.pods
            );
        }
    }
}
