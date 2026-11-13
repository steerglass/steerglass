//! Long-running streams pushed to the UI through Tauri channels.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use futures::{AsyncBufReadExt, SinkExt, StreamExt};
use k8s_openapi::api::core::v1::{Pod, Service};
use kube::api::{Api, AttachParams, DynamicObject, ListParams, LogParams, TerminalSize};
use kube::runtime::{WatchStreamExt, watcher};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::commands::dyn_api;
use crate::error::{Error, Result};
use crate::rows::{self, Row};
use crate::state::{AppState, ForwardInfo, KindRef, StreamHandle};
use crate::table::{self, Ev};

const FLUSH_EVERY: Duration = Duration::from_millis(100);

fn register(app: &AppHandle, id: u64, handle: StreamHandle) {
    app.state::<AppState>().streams.lock().insert(id, handle);
}

fn unregister(app: &AppHandle, id: u64) {
    let removed = app.state::<AppState>().streams.lock().remove(&id);
    if removed.is_some_and(|h| h.forward.is_some()) {
        forwards_changed(app);
    }
}

/// Tells the UI to reload the active port-forwards (shown on the ports and in Settings).
fn forwards_changed(app: &AppHandle) {
    let _ = app.emit("forwards", ());
}

#[tauri::command]
pub fn stream_stop(app: AppHandle, state: State<'_, AppState>, id: u64) {
    let forward = state.streams.lock().get(&id).is_some_and(|h| h.forward.is_some());
    state.stop_stream(id);
    if forward {
        forwards_changed(&app);
    }
}

// ---------------------------------------------------------------- watch

/// Builds the row without deep-cloning the object: spec/status are moved, and only the metadata
/// (minus managedFields, often its largest part) is serialized.
fn object_row(group: &str, kind: &str, mut obj: DynamicObject) -> Row {
    obj.metadata.managed_fields = None;
    let mut map = match obj.data {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    if let Ok(meta) = serde_json::to_value(&obj.metadata) {
        map.insert("metadata".into(), meta);
    }
    rows::to_row(group, kind, &serde_json::Value::Object(map))
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WatchMsg {
    /// Rows added or changed since the last message.
    Upsert { rows: Vec<Row> },
    Delete { uids: Vec<String> },
    /// A full (re)list finished: rows whose uid is not listed here are gone.
    Synced { uids: Vec<String> },
    Error { message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStarted {
    pub id: u64,
    pub columns: Vec<&'static str>,
}

/// Batches rows to the UI every [`FLUSH_EVERY`], dropping updates that change no visible column.
async fn forward_rows(mut rx: futures::channel::mpsc::Receiver<Ev>, on_event: Channel<WatchMsg>) {
    let mut upserts: HashMap<String, Row> = HashMap::new();
    let mut deletes: HashSet<String> = HashSet::new();
    // Last row sent per uid: most updates (resourceVersion bumps, conditions heartbeats) don't
    // change any visible column and are dropped here instead of crossing IPC and re-rendering.
    let mut sent: HashMap<String, Row> = HashMap::new();
    let mut init_uids: Option<HashSet<String>> = None;
    let mut tick = tokio::time::interval(FLUSH_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let flush = |upserts: &mut HashMap<String, Row>, deletes: &mut HashSet<String>, sent: &mut HashMap<String, Row>| -> bool {
        if !upserts.is_empty() {
            let rows: Vec<Row> = upserts.drain().map(|(_, r)| r).collect();
            for r in &rows {
                sent.insert(r.uid.clone(), r.clone());
            }
            if on_event.send(WatchMsg::Upsert { rows }).is_err() {
                return false;
            }
        }
        if !deletes.is_empty() {
            let uids: Vec<String> = deletes.drain().collect();
            for u in &uids {
                sent.remove(u);
            }
            if on_event.send(WatchMsg::Delete { uids }).is_err() {
                return false;
            }
        }
        true
    };

    loop {
        tokio::select! {
            ev = rx.next() => {
                let Some(ev) = ev else { break };
                match ev {
                    Ev::Init => init_uids = Some(HashSet::new()),
                    Ev::Row(row) => {
                        if let Some(set) = init_uids.as_mut() {
                            set.insert(row.uid.clone());
                        }
                        deletes.remove(&row.uid);
                        if sent.get(&row.uid) == Some(&row) {
                            upserts.remove(&row.uid);
                        } else {
                            upserts.insert(row.uid.clone(), row);
                        }
                    }
                    Ev::InitDone => {
                        crate::timing("first table loaded");
                        if let Some(seen) = init_uids.as_ref() {
                            sent.retain(|uid, _| seen.contains(uid));
                        }
                        if !flush(&mut upserts, &mut deletes, &mut sent) { break }
                        let uids = init_uids.take().unwrap_or_default().into_iter().collect();
                        if on_event.send(WatchMsg::Synced { uids }).is_err() { break }
                    }
                    Ev::Delete(uid) => {
                        upserts.remove(&uid);
                        deletes.insert(uid);
                    }
                    Ev::Error(message) => {
                        if on_event.send(WatchMsg::Error { message }).is_err() { break }
                    }
                }
            }
            _ = tick.tick() => {
                if !flush(&mut upserts, &mut deletes, &mut sent) { break }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn watch_start(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    kind: KindRef,
    namespace: Option<String>,
    label_selector: Option<String>,
    field_selector: Option<String>,
    on_event: Channel<WatchMsg>,
) -> Result<WatchStarted> {
    let client = state.client(&context).await?;
    let api = dyn_api(client, &kind, namespace.as_deref());
    let id = state.next_id();
    let group = kind.group.clone();
    let kind_name = kind.kind.clone();
    let labels = label_selector.filter(|s| !s.is_empty());
    let fields = field_selector.filter(|s| !s.is_empty());
    let mut cfg = watcher::Config::default().page_size(500);
    if let Some(sel) = &labels {
        cfg = cfg.labels(sel);
    }
    if let Some(sel) = &fields {
        cfg = cfg.fields(sel);
    }

    let app2 = app.clone();
    let task = tokio::spawn(async move {
        let (mut tx, rx) = futures::channel::mpsc::channel::<Ev>(1024);
        let feed = async move {
            // Built-in kinds come as server-side tables; CRDs (and old servers) as whole objects.
            if rows::uses_table(&group, &kind_name) {
                let target = table::Target {
                    client: api.clone().into_client(),
                    url: api.resource_url(),
                    group: &group,
                    kind: &kind_name,
                    labels: labels.as_deref(),
                    fields: fields.as_deref(),
                };
                if table::run(target, tx.clone()).await == table::Outcome::Closed {
                    return;
                }
            }
            let mut stream = watcher(api, cfg).default_backoff().boxed();
            while let Some(ev) = stream.next().await {
                let ev = match ev {
                    Ok(watcher::Event::Init) => Ev::Init,
                    Ok(watcher::Event::InitApply(obj)) | Ok(watcher::Event::Apply(obj)) => Ev::Row(object_row(&group, &kind_name, obj)),
                    Ok(watcher::Event::InitDone) => Ev::InitDone,
                    Ok(watcher::Event::Delete(obj)) => Ev::Delete(match obj.metadata.uid {
                        Some(uid) => uid,
                        None => format!("{}/{}", obj.metadata.namespace.unwrap_or_default(), obj.metadata.name.unwrap_or_default()),
                    }),
                    Err(e) => Ev::Error(match e {
                        watcher::Error::InitialListFailed(k) | watcher::Error::WatchStartFailed(k) | watcher::Error::WatchFailed(k) => Error::from(k).to_string(),
                        watcher::Error::WatchError(st) => format!("{} ({})", st.message, st.reason),
                        other => other.to_string(),
                    }),
                };
                if tx.send(ev).await.is_err() {
                    break;
                }
            }
        };
        tokio::select! {
            _ = feed => {}
            _ = forward_rows(rx, on_event) => {}
        }
        unregister(&app2, id);
    });
    register(&app, id, StreamHandle { abort: task.abort_handle(), stdin: None, resize: None, forward: None });
    Ok(WatchStarted { id, columns: rows::columns(&kind.group, &kind.kind) })
}

// ---------------------------------------------------------------- logs

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogMsg {
    Lines { lines: Vec<String> },
    End,
    Error { message: String },
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn logs_start(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    previous: Option<bool>,
    timestamps: Option<bool>,
    on_event: Channel<LogMsg>,
) -> Result<u64> {
    let client = state.client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let previous = previous.unwrap_or(false);
    let lp = LogParams {
        container,
        follow: !previous,
        previous,
        tail_lines: tail_lines.or(Some(1000)),
        timestamps: timestamps.unwrap_or(false),
        ..Default::default()
    };
    let reader = api.log_stream(&pod, &lp).await?;
    let id = state.next_id();
    let app2 = app.clone();
    let task = tokio::spawn(async move {
        let mut lines = reader.lines().boxed();
        let mut buf: Vec<String> = Vec::new();
        let mut tick = tokio::time::interval(Duration::from_millis(50));
        loop {
            tokio::select! {
                line = lines.next() => match line {
                    Some(Ok(l)) => {
                        buf.push(l);
                        if buf.len() >= 2000 && on_event.send(LogMsg::Lines { lines: std::mem::take(&mut buf) }).is_err() { break }
                    }
                    Some(Err(e)) => {
                        let _ = on_event.send(LogMsg::Lines { lines: std::mem::take(&mut buf) });
                        let _ = on_event.send(LogMsg::Error { message: e.to_string() });
                        break;
                    }
                    None => {
                        let _ = on_event.send(LogMsg::Lines { lines: std::mem::take(&mut buf) });
                        let _ = on_event.send(LogMsg::End);
                        break;
                    }
                },
                _ = tick.tick() => {
                    if !buf.is_empty() && on_event.send(LogMsg::Lines { lines: std::mem::take(&mut buf) }).is_err() { break }
                }
            }
        }
        unregister(&app2, id);
    });
    register(&app, id, StreamHandle { abort: task.abort_handle(), stdin: None, resize: None, forward: None });
    Ok(id)
}

// ---------------------------------------------------------------- exec

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExecMsg {
    Data { data: Vec<u8> },
    Exit { message: Option<String> },
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn exec_start(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    command: Option<Vec<String>>,
    cols: u16,
    rows: u16,
    on_event: Channel<ExecMsg>,
) -> Result<u64> {
    let client = state.client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut ap = AttachParams::interactive_tty();
    ap.container = container;
    let command = command.unwrap_or_else(|| {
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "export TERM=xterm-256color; if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi".into(),
        ]
    });
    let proc = api.exec(&pod, command, &ap).await?;
    run_session(&app, &state, proc, cols, rows, on_event, None)
}

/// Pipes an interactive process (exec or attach) to the UI terminal until either side closes.
pub(crate) fn run_session(
    app: &AppHandle,
    state: &AppState,
    mut proc: kube::api::AttachedProcess,
    cols: u16,
    rows: u16,
    on_event: Channel<ExecMsg>,
    // Dropped when the session ends, however it ends (closed, failed or aborted): cleanup goes in its Drop.
    guard: Option<Box<dyn Send>>,
) -> Result<u64> {
    let mut stdout = proc.stdout().ok_or_else(|| Error::msg("no stdout"))?;
    let mut stdin = proc.stdin().ok_or_else(|| Error::msg("no stdin"))?;
    let mut size_tx = proc.terminal_size();
    let status = proc.take_status();

    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (rs_tx, mut rs_rx) = mpsc::unbounded_channel::<(u16, u16)>();
    let _ = rs_tx.send((cols, rows));

    let id = state.next_id();
    let app2 = app.clone();
    let task = tokio::spawn(async move {
        // Dropping the AttachedProcess aborts the session: it must live as long as this task.
        let _proc = proc;
        let _guard = guard;
        let writer = async {
            while let Some(data) = in_rx.recv().await {
                if stdin.write_all(&data).await.is_err() {
                    break;
                }
            }
        };
        let resizer = async {
            while let Some((width, height)) = rs_rx.recv().await {
                if let Some(tx) = size_tx.as_mut() {
                    use futures::SinkExt;
                    let _ = tx.send(TerminalSize { width, height }).await;
                }
            }
        };
        let reader = async {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if on_event.send(ExecMsg::Data { data: buf[..n].to_vec() }).is_err() {
                            break;
                        }
                    }
                }
            }
        };
        tokio::select! {
            _ = reader => {},
            _ = writer => {},
            _ = resizer => {},
        }
        let message = match status {
            Some(st) => st.await.and_then(|s| if s.status.as_deref() == Some("Success") { None } else { s.message }),
            None => None,
        };
        let _ = on_event.send(ExecMsg::Exit { message });
        unregister(&app2, id);
    });
    register(app, id, StreamHandle { abort: task.abort_handle(), stdin: Some(in_tx), resize: Some(rs_tx), forward: None });
    Ok(id)
}

#[tauri::command]
pub fn exec_input(state: State<'_, AppState>, id: u64, data: String) -> Result<()> {
    state.stream_input(id)?.send(data.into_bytes()).map_err(|_| Error::msg("session closed"))
}

#[tauri::command]
pub fn exec_resize(state: State<'_, AppState>, id: u64, cols: u16, rows: u16) -> Result<()> {
    if let Some(tx) = state.streams.lock().get(&id).and_then(|h| h.resize.clone()) {
        let _ = tx.send((cols, rows));
    }
    Ok(())
}

// ---------------------------------------------------------------- port-forward

/// Picks a ready pod behind a service and resolves the service port to a container port.
async fn resolve_service(api_pods: &Api<Pod>, svc: &Service, port: u16) -> Result<(String, u16)> {
    let spec = svc.spec.as_ref().ok_or_else(|| Error::msg("service has no spec"))?;
    let selector = spec.selector.as_ref().filter(|s| !s.is_empty()).ok_or_else(|| Error::msg("service has no selector"))?;
    let sel = selector.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",");
    let pods = api_pods.list(&ListParams::default().labels(&sel)).await?;
    let pod = pods
        .items
        .iter()
        .find(|p| {
            p.status
                .as_ref()
                .and_then(|s| s.conditions.as_ref())
                .is_some_and(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
        })
        .or(pods.items.first())
        .ok_or_else(|| Error::msg("no pods behind this service"))?;
    let svc_port = spec
        .ports
        .as_ref()
        .and_then(|ps| ps.iter().find(|p| p.port == port as i32))
        .ok_or_else(|| Error::msg(format!("service has no port {port}")))?;
    use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
    let target = match &svc_port.target_port {
        None => port,
        Some(IntOrString::Int(n)) => *n as u16,
        Some(IntOrString::String(named)) => pod
            .spec
            .as_ref()
            .and_then(|s| {
                s.containers.iter().flat_map(|c| c.ports.iter().flatten()).find(|p| p.name.as_deref() == Some(named.as_str()))
            })
            .map(|p| p.container_port as u16)
            .ok_or_else(|| Error::msg(format!("named port {named} not found")))?,
    };
    Ok((pod.metadata.name.clone().unwrap_or_default(), target))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn portforward_start(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    kind: String,
    name: String,
    port: u16,
    local_port: Option<u16>,
) -> Result<ForwardInfo> {
    let target = format!("{}/{}", kind.to_lowercase(), name);
    // Forwarding the same port again reuses the running forward.
    let running = state.streams.lock().values().filter_map(|h| h.forward.clone()).find(|f| {
        f.context == context && f.namespace == namespace && f.target == target && f.remote_port == port && local_port.is_none_or(|l| l == f.local_port)
    });
    if let Some(f) = running {
        return Ok(f);
    }
    let client = state.client(&context).await?;
    let pods: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let (pod, remote_port) = if kind == "Service" {
        let svc = Api::<Service>::namespaced(client.clone(), &namespace).get(&name).await?;
        resolve_service(&pods, &svc, port).await?
    } else {
        (name.clone(), port)
    };
    // A free high port chosen by the OS. Not the remote port itself: on macOS binding 127.0.0.1:6379
    // succeeds even when a local Redis listens on *:6379, and would quietly take its connections.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port.unwrap_or(0))).await?;
    let bound = listener.local_addr()?.port();
    let id = state.next_id();
    let info = ForwardInfo {
        id,
        context,
        namespace,
        target,
        remote_port: port,
        local_port: bound,
    };
    let app2 = app.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut conn, _)) = listener.accept().await {
            let pods = pods.clone();
            let pod = pod.clone();
            tokio::spawn(async move {
                let Ok(mut pf) = pods.portforward(&pod, &[remote_port]).await else { return };
                let Some(mut upstream) = pf.take_stream(remote_port) else { return };
                let _ = tokio::io::copy_bidirectional(&mut conn, &mut upstream).await;
                drop(upstream);
                let _ = pf.join().await;
            });
        }
        unregister(&app2, id);
    });
    register(&app, id, StreamHandle { abort: task.abort_handle(), stdin: None, resize: None, forward: Some(info.clone()) });
    forwards_changed(&app);
    Ok(info)
}

#[tauri::command]
pub fn portforward_list(state: State<'_, AppState>) -> Vec<ForwardInfo> {
    let mut v: Vec<ForwardInfo> = state.streams.lock().values().filter_map(|h| h.forward.clone()).collect();
    v.sort_by_key(|f| f.id);
    v
}


/// Exec with and without gzip negotiated, running only `echo`:
/// `KC_TEST_CONTEXT=<ctx> KC_TEST_POD=<ns>/<pod>[/<container>] cargo test --lib live_exec -- --ignored --nocapture`
#[cfg(test)]
mod live_exec_tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn live_exec() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        crate::kubeconfig::fix_path_env();
        let (Ok(ctx), Ok(target)) = (std::env::var("KC_TEST_CONTEXT"), std::env::var("KC_TEST_POD")) else { return };
        let parts: Vec<&str> = target.split('/').collect();
        let state = AppState::new(std::env::temp_dir().join("steerglass-test/settings.json"));
        let kc = state.kubeconfig.read().clone();
        let opts = kube::config::KubeConfigOptions { context: Some(ctx.clone()), ..Default::default() };
        for disable in [false, true] {
            let mut cfg = kube::Config::from_custom_kubeconfig(kc.clone(), &opts).await.unwrap();
            cfg.disable_compression = disable;
            let client = kube::Client::try_from(cfg).unwrap();
            let api: Api<Pod> = Api::namespaced(client, parts[0]);
            let mut ap = AttachParams::default().stdout(true).stderr(true);
            ap.container = parts.get(2).map(|c| c.to_string());
            match api.exec(parts[1], vec!["echo", "steerglass-ok"], &ap).await {
                Ok(mut proc) => {
                    let mut out = String::new();
                    if let Some(mut so) = proc.stdout() {
                        let _ = so.read_to_string(&mut out).await;
                    }
                    println!("gzip {}: exec ok, output {:?}", !disable, out.trim());
                }
                Err(e) => println!("gzip {}: exec failed: {e}", !disable),
            }
        }

        // What the Shell tab does: an interactive TTY running the shell picker.
        let client = state.client(&ctx).await.expect("client");
        let api: Api<Pod> = Api::namespaced(client, parts[0]);
        let mut ap = AttachParams::interactive_tty();
        ap.container = parts.get(2).map(|c| c.to_string());
        let command = vec![
            "/bin/sh".to_string(),
            "-c".into(),
            "export TERM=xterm-256color; if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi".into(),
        ];
        let mut proc = match api.exec(parts[1], command, &ap).await {
            Ok(p) => p,
            Err(e) => {
                println!("tty exec failed: {e}");
                return;
            }
        };
        let mut stdout = proc.stdout().expect("stdout");
        let mut stdin = proc.stdin().expect("stdin");
        let status = proc.take_status();
        if let Some(mut tx) = proc.terminal_size() {
            use futures::SinkExt;
            let _ = tx.send(TerminalSize { width: 120, height: 30 }).await;
        }
        let _ = stdin.write_all(b"echo steerglass-tty-ok; exit\n").await;
        let mut out = Vec::new();
        let mut buf = vec![0u8; 8192];
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            match tokio::time::timeout_at(deadline, stdout.read(&mut buf)).await {
                Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
                Ok(Ok(n)) => out.extend_from_slice(&buf[..n]),
            }
        }
        println!("tty output: {:?}", String::from_utf8_lossy(&out));
        if let Some(st) = status {
            println!("tty status: {:?}", st.await.map(|s| (s.status, s.message, s.reason)));
        }
    }
}
