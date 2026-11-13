use std::path::{Path, PathBuf};

use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};

/// User settings that affect where kubeconfig files are read from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Extra kubeconfig files added by the user.
    pub extra_kubeconfigs: Vec<PathBuf>,
    /// Also read every kubeconfig-looking file inside ~/.kube.
    pub scan_kube_dir: bool,
    /// macOS security-scoped bookmarks (path -> base64 data) for files and folders the user granted.
    pub bookmarks: std::collections::BTreeMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { extra_kubeconfigs: vec![], scan_kube_dir: true, bookmarks: Default::default() }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, serde_json::to_vec_pretty(self)?)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub name: String,
    pub cluster: String,
    pub user: Option<String>,
    pub namespace: Option<String>,
    pub server: Option<String>,
    pub source: String,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadReport {
    pub contexts: Vec<ContextInfo>,
    pub files: Vec<String>,
    pub errors: Vec<String>,
}

/// The merged kubeconfig plus the file each context came from.
pub struct Loaded {
    pub config: Kubeconfig,
    pub report: LoadReport,
}

/// ~/.kube, or `STEERGLASS_KUBE_DIR` when set (demos and tests: only the kubeconfigs in that folder).
pub fn kube_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("STEERGLASS_KUBE_DIR") {
        return Some(PathBuf::from(dir));
    }
    crate::sandbox::real_home().map(|h| h.join(".kube"))
}

/// Re-activates access to everything the user granted in previous sessions (sandbox only matters).
pub fn activate_bookmarks(settings: &Settings) {
    use base64::Engine;
    for data in settings.bookmarks.values() {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
            crate::sandbox::activate(&bytes);
        }
    }
}

/// Files in the order kubectl would consider them, followed by extras.
pub fn candidate_files(settings: &Settings) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    let sep = if cfg!(windows) { ';' } else { ':' };
    if let Ok(env) = std::env::var("KUBECONFIG") {
        files.extend(env.split(sep).filter(|s| !s.is_empty()).map(PathBuf::from));
    }
    if let Some(dir) = kube_dir() {
        files.push(dir.join("config"));
        if settings.scan_kube_dir
            && let Ok(entries) = std::fs::read_dir(&dir)
        {
            let mut found: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_file() && looks_like_kubeconfig(p))
                .collect();
            found.sort();
            files.extend(found);
        }
    }
    files.extend(settings.extra_kubeconfigs.iter().cloned());

    let mut seen = std::collections::HashSet::new();
    files.retain(|p| {
        let key = std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
        p.exists() && seen.insert(key)
    });
    files
}

fn looks_like_kubeconfig(p: &Path) -> bool {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.starts_with('.') || name.ends_with(".lock") {
        return false;
    }
    let Ok(meta) = std::fs::metadata(p) else { return false };
    if meta.len() > 4 * 1024 * 1024 {
        return false;
    }
    std::fs::read_to_string(p)
        .map(|s| s.contains("clusters:") && s.contains("contexts:"))
        .unwrap_or(false)
}

pub fn load(settings: &Settings) -> Loaded {
    let mut merged: Option<Kubeconfig> = None;
    let mut contexts = Vec::new();
    let mut files = Vec::new();
    let mut errors = Vec::new();

    for path in candidate_files(settings) {
        match Kubeconfig::read_from(&path) {
            Ok(kc) => {
                let source = path.display().to_string();
                for ctx in &kc.contexts {
                    if contexts.iter().any(|c: &(String, String)| c.0 == ctx.name) {
                        continue;
                    }
                    contexts.push((ctx.name.clone(), source.clone()));
                }
                files.push(source);
                merged = Some(match merged.take() {
                    None => kc,
                    Some(m) => match m.clone().merge(kc) {
                        Ok(m2) => m2,
                        Err(e) => {
                            errors.push(format!("{}: {e}", path.display()));
                            m
                        }
                    },
                });
            }
            Err(e) => errors.push(format!("{}: {e}", path.display())),
        }
    }

    let config = merged.unwrap_or_default();
    let current = config.current_context.clone();
    let infos = contexts
        .into_iter()
        .filter_map(|(name, source)| {
            let named = config.contexts.iter().find(|c| c.name == name)?;
            let ctx = named.context.as_ref()?;
            let server = config
                .clusters
                .iter()
                .find(|c| c.name == ctx.cluster)
                .and_then(|c| c.cluster.as_ref())
                .and_then(|c| c.server.clone());
            Some(ContextInfo {
                is_current: current.as_deref() == Some(name.as_str()),
                name,
                cluster: ctx.cluster.clone(),
                user: ctx.user.clone(),
                namespace: ctx.namespace.clone(),
                server,
                source,
            })
        })
        .collect();

    Loaded { config, report: LoadReport { contexts: infos, files, errors } }
}

/// Windows: keeps credential plugins (`kubelogin`, `aws`, `gke-gcloud-auth-plugin`…) and the programs
/// they start (`gcloud.cmd`, `az.cmd`) from opening console windows — a burst of them when many
/// clusters connect at once. They share a hidden console of the app (see [`crate::console`]); where
/// that fails, kube-rs at least starts the plugins themselves without a window.
pub fn hide_plugin_consoles() {
    if cfg!(windows) && !crate::console::attach_hidden() {
        // SAFETY: called once at startup before any other thread reads the environment.
        unsafe { std::env::set_var("KUBE_RS_UNSTABLE_CREATE_NO_WINDOW", "1") };
    }
}

/// GUI apps started from the Finder/launcher get a minimal PATH, which breaks exec
/// credential plugins such as `gke-gcloud-auth-plugin`, `aws` or `kubelogin`.
/// Recover the user's login-shell PATH and add the usual install locations.
pub fn fix_path_env() {
    if cfg!(windows) {
        return;
    }
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(String::from)
        .collect();

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let shell_path = if crate::sandbox::is_sandboxed() { None } else { login_shell_path(&shell) };
    if let Some(shell_path) = shell_path {
        for p in shell_path.split(':').rev() {
            parts.insert(0, p.to_string());
        }
    }
    let home = crate::sandbox::real_home().map(|h| h.display().to_string()).unwrap_or_default();
    for extra in [
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/google-cloud-sdk/bin"),
        format!("{home}/.local/bin"),
        format!("{home}/.krew/bin"),
        "/snap/bin".to_string(),
    ] {
        parts.push(extra);
    }
    let mut seen = std::collections::HashSet::new();
    parts.retain(|p| !p.is_empty() && seen.insert(p.clone()));
    // SAFETY: called once at startup before any other thread reads the environment.
    unsafe { std::env::set_var("PATH", parts.join(":")) };
}

fn login_shell_path(shell: &str) -> Option<String> {
    use std::process::{Command, Stdio};
    let mut child = Command::new(shell)
        .args(["-ilc", "printf '__KC_PATH__%s__KC_PATH__' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let start = s.find("__KC_PATH__")? + "__KC_PATH__".len();
    let end = s[start..].find("__KC_PATH__")? + start;
    Some(s[start..end].to_string())
}
