//! Terminals that need a container started first:
//! - debug containers (`kubectl debug pod`): when a container has no shell, an ephemeral container with
//!   a toolbox image is added to the pod, sharing the target's processes;
//! - node shells (`kubectl debug node`): a privileged pod on the node that enters the host's namespaces.
use std::collections::HashSet;
use std::time::Duration;

use k8s_openapi::api::core::v1::{ContainerStatus, Event, Pod};
use kube::api::{Api, AttachParams, DeleteParams, ListParams, Patch, PatchParams, PostParams};
use serde_json::json;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::state::AppState;
use crate::streams::{run_session, ExecMsg};

/// How long to wait for the image pull and start before giving up.
const START_TIMEOUT: Duration = Duration::from_secs(300);
const SPINNER: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/// Namespace for node-shell pods.
const NODE_SHELL_NAMESPACE: &str = "default";

fn send(on_event: &Channel<ExecMsg>, text: String) {
    let _ = on_event.send(ExecMsg::Data { data: text.into_bytes() });
}

fn note(on_event: &Channel<ExecMsg>, text: &str) {
    send(on_event, format!("\x1b[2m{text}\x1b[0m\r\n"));
}

/// A name not used by any container in the pod yet: `debugger-xxxxx`, like `kubectl debug`.
fn container_name(pod: &Pod) -> String {
    let spec = pod.spec.as_ref();
    let taken = |n: &str| {
        spec.is_some_and(|s| {
            s.containers.iter().any(|c| c.name == n)
                || s.init_containers.iter().flatten().any(|c| c.name == n)
                || s.ephemeral_containers.iter().flatten().any(|c| c.name == n)
        })
    };
    let mut seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    loop {
        let suffix: String = (0..5)
            .map(|_| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                b"bcdfghjklmnpqrstvwxz2456789"[(seed >> 33) as usize % 27] as char
            })
            .collect();
        let name = format!("debugger-{suffix}");
        if !taken(&name) {
            return name;
        }
    }
}

/// Where a container is: Ok(true) running, Ok(false) still starting, Err when it can't start.
fn started(pod: &Pod, name: &str, ephemeral: bool) -> std::result::Result<bool, String> {
    let status = pod.status.as_ref();
    let list: Option<&Vec<ContainerStatus>> =
        status.and_then(|s| if ephemeral { s.ephemeral_container_statuses.as_ref() } else { s.container_statuses.as_ref() });
    let Some(state) = list.and_then(|l| l.iter().find(|c| c.name == name)).and_then(|s| s.state.as_ref()) else {
        // Not created yet; a pod that can't be scheduled says so in its conditions.
        let unschedulable = status
            .and_then(|s| s.conditions.as_ref())
            .and_then(|c| c.iter().find(|c| c.type_ == "PodScheduled" && c.status == "False" && c.reason.as_deref() == Some("Unschedulable")));
        if let Some(c) = unschedulable {
            return Err(format!("the pod can't be scheduled: {}", c.message.as_deref().unwrap_or_default()));
        }
        return Ok(false);
    };
    if state.running.is_some() {
        return Ok(true);
    }
    if let Some(t) = &state.terminated {
        let why = t.message.as_deref().filter(|m| !m.is_empty()).or(t.reason.as_deref()).unwrap_or("no reason given");
        return Err(format!("the container exited: {why}"));
    }
    if let Some(w) = &state.waiting {
        let reason = w.reason.as_deref().unwrap_or_default();
        if matches!(reason, "ErrImagePull" | "ImagePullBackOff" | "InvalidImageName" | "CreateContainerError" | "CreateContainerConfigError") {
            return Err(format!("{reason}: {}", w.message.as_deref().unwrap_or_default()));
        }
    }
    Ok(false)
}

/// The stage shown on the progress line, from the container's latest event.
fn stage(reason: &str) -> &'static str {
    match reason {
        "Pulling" => "Downloading the image",
        "Pulled" | "Created" => "Starting",
        "Started" => "Attaching",
        _ => "Waiting for the container",
    }
}

/// Waits for the container to run, showing a live progress line and the container's events
/// (Kubernetes reports pull stages, not bytes, so there is no percentage to show).
async fn wait_running(pods: &Api<Pod>, events: &Api<Event>, pod: &str, container: &str, ephemeral: bool, on_event: &Channel<ExecMsg>) -> Result<()> {
    let field = if ephemeral { format!("spec.ephemeralContainers{{{container}}}") } else { format!("spec.containers{{{container}}}") };
    let selector = ListParams::default().fields(&format!("involvedObject.name={pod}"));
    let begun = tokio::time::Instant::now();
    let mut seen = HashSet::new();
    let mut current = "Waiting for the container";
    for tick in 0usize.. {
        // Events are best effort: without permission to list them only the progress line is shown.
        if let Ok(list) = events.list(&selector).await {
            let mut fresh: Vec<_> = list
                .items
                .into_iter()
                .filter(|e| e.involved_object.field_path.as_deref().is_none_or(|f| f == field))
                .filter(|e| seen.insert(e.metadata.uid.clone().unwrap_or_default()))
                .collect();
            fresh.sort_by_key(|e| e.last_timestamp.as_ref().map(|t| t.0).or(e.event_time.as_ref().map(|t| t.0)));
            for e in fresh {
                let reason = e.reason.unwrap_or_default();
                current = stage(&reason);
                send(on_event, format!("\r\x1b[2K\x1b[2m{reason}: {}\x1b[0m\r\n", e.message.unwrap_or_default()));
            }
        }
        match started(&pods.get(pod).await?, container, ephemeral) {
            Ok(true) => {
                send(on_event, "\r\x1b[2K".into());
                return Ok(());
            }
            Err(e) => {
                send(on_event, "\r\x1b[2K".into());
                return Err(Error::msg(e));
            }
            Ok(false) if begun.elapsed() > START_TIMEOUT => {
                send(on_event, "\r\x1b[2K".into());
                return Err(Error::msg(format!("{container} did not start within {}s", START_TIMEOUT.as_secs())));
            }
            Ok(false) => {}
        }
        // Four spinner frames per check, so the line moves while the API is polled once a second.
        for frame in 0..4 {
            let secs = begun.elapsed().as_secs();
            send(on_event, format!("\r\x1b[2K\x1b[36m{}\x1b[0m {current}… \x1b[2m{secs}s\x1b[0m", SPINNER[(tick * 4 + frame) % SPINNER.len()]));
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    unreachable!()
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn debug_start(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    pod: String,
    target: Option<String>,
    image: String,
    cols: u16,
    rows: u16,
    on_event: Channel<ExecMsg>,
) -> Result<u64> {
    let image = image.trim();
    if image.is_empty() {
        return Err(Error::msg("choose an image for the debug container"));
    }
    let client = state.client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let name = container_name(&api.get(&pod).await?);

    note(&on_event, &format!("Adding debug container {name} ({image}) to the pod…"));
    let mut container = json!({
        "name": name,
        "image": image,
        "stdin": true,
        "tty": true,
        "terminationMessagePolicy": "File",
    });
    if let Some(t) = &target {
        // Shares the target container's process namespace: its processes and, through /proc/1/root, its files.
        container["targetContainerName"] = json!(t);
    }
    let patch = json!({ "spec": { "ephemeralContainers": [container] } });
    api.patch_ephemeral_containers(&pod, &PatchParams::default(), &Patch::Strategic(&patch)).await?;

    wait_running(&api, &Api::namespaced(client, &namespace), &pod, &name, true, &on_event).await?;
    let proc = api.attach(&pod, &AttachParams::interactive_tty().container(name.clone())).await?;
    let hint = if target.is_some() { "The target's processes are visible with ps, its files under /proc/1/root. " } else { "" };
    note(&on_event, &format!("Attached to {name}. {hint}If you don't see a prompt, press Enter."));
    run_session(&app, &state, proc, cols, rows, on_event, None)
}

/// Deletes the node-shell pod when dropped: when the session ends, fails to start, or is aborted.
struct DeletePod {
    api: Api<Pod>,
    name: String,
}

impl Drop for DeletePod {
    fn drop(&mut self) {
        let (api, name) = (self.api.clone(), std::mem::take(&mut self.name));
        tauri::async_runtime::spawn(async move {
            let _ = api.delete(&name, &DeleteParams { grace_period_seconds: Some(0), ..Default::default() }).await;
        });
    }
}

/// A privileged pod pinned to the node that enters the host's mount, UTS, IPC, network and PID namespaces.
fn node_shell_pod(node: &str, image: &str) -> Pod {
    // The host part of the node name (ip-10-0-1-23 of ip-10-0-1-23.eu-west-1.compute.internal), kept DNS-safe.
    let host = node.split('.').next().unwrap_or(node);
    let prefix: String = host.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect::<String>().to_lowercase();
    serde_json::from_value(json!({
        "metadata": {
            "generateName": format!("node-shell-{}-", prefix.trim_matches('-')),
            "labels": { "app.kubernetes.io/managed-by": "steerglass", "steerglass.com/node-shell": "true" },
        },
        "spec": {
            "nodeName": node,
            "hostPID": true,
            "hostNetwork": true,
            "hostIPC": true,
            "restartPolicy": "Never",
            "terminationGracePeriodSeconds": 0,
            // Run on any node, tainted ones (control plane, NoSchedule pools) included.
            "tolerations": [{ "operator": "Exists" }],
            "containers": [{
                "name": "shell",
                "image": image,
                "stdin": true,
                "tty": true,
                "securityContext": { "privileged": true },
                "command": [
                    "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--",
                    "/bin/sh", "-c",
                    "export TERM=xterm-256color; cd /root 2>/dev/null || cd /; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi",
                ],
            }],
        },
    }))
    .expect("valid pod")
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn node_shell_start(
    app: AppHandle,
    state: State<'_, AppState>,
    context: String,
    node: String,
    image: String,
    cols: u16,
    rows: u16,
    on_event: Channel<ExecMsg>,
) -> Result<u64> {
    let image = image.trim();
    if image.is_empty() {
        return Err(Error::msg("choose an image for the node shell"));
    }
    let client = state.client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client.clone(), NODE_SHELL_NAMESPACE);
    note(&on_event, &format!("Starting a privileged pod on {node} ({image}) in namespace {NODE_SHELL_NAMESPACE}…"));
    let created = api.create(&PostParams::default(), &node_shell_pod(&node, image)).await?;
    let name = created.metadata.name.unwrap_or_default();
    let guard = DeletePod { api: api.clone(), name: name.clone() };

    wait_running(&api, &Api::namespaced(client, NODE_SHELL_NAMESPACE), &name, "shell", false, &on_event).await?;
    let proc = api.attach(&name, &AttachParams::interactive_tty().container("shell")).await?;
    note(&on_event, &format!("Shell on node {node} (pod {name}, removed when this session closes). If you don't see a prompt, press Enter."));
    run_session(&app, &state, proc, cols, rows, on_event, Some(Box::new(guard)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pod(v: serde_json::Value) -> Pod {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn reads_the_container_state() {
        let p = |key: &str, state: serde_json::Value| {
            let mut status = serde_json::Map::new();
            status.insert(
                key.into(),
                json!([{ "name": "debugger-abcde", "image": "busybox", "imageID": "", "ready": false, "restartCount": 0, "state": state }]),
            );
            pod(json!({ "status": status }))
        };
        let e = "ephemeralContainerStatuses";
        assert_eq!(started(&pod(json!({})), "debugger-abcde", true), Ok(false));
        assert_eq!(started(&p(e, json!({"waiting": {"reason": "ContainerCreating"}})), "debugger-abcde", true), Ok(false));
        assert_eq!(started(&p(e, json!({"running": {}})), "debugger-abcde", true), Ok(true));
        assert!(started(&p(e, json!({"waiting": {"reason": "ErrImagePull", "message": "not found"}})), "debugger-abcde", true).is_err());
        assert!(started(&p(e, json!({"terminated": {"exitCode": 1, "reason": "Error"}})), "debugger-abcde", true).is_err());
        // Regular containers are read from containerStatuses.
        assert_eq!(started(&p("containerStatuses", json!({"running": {}})), "debugger-abcde", false), Ok(true));
        assert_eq!(started(&p("containerStatuses", json!({"running": {}})), "debugger-abcde", true), Ok(false));
        let unschedulable = pod(json!({"status": {"conditions": [
            {"type": "PodScheduled", "status": "False", "reason": "Unschedulable", "message": "node not found"}
        ]}}));
        assert!(started(&unschedulable, "shell", false).is_err());
    }

    #[test]
    fn picks_a_free_name() {
        let p = pod(json!({"spec": {"containers": [{"name": "app"}]}}));
        let n = container_name(&p);
        assert!(n.starts_with("debugger-") && n.len() == 14, "{n}");
    }

    #[test]
    fn node_shell_pod_is_pinned_and_privileged() {
        let p = node_shell_pod("ip-10-0-1-23.eu-west-1.compute.internal", "busybox:1.37");
        assert_eq!(p.metadata.generate_name.as_deref(), Some("node-shell-ip-10-0-1-23-"));
        let spec = p.spec.unwrap();
        assert_eq!(spec.node_name.as_deref(), Some("ip-10-0-1-23.eu-west-1.compute.internal"));
        assert_eq!(spec.host_pid, Some(true));
        assert_eq!(spec.containers[0].security_context.as_ref().unwrap().privileged, Some(true));
    }
}
