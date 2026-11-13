use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;
use tokio::sync::mpsc::UnboundedSender;

use crate::error::{Error, Result};
use crate::kubeconfig::{self, LoadReport, Settings};

/// A resource type served by a cluster, as returned by discovery.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindRef {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
    #[serde(default)]
    pub verbs: Vec<String>,
}

impl KindRef {
    pub fn api_resource(&self) -> kube::discovery::ApiResource {
        let gvk = kube::api::GroupVersionKind::gvk(&self.group, &self.version, &self.kind);
        kube::discovery::ApiResource::from_gvk_with_plural(&gvk, &self.plural)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: u64,
    pub context: String,
    pub namespace: String,
    pub target: String,
    pub remote_port: u16,
    pub local_port: u16,
}

/// A running background task (watch, log stream, exec session, port-forward).
pub struct StreamHandle {
    pub abort: tokio::task::AbortHandle,
    pub stdin: Option<UnboundedSender<Vec<u8>>>,
    pub resize: Option<UnboundedSender<(u16, u16)>>,
    pub forward: Option<ForwardInfo>,
}

pub struct AppState {
    pub settings_path: PathBuf,
    pub settings: RwLock<Settings>,
    pub(crate) kubeconfig: RwLock<Kubeconfig>,
    pub report: RwLock<LoadReport>,
    /// One client per context. The cell makes concurrent first uses (overview probe, namespaces,
    /// discovery, watches) share a single client, so exec auth plugins run once instead of N times.
    clients: Mutex<HashMap<String, Arc<OnceCell<Client>>>>,
    pub discovery: Mutex<HashMap<String, Arc<Vec<KindRef>>>>,
    pub streams: Mutex<HashMap<u64, StreamHandle>>,
    pub metrics: crate::metrics::Metrics,
    next_id: AtomicU64,
}

impl AppState {
    pub fn new(settings_path: PathBuf) -> Self {
        let settings = Settings::load(&settings_path);
        kubeconfig::activate_bookmarks(&settings);
        let loaded = kubeconfig::load(&settings);
        Self {
            settings_path,
            settings: RwLock::new(settings),
            kubeconfig: RwLock::new(loaded.config),
            report: RwLock::new(loaded.report),
            clients: Mutex::new(HashMap::new()),
            discovery: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            metrics: Default::default(),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn reload(&self) -> LoadReport {
        let loaded = kubeconfig::load(&self.settings.read());
        *self.kubeconfig.write() = loaded.config;
        *self.report.write() = loaded.report.clone();
        self.clients.lock().clear();
        self.discovery.lock().clear();
        loaded.report
    }

    pub fn save_settings(&self) -> Result<()> {
        self.settings.read().save(&self.settings_path)?;
        Ok(())
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn default_namespace(&self, context: &str) -> Option<String> {
        self.report
            .read()
            .contexts
            .iter()
            .find(|c| c.name == context)
            .and_then(|c| c.namespace.clone())
    }

    /// Returns a cached client for the context, creating it on first use.
    pub async fn client(&self, context: &str) -> Result<Client> {
        let cell = self.clients.lock().entry(context.to_string()).or_default().clone();
        let client = cell
            .get_or_try_init(|| async {
                let kc = self.kubeconfig.read().clone();
                let opts = KubeConfigOptions { context: Some(context.to_string()), ..Default::default() };
                let mut cfg = Config::from_custom_kubeconfig(kc, &opts).await?;
                cfg.connect_timeout = Some(Duration::from_secs(10));
                Ok::<_, Error>(Client::try_from(cfg)?)
            })
            .await?;
        Ok(client.clone())
    }

    pub fn forget_client(&self, context: &str) {
        self.clients.lock().remove(context);
        self.discovery.lock().remove(context);
    }

    pub fn stop_stream(&self, id: u64) {
        if let Some(h) = self.streams.lock().remove(&id) {
            h.abort.abort();
        }
    }

    pub fn stream_input(&self, id: u64) -> Result<UnboundedSender<Vec<u8>>> {
        self.streams
            .lock()
            .get(&id)
            .and_then(|h| h.stdin.clone())
            .ok_or_else(|| Error::msg("session closed"))
    }
}
