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
    /// Kubeconfig files the user switched off (e.g. old files found in ~/.kube).
    pub excluded_kubeconfigs: Vec<PathBuf>,
    /// Contexts the user hid from the sidebar and the overview.
    pub hidden_contexts: Vec<String>,
    /// macOS security-scoped bookmarks (path -> base64 data) for files and folders the user granted.
    pub bookmarks: std::collections::BTreeMap<String, String>,
    /// Optional AI help (off by default); the API key is kept in the system keychain.
    pub ai: crate::ai::AiSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            extra_kubeconfigs: vec![],
            scan_kube_dir: true,
            excluded_kubeconfigs: vec![],
            hidden_contexts: vec![],
            bookmarks: Default::default(),
            ai: Default::default(),
        }
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
    /// Files found but switched off by the user.
    pub excluded: Vec<String>,
    /// Contexts hidden by the user (not in `contexts`).
    pub hidden: Vec<String>,
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

/// Files in the order kubectl would consider them, followed by extras (switched-off files included).
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

/// What the kubeconfig files looked like when read: each candidate file's modification time and
/// size. Tools like minikube and kind rewrite the file (new port, new certificates) when a cluster
/// is recreated; a different stamp means the loaded copy is stale.
pub type Stamp = Vec<(PathBuf, Option<(std::time::SystemTime, u64)>)>;

pub fn stamp(settings: &Settings) -> Stamp {
    candidate_files(settings)
        .into_iter()
        .map(|p| {
            let meta = std::fs::metadata(&p).ok().and_then(|m| Some((m.modified().ok()?, m.len())));
            (p, meta)
        })
        .collect()
}

pub fn load(settings: &Settings) -> Loaded {
    let mut merged: Option<Kubeconfig> = None;
    let mut contexts = Vec::new();
    let mut files = Vec::new();
    let mut errors = Vec::new();

    let mut excluded = Vec::new();
    for path in candidate_files(settings) {
        if settings.excluded_kubeconfigs.contains(&path) {
            excluded.push(path.display().to_string());
            continue;
        }
        match Kubeconfig::read_from(&path) {
            Ok(mut kc) => {
                let source = path.display().to_string();
                if let Some(m) = &merged {
                    disambiguate(&mut kc, m, &file_label(&path));
                }
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
    let (hidden, contexts): (Vec<_>, Vec<_>) =
        contexts.into_iter().partition(|(name, _)| settings.hidden_contexts.contains(name));
    let hidden = hidden.into_iter().map(|(name, _)| name).collect();
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

    Loaded { config, report: LoadReport { contexts: infos, files, excluded, hidden, errors } }
}

/// How a file is named in renamed contexts: `k3s-lab` for `~/.kube/k3s-lab.yaml`, `lab/config` for a
/// file called just `config`.
fn file_label(path: &Path) -> String {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("kubeconfig");
    match path.parent().and_then(|p| p.file_name()).and_then(|p| p.to_str()) {
        Some(dir) if stem == "config" => format!("{dir}/{stem}"),
        _ => stem.to_string(),
    }
}

/// Renames what `next` defines under a name `merged` already uses for something else, so the merge
/// keeps it instead of silently dropping it: several k3s files all call their context, cluster and user
/// `default`, and kubectl's rules would keep only the first. A context becomes `default (k3s-lab)`, after
/// its file; its cluster and user are renamed the same way. Identical entries (a copy of the same
/// kubeconfig) are left alone and merge into one, like kubectl. Only the merged copy in memory changes,
/// never the files.
fn disambiguate(next: &mut Kubeconfig, merged: &Kubeconfig, label: &str) {
    use std::collections::{HashMap, HashSet};
    let unique = |name: &str, taken: &HashSet<String>| {
        let base = format!("{name} ({label})");
        let mut candidate = base.clone();
        let mut n = 2;
        while taken.contains(&candidate) {
            candidate = format!("{base} {n}");
            n += 1;
        }
        candidate
    };

    let mut taken: HashSet<String> = merged.clusters.iter().map(|c| c.name.clone()).collect();
    taken.extend(next.clusters.iter().map(|c| c.name.clone()));
    let mut clusters = HashMap::new();
    for c in &mut next.clusters {
        if let Some(old) = merged.clusters.iter().find(|m| m.name == c.name)
            && !same(&old.cluster, &c.cluster)
        {
            let new = unique(&c.name, &taken);
            taken.insert(new.clone());
            clusters.insert(std::mem::replace(&mut c.name, new.clone()), new);
        }
    }

    let mut taken: HashSet<String> = merged.auth_infos.iter().map(|u| u.name.clone()).collect();
    taken.extend(next.auth_infos.iter().map(|u| u.name.clone()));
    let mut users = HashMap::new();
    for u in &mut next.auth_infos {
        if let Some(old) = merged.auth_infos.iter().find(|m| m.name == u.name)
            && !same(&old.auth_info, &u.auth_info)
        {
            let new = unique(&u.name, &taken);
            taken.insert(new.clone());
            users.insert(std::mem::replace(&mut u.name, new.clone()), new);
        }
    }

    let mut taken: HashSet<String> = merged.contexts.iter().map(|c| c.name.clone()).collect();
    taken.extend(next.contexts.iter().map(|c| c.name.clone()));
    for c in &mut next.contexts {
        if let Some(ctx) = c.context.as_mut() {
            if let Some(new) = clusters.get(&ctx.cluster) {
                ctx.cluster = new.clone();
            }
            if let Some(new) = ctx.user.as_ref().and_then(|u| users.get(u)) {
                ctx.user = Some(new.clone());
            }
        }
        if let Some(old) = merged.contexts.iter().find(|m| m.name == c.name)
            && !same(&old.context, &c.context)
        {
            let new = unique(&c.name, &taken);
            taken.insert(new.clone());
            if next.current_context.as_deref() == Some(c.name.as_str()) {
                next.current_context = Some(new.clone());
            }
            c.name = new;
        }
    }
}

/// Kubeconfig entries compared by their serialized form (kube-rs types don't implement `PartialEq`).
fn same<T: Serialize>(a: &T, b: &T) -> bool {
    serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn kc(yaml: &str) -> Kubeconfig {
        Kubeconfig::from_yaml(yaml).unwrap()
    }

    /// The kubeconfig k3s writes: everything is called `default`.
    fn k3s(server: &str, token: &str) -> String {
        format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: default\n  cluster: {{server: '{server}'}}\nusers:\n- name: default\n  user: {{token: {token}}}\ncontexts:\n- name: default\n  context: {{cluster: default, user: default}}\ncurrent-context: default\n"
        )
    }

    fn merge(first: &str, next: &str, label: &str) -> Kubeconfig {
        let merged = kc(first);
        let mut next = kc(next);
        disambiguate(&mut next, &merged, label);
        merged.merge(next).unwrap()
    }

    fn server_of(config: &Kubeconfig, context: &str) -> String {
        let ctx = config.contexts.iter().find(|c| c.name == context).unwrap().context.as_ref().unwrap();
        let cluster = config.clusters.iter().find(|c| c.name == ctx.cluster).unwrap();
        cluster.cluster.as_ref().unwrap().server.clone().unwrap()
    }

    #[test]
    fn same_names_from_different_files_are_kept_apart() {
        let m = merge(&k3s("https://a:6443", "ta"), &k3s("https://b:6443", "tb"), "k3s-b");
        let names: Vec<_> = m.contexts.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["default", "default (k3s-b)"]);
        assert_eq!(server_of(&m, "default"), "https://a:6443");
        assert_eq!(server_of(&m, "default (k3s-b)"), "https://b:6443");
        let ctx = m.contexts[1].context.as_ref().unwrap();
        assert_eq!(ctx.user.as_deref(), Some("default (k3s-b)"));
        assert_eq!(m.current_context.as_deref(), Some("default"));
    }

    #[test]
    fn a_copy_of_the_same_kubeconfig_merges_into_one() {
        let m = merge(&k3s("https://a:6443", "ta"), &k3s("https://a:6443", "ta"), "config.bak");
        assert_eq!(m.contexts.len(), 1);
        assert_eq!(m.clusters.len(), 1);
    }

    #[test]
    fn a_shared_cluster_name_with_different_servers_is_renamed() {
        // Context names differ, but both clusters are called `default`: without the rename the second
        // context would talk to the first server.
        let a = k3s("https://a:6443", "ta").replace("- name: default\n  context", "- name: lab-a\n  context");
        let b = k3s("https://b:6443", "tb").replace("- name: default\n  context", "- name: lab-b\n  context");
        let m = merge(&a, &b, "lab-b");
        assert_eq!(server_of(&m, "lab-a"), "https://a:6443");
        assert_eq!(server_of(&m, "lab-b"), "https://b:6443");
    }

    #[test]
    fn renamed_names_stay_unique() {
        let first = merge(&k3s("https://a:6443", "ta"), &k3s("https://b:6443", "tb"), "lab");
        let mut third = kc(&k3s("https://c:6443", "tc"));
        disambiguate(&mut third, &first, "lab");
        let m = first.merge(third).unwrap();
        let names: Vec<_> = m.contexts.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["default", "default (lab)", "default (lab) 2"]);
        assert_eq!(server_of(&m, "default (lab) 2"), "https://c:6443");
    }

    #[test]
    fn file_labels() {
        assert_eq!(file_label(Path::new("/home/me/.kube/k3s-lab.yaml")), "k3s-lab");
        assert_eq!(file_label(Path::new("/srv/lab/config")), "lab/config");
    }
}
