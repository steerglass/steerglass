//! Lists and watches a kind as server-side tables (what `kubectl get` prints): the API server sends
//! the printed columns plus each object's metadata instead of whole objects, so far less data is
//! downloaded and parsed. kube-rs' watcher only handles whole objects, hence this small list+watch
//! loop of our own.

use std::time::Duration;

use futures::channel::mpsc::Sender;
use futures::{AsyncBufReadExt, SinkExt, StreamExt};
use kube::Client;
use kube::api::{ListParams, WatchParams};
use kube::core::Request;
use serde_json::Value;

use crate::error::Error;
use crate::rows::{self, Row};

const ACCEPT: &str = "application/json;as=Table;v=v1;g=meta.k8s.io, application/json";
const PAGE: u32 = 500;
/// Server-side watch timeout; the watch is then resumed from the last resourceVersion.
const WATCH_SECS: u32 = 290;
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// What the watch of a kind reports, whether it comes from tables or from whole objects.
pub enum Ev {
    /// A full (re)list starts.
    Init,
    Row(Row),
    /// The (re)list is complete: rows not seen since `Init` are gone.
    InitDone,
    Delete(String),
    Error(String),
}

pub struct Target<'a> {
    pub client: Client,
    /// Collection URL, e.g. `/api/v1/namespaces/default/pods`.
    pub url: &'a str,
    pub group: &'a str,
    pub kind: &'a str,
    pub labels: Option<&'a str>,
    pub fields: Option<&'a str>,
}

/// Why [`run`] returned.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// The server can't print this kind with the needed columns: use whole objects instead.
    Unsupported,
    /// The receiver is gone.
    Closed,
}

enum Fail {
    Unsupported,
    /// The resourceVersion is too old (410 Gone): list again.
    Expired,
    Other(String),
}

impl From<kube::Error> for Fail {
    fn from(e: kube::Error) -> Self {
        match &e {
            kube::Error::Api(st) if st.code == 410 => Fail::Expired,
            kube::Error::Api(st) if st.code == 406 || st.code == 415 => Fail::Unsupported,
            _ => Fail::Other(Error::from(e).to_string()),
        }
    }
}

fn with_table(mut req: http::Request<Vec<u8>>) -> std::result::Result<http::Request<Vec<u8>>, Fail> {
    // Both list (limit is always set) and watch URLs already have a query string.
    let uri = format!("{}&includeObject=Metadata", req.uri());
    *req.uri_mut() = uri.parse().map_err(|e: http::uri::InvalidUri| Fail::Other(e.to_string()))?;
    req.headers_mut().insert(http::header::ACCEPT, http::HeaderValue::from_static(ACCEPT));
    Ok(req)
}

fn table_rows(table: &Value) -> &[Value] {
    table.get("rows").and_then(|r| r.as_array()).map(|r| r.as_slice()).unwrap_or(&[])
}

fn row_meta(row: &Value) -> &Value {
    row.pointer("/object/metadata").unwrap_or(&Value::Null)
}

fn cells(row: &Value) -> &[Value] {
    row.get("cells").and_then(|c| c.as_array()).map(|c| c.as_slice()).unwrap_or(&[])
}

/// Lists every page; returns the rows and the resourceVersion to watch from.
async fn list(t: &Target<'_>, layout: &mut Option<Vec<usize>>) -> std::result::Result<(Vec<Row>, String), Fail> {
    let req = Request::new(t.url);
    let mut lp = ListParams::default().limit(PAGE);
    lp.label_selector = t.labels.map(String::from);
    lp.field_selector = t.fields.map(String::from);
    let mut out = Vec::new();
    loop {
        let http_req = with_table(req.list(&lp).map_err(|e| Fail::Other(e.to_string()))?)?;
        let table: Value = t.client.request(http_req).await?;
        if table.get("kind").and_then(|k| k.as_str()) != Some("Table") {
            return Err(Fail::Unsupported);
        }
        if layout.is_none() {
            let defs = table.get("columnDefinitions").and_then(|d| d.as_array()).map(|d| d.as_slice()).unwrap_or(&[]);
            *layout = Some(rows::table_layout(t.group, t.kind, defs).ok_or(Fail::Unsupported)?);
        }
        let cols = layout.as_deref().unwrap_or_default();
        out.extend(table_rows(&table).iter().map(|r| rows::table_row(t.group, t.kind, cols, cells(r), row_meta(r))));
        let rv = table.pointer("/metadata/resourceVersion").and_then(|v| v.as_str()).unwrap_or_default();
        match table.pointer("/metadata/continue").and_then(|v| v.as_str()).filter(|c| !c.is_empty()) {
            Some(c) => lp.continue_token = Some(c.to_string()),
            None => return Ok((out, rv.to_string())),
        }
    }
}

/// Watches from `rv` until the server closes the watch; `rv` follows the events.
async fn watch(t: &Target<'_>, layout: &[usize], rv: &mut String, tx: &mut Sender<Ev>) -> std::result::Result<(), Fail> {
    let mut wp = WatchParams::default().timeout(WATCH_SECS);
    wp.label_selector = t.labels.map(String::from);
    wp.field_selector = t.fields.map(String::from);
    let req = with_table(Request::new(t.url).watch(&wp, rv).map_err(|e| Fail::Other(e.to_string()))?)?;
    let mut lines = t.client.request_stream(req).await?.lines();
    while let Some(line) = lines.next().await {
        let Ok(line) = line else { break };
        let Ok(ev) = serde_json::from_str::<Value>(&line) else { continue };
        let obj = ev.get("object").unwrap_or(&Value::Null);
        let ty = ev.get("type").and_then(|t| t.as_str()).unwrap_or_default();
        if ty == "ERROR" {
            let code = obj.get("code").and_then(|c| c.as_u64()).unwrap_or(0);
            if code == 410 {
                return Err(Fail::Expired);
            }
            return Err(Fail::Other(obj.get("message").and_then(|m| m.as_str()).unwrap_or("watch failed").to_string()));
        }
        // Bookmarks carry no rows, only the resourceVersion to resume from.
        let new_rv = table_rows(obj)
            .iter()
            .filter_map(|r| row_meta(r).get("resourceVersion"))
            .chain(obj.pointer("/metadata/resourceVersion"))
            .filter_map(|v| v.as_str())
            .find(|v| !v.is_empty());
        if let Some(v) = new_rv {
            *rv = v.to_string();
        }
        for r in table_rows(obj) {
            let row = rows::table_row(t.group, t.kind, layout, cells(r), row_meta(r));
            let msg = match ty {
                "ADDED" | "MODIFIED" => Ev::Row(row),
                "DELETED" => Ev::Delete(row.uid),
                _ => continue,
            };
            if tx.send(msg).await.is_err() {
                return Ok(());
            }
        }
    }
    Ok(())
}

/// One-shot list of a kind as rows: server tables when possible, else whole objects.
pub async fn list_rows(client: &Client, url: &str, group: &str, kind: &str) -> std::result::Result<Vec<Row>, String> {
    let t = Target { client: client.clone(), url, group, kind, labels: None, fields: None };
    let mut layout = None;
    if rows::uses_table(group, kind) {
        match list(&t, &mut layout).await {
            Ok((rows, _)) => return Ok(rows),
            Err(Fail::Unsupported) => {}
            Err(Fail::Expired) => return Err("list expired".into()),
            Err(Fail::Other(e)) => return Err(e),
        }
    }
    let req = Request::new(url);
    let mut lp = ListParams::default().limit(PAGE);
    let mut out = Vec::new();
    loop {
        let list: Value = client
            .request(req.list(&lp).map_err(|e| e.to_string())?)
            .await
            .map_err(|e| Error::from(e).to_string())?;
        out.extend(list["items"].as_array().into_iter().flatten().map(|o| rows::to_row(group, kind, o)));
        match list.pointer("/metadata/continue").and_then(|c| c.as_str()).filter(|c| !c.is_empty()) {
            Some(c) => lp.continue_token = Some(c.into()),
            None => return Ok(out),
        }
    }
}

/// Feeds `tx` until it is closed, relisting when the watch expires and retrying errors with backoff.
/// Returns early, before sending anything, if the server can't provide the needed table.
pub async fn run(t: Target<'_>, mut tx: Sender<Ev>) -> Outcome {
    let mut layout: Option<Vec<usize>> = None;
    let mut backoff = Duration::from_secs(1);
    loop {
        let fail = match list(&t, &mut layout).await {
            Ok((rows, mut rv)) => {
                if tx.send(Ev::Init).await.is_err() {
                    return Outcome::Closed;
                }
                for row in rows {
                    if tx.send(Ev::Row(row)).await.is_err() {
                        return Outcome::Closed;
                    }
                }
                if tx.send(Ev::InitDone).await.is_err() {
                    return Outcome::Closed;
                }
                backoff = Duration::from_secs(1);
                let layout = layout.as_deref().unwrap_or_default();
                loop {
                    let started = std::time::Instant::now();
                    match watch(&t, layout, &mut rv, &mut tx).await {
                        Ok(()) if tx.is_closed() => return Outcome::Closed,
                        // Timed out server-side: resume from the last resourceVersion (pausing if
                        // something in between keeps closing the watch right away).
                        Ok(()) => {
                            if started.elapsed() < Duration::from_secs(1) {
                                tokio::time::sleep(Duration::from_secs(1)).await;
                            }
                        }
                        Err(f) => break f,
                    }
                }
            }
            Err(f) => f,
        };
        match fail {
            Fail::Unsupported if layout.is_none() => return Outcome::Unsupported,
            Fail::Unsupported => {}
            Fail::Expired => continue,
            Fail::Other(message) => {
                if tx.send(Ev::Error(message)).await.is_err() {
                    return Outcome::Closed;
                }
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

/// Read-only comparison against a real cluster, tables vs whole objects, for every kind with a table:
/// `KC_TEST_CONTEXT=<ctx> cargo test --lib live_tables -- --ignored --nocapture`
#[cfg(test)]
mod live_tests {
    use super::*;
    use std::collections::HashMap;

    /// Bytes on the wire with the API server's gzip (level 1), measured in memory.
    fn gz(text: &str) -> usize {
        use std::io::Write;
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(1));
        e.write_all(text.as_bytes()).unwrap();
        e.finish().unwrap().len()
    }

    async fn object_rows(client: &Client, url: &str, group: &str, kind: &str) -> (Vec<Row>, usize, usize) {
        let req = Request::new(url);
        let mut lp = ListParams::default().limit(PAGE);
        let (mut rows, mut bytes, mut zipped) = (Vec::new(), 0, 0);
        loop {
            let text = client.request_text(req.list(&lp).unwrap()).await.expect("list objects");
            bytes += text.len();
            zipped += gz(&text);
            let list: Value = serde_json::from_str(&text).unwrap();
            for item in list["items"].as_array().into_iter().flatten() {
                rows.push(rows::to_row(group, kind, item));
            }
            match list.pointer("/metadata/continue").and_then(|c| c.as_str()).filter(|c| !c.is_empty()) {
                Some(c) => lp.continue_token = Some(c.into()),
                None => return (rows, bytes, zipped),
            }
        }
    }

    async fn table_bytes(client: &Client, url: &str) -> (usize, usize) {
        let req = Request::new(url);
        let mut lp = ListParams::default().limit(PAGE);
        let (mut bytes, mut zipped) = (0, 0);
        loop {
            let Ok(r) = with_table(req.list(&lp).unwrap()) else { return (0, 0) };
            let text = client.request_text(r).await.expect("list table");
            bytes += text.len();
            zipped += gz(&text);
            let t: Value = serde_json::from_str(&text).unwrap();
            match t.pointer("/metadata/continue").and_then(|c| c.as_str()).filter(|c| !c.is_empty()) {
                Some(c) => lp.continue_token = Some(c.into()),
                None => return (bytes, zipped),
            }
        }
    }

    #[tokio::test]
    #[ignore]
    async fn live_tables() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        crate::kubeconfig::fix_path_env();
        let Ok(ctx) = std::env::var("KC_TEST_CONTEXT") else { return };
        let state = crate::state::AppState::new(std::env::temp_dir().join("steerglass-test/settings.json"));
        let client = state.client(&ctx).await.expect("client");
        println!("{ctx}: {}", client.apiserver_version().await.unwrap().git_version);
        let kinds = crate::commands::kinds_for(&state, &ctx, false).await.expect("discovery");
        let (mut total_obj, mut total_tab, mut total_obj_gz, mut total_tab_gz) = (0, 0, 0, 0);
        for k in kinds.iter().filter(|k| rows::uses_table(&k.group, &k.kind)) {
            let api = crate::commands::dyn_api(client.clone(), k, None);
            let t = Target { client: client.clone(), url: api.resource_url(), group: &k.group, kind: &k.kind, labels: None, fields: None };
            let mut layout = None;
            let tab = match list(&t, &mut layout).await {
                Ok((rows, _)) => rows,
                Err(Fail::Unsupported) => {
                    println!("{:<28} table unsupported: whole objects", k.kind);
                    continue;
                }
                Err(Fail::Expired) => panic!("expired"),
                Err(Fail::Other(e)) => {
                    println!("{:<28} error: {e}", k.kind);
                    continue;
                }
            };
            let (obj, obj_bytes, obj_gz) = object_rows(&client, api.resource_url(), &k.group, &k.kind).await;
            let (tab_bytes, tab_gz) = table_bytes(&client, api.resource_url()).await;
            total_obj += obj_bytes;
            total_tab += tab_bytes;
            total_obj_gz += obj_gz;
            total_tab_gz += tab_gz;
            let by_uid: HashMap<&str, &Row> = obj.iter().map(|r| (r.uid.as_str(), r)).collect();
            let mut diffs = 0;
            for r in &tab {
                match by_uid.get(r.uid.as_str()) {
                    Some(o) if o.cells == r.cells && o.health == r.health && o.name == r.name && o.created == r.created => {}
                    Some(o) => {
                        diffs += 1;
                        if diffs <= 3 {
                            println!("    {}: objects {:?} {:?}\n    {}  tables  {:?} {:?}", r.name, o.cells, o.health, " ".repeat(r.name.len()), r.cells, r.health);
                        }
                    }
                    None => {} // created between the two lists
                }
            }
            println!(
                "{:<36} {:>5} rows  objects {:>9} B (gzip {:>8})  tables {:>9} B (gzip {:>8})  differing rows: {diffs}",
                format!("{}.{}", k.kind, k.group),
                tab.len(),
                obj_bytes,
                obj_gz,
                tab_bytes,
                tab_gz,
            );
        }
        println!("TOTAL objects {total_obj} B (gzip {total_obj_gz}), tables {total_tab} B (gzip {total_tab_gz})");

        // Watch: the initial list arrives, then live events (Events change often) for a few seconds.
        let ev_kind = kinds.iter().find(|k| k.group.is_empty() && k.kind == "Event").expect("events");
        let api = crate::commands::dyn_api(client.clone(), ev_kind, None);
        let (tx, mut rx) = futures::channel::mpsc::channel(1024);
        let url = api.resource_url().to_string();
        let feed = run(Target { client: client.clone(), url: &url, group: "", kind: "Event", labels: None, fields: None }, tx);
        let read = async {
            let (mut init, mut live, mut synced) = (0, 0, false);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.next()).await {
                match ev {
                    Ev::Row(_) if !synced => init += 1,
                    Ev::Row(_) | Ev::Delete(_) => live += 1,
                    Ev::InitDone => synced = true,
                    Ev::Error(e) => println!("watch error: {e}"),
                    Ev::Init => {}
                }
            }
            println!("watch Events: {init} initial rows, synced {synced}, {live} live changes in 20s");
        };
        tokio::select! { o = feed => println!("feed ended: {o:?}"), _ = read => {} }
    }
}

/// Is gzip really negotiated with the API server? Times a large list with and without it.
/// `KC_TEST_CONTEXT=<ctx> cargo test --lib live_gzip -- --ignored --nocapture`
#[cfg(test)]
mod live_gzip_tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn live_gzip() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        crate::kubeconfig::fix_path_env();
        let Ok(ctx) = std::env::var("KC_TEST_CONTEXT") else { return };
        let state = crate::state::AppState::new(std::env::temp_dir().join("steerglass-test/settings.json"));
        let kc = state.kubeconfig.read().clone();
        let opts = kube::config::KubeConfigOptions { context: Some(ctx.clone()), ..Default::default() };
        for disable in [true, false, true, false] {
            let mut cfg = kube::Config::from_custom_kubeconfig(kc.clone(), &opts).await.unwrap();
            cfg.disable_compression = disable;
            let client = Client::try_from(cfg).unwrap();
            let req = Request::new("/apis/apps/v1/replicasets");
            let mut lp = ListParams::default().limit(PAGE);
            let t = std::time::Instant::now();
            let mut bytes = 0;
            loop {
                let text = client.request_text(req.list(&lp).unwrap()).await.unwrap();
                bytes += text.len();
                let v: Value = serde_json::from_str(&text).unwrap();
                match v.pointer("/metadata/continue").and_then(|c| c.as_str()).filter(|c| !c.is_empty()) {
                    Some(c) => lp.continue_token = Some(c.into()),
                    None => break,
                }
            }
            println!("gzip {:<5} {bytes} B in {:?}", !disable, t.elapsed());
        }
    }
}

/// What `cluster_issues` would report: `KC_TEST_CONTEXT=<ctx> cargo test --lib live_issues -- --ignored --nocapture`
#[cfg(test)]
mod live_issue_tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn live_issues() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        crate::kubeconfig::fix_path_env();
        let Ok(ctx) = std::env::var("KC_TEST_CONTEXT") else { return };
        let state = crate::state::AppState::new(std::env::temp_dir().join("steerglass-test/settings.json"));
        let client = state.client(&ctx).await.expect("client");
        for (url, group, kind) in [("/api/v1/pods", "", "Pod"), ("/api/v1/nodes", "", "Node"), ("/apis/batch/v1/jobs", "batch", "Job")] {
            let t = std::time::Instant::now();
            match list_rows(&client, url, group, kind).await {
                Ok(rows) => {
                    let bad: Vec<_> = rows.iter().filter(|r| r.health == rows::Health::Error).collect();
                    println!("{kind}: {} rows, {} failing, in {:?}", rows.len(), bad.len(), t.elapsed());
                    for r in bad.iter().take(5) {
                        println!("    {} {:?} last restart {:?}", r.name, r.cells.get(1).or(r.cells.first()), r.last_restart);
                    }
                }
                Err(e) => println!("{kind}: error {e}"),
            }
        }
    }
}

/// Time to a full pods table, cold (new client, auth plugin included) and warm:
/// `KC_TEST_CONTEXT=<ctx> cargo test --release --lib live_speed -- --ignored --nocapture`
#[cfg(test)]
mod live_speed_tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn live_speed() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        crate::kubeconfig::fix_path_env();
        let Ok(ctx) = std::env::var("KC_TEST_CONTEXT") else { return };
        let state = crate::state::AppState::new(std::env::temp_dir().join("steerglass-test/settings.json"));
        let t = std::time::Instant::now();
        let client = state.client(&ctx).await.expect("client");
        let rows = list_rows(&client, "/api/v1/pods", "", "Pod").await.expect("pods");
        println!("cold: {} pods in {} ms", rows.len(), t.elapsed().as_millis());
        for _ in 0..3 {
            let t = std::time::Instant::now();
            let client = state.client(&ctx).await.expect("client");
            let rows = list_rows(&client, "/api/v1/pods", "", "Pod").await.expect("pods");
            println!("warm: {} pods in {} ms", rows.len(), t.elapsed().as_millis());
        }
        let t = std::time::Instant::now();
        let rows = list_rows(&client_for(&state, &ctx).await, "/apis/apps/v1/replicasets", "apps", "ReplicaSet").await.expect("rs");
        println!("warm: {} replicasets in {} ms", rows.len(), t.elapsed().as_millis());
    }

    async fn client_for(state: &crate::state::AppState, ctx: &str) -> Client {
        state.client(ctx).await.expect("client")
    }
}
