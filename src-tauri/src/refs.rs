//! "Used by" for ConfigMaps and Secrets: the workloads in the namespace whose pod template mounts
//! the object or reads it into the environment.
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Container, Pod, PodSpec};
use kube::api::{Api, ListParams};
use kube::Client;
use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Source {
    ConfigMap,
    Secret,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub kind: String,
    pub name: String,
    /// How the object is referenced, e.g. "volume config", "envFrom in app", "key LOG_LEVEL in app".
    pub via: Vec<String>,
}

fn container_refs(c: &Container, src: Source, name: &str, via: &mut Vec<String>) {
    for e in c.env_from.iter().flatten() {
        let hit = match src {
            Source::ConfigMap => e.config_map_ref.as_ref().is_some_and(|r| r.name == name),
            Source::Secret => e.secret_ref.as_ref().is_some_and(|r| r.name == name),
        };
        if hit {
            via.push(format!("envFrom in {}", c.name));
        }
    }
    for e in c.env.iter().flatten() {
        let Some(from) = &e.value_from else { continue };
        let key = match src {
            Source::ConfigMap => from.config_map_key_ref.as_ref().filter(|r| r.name == name).map(|r| &r.key),
            Source::Secret => from.secret_key_ref.as_ref().filter(|r| r.name == name).map(|r| &r.key),
        };
        if let Some(key) = key {
            via.push(format!("key {key} in {}", c.name));
        }
    }
}

fn spec_refs(spec: &PodSpec, src: Source, name: &str) -> Vec<String> {
    let mut via = Vec::new();
    for v in spec.volumes.iter().flatten() {
        let direct = match src {
            Source::ConfigMap => v.config_map.as_ref().is_some_and(|c| c.name == name),
            Source::Secret => v.secret.as_ref().is_some_and(|s| s.secret_name.as_deref() == Some(name)),
        };
        let projected = v.projected.as_ref().and_then(|p| p.sources.as_ref()).is_some_and(|sources| {
            sources.iter().any(|s| match src {
                Source::ConfigMap => s.config_map.as_ref().is_some_and(|c| c.name == name),
                Source::Secret => s.secret.as_ref().is_some_and(|c| c.name == name),
            })
        });
        if direct || projected {
            via.push(format!("volume {}", v.name));
        }
    }
    for c in spec.init_containers.iter().flatten().chain(&spec.containers) {
        container_refs(c, src, name, &mut via);
    }
    if src == Source::Secret && spec.image_pull_secrets.iter().flatten().any(|s| s.name == name) {
        via.push("imagePullSecrets".into());
    }
    via
}

async fn scan<K, F>(client: &Client, ns: &str, kind: &str, src: Source, name: &str, spec: F) -> std::result::Result<Vec<Usage>, String>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope> + Clone + serde::de::DeserializeOwned + std::fmt::Debug,
    K::DynamicType: Default,
    F: Fn(&K) -> Option<&PodSpec>,
{
    let list = Api::<K>::namespaced(client.clone(), ns)
        .list(&ListParams::default())
        .await
        .map_err(|e| e.to_string())?;
    Ok(list
        .items
        .iter()
        // Pods and Jobs created by a controller are covered by that controller.
        .filter(|o| o.meta().owner_references.as_ref().is_none_or(|r| r.is_empty()))
        .filter_map(|o| {
            let via = spec(o).map(|s| spec_refs(s, src, name)).unwrap_or_default();
            (!via.is_empty()).then(|| Usage {
                kind: kind.into(),
                name: o.meta().name.clone().unwrap_or_default(),
                via,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn config_usage(
    state: State<'_, AppState>,
    context: String,
    kind: String,
    namespace: String,
    name: String,
) -> Result<Vec<Usage>> {
    usage(&state.client(&context).await?, &kind, &namespace, &name).await
}

async fn usage(client: &Client, kind: &str, namespace: &str, name: &str) -> Result<Vec<Usage>> {
    let src = match kind {
        "ConfigMap" => Source::ConfigMap,
        "Secret" => Source::Secret,
        _ => return Err(Error::msg(format!("unsupported kind {kind}"))),
    };
    let (c, ns, n) = (client, namespace, name);
    let results = tokio::join!(
        scan::<Deployment, _>(c, ns, "Deployment", src, n, |o| o
            .spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())),
        scan::<StatefulSet, _>(c, ns, "StatefulSet", src, n, |o| o
            .spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())),
        scan::<DaemonSet, _>(c, ns, "DaemonSet", src, n, |o| o
            .spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())),
        scan::<CronJob, _>(c, ns, "CronJob", src, n, |o| {
            o.spec.job_template.spec.as_ref().and_then(|j| j.template.spec.as_ref())
        }),
        scan::<Job, _>(c, ns, "Job", src, n, |o| o.spec.as_ref().and_then(|s| s.template.spec.as_ref())),
        scan::<Pod, _>(c, ns, "Pod", src, n, |o| o.spec.as_ref()),
    );
    let all = [results.0, results.1, results.2, results.3, results.4, results.5];
    // Kinds we may not list (RBAC) are skipped; fail only when nothing could be listed.
    if all.iter().all(|r| r.is_err()) {
        return Err(Error::msg(all.into_iter().find_map(|r| r.err()).unwrap_or_default()));
    }
    Ok(all.into_iter().flat_map(|r| r.unwrap_or_default()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(v: serde_json::Value) -> PodSpec {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn finds_volumes_env_and_pull_secrets() {
        let s = spec(json!({
            "volumes": [
                {"name": "config", "configMap": {"name": "app"}},
                {"name": "bundle", "projected": {"sources": [{"configMap": {"name": "app"}}, {"secret": {"name": "tls"}}]}},
                {"name": "other", "configMap": {"name": "other"}},
                {"name": "certs", "secret": {"secretName": "tls"}}
            ],
            "initContainers": [{"name": "init", "envFrom": [{"configMapRef": {"name": "app"}}]}],
            "containers": [{
                "name": "web",
                "env": [
                    {"name": "LEVEL", "valueFrom": {"configMapKeyRef": {"name": "app", "key": "LOG_LEVEL"}}},
                    {"name": "PASS", "valueFrom": {"secretKeyRef": {"name": "tls", "key": "password"}}},
                    {"name": "PLAIN", "value": "x"}
                ]
            }],
            "imagePullSecrets": [{"name": "tls"}]
        }));
        assert_eq!(
            spec_refs(&s, Source::ConfigMap, "app"),
            ["volume config", "volume bundle", "envFrom in init", "key LOG_LEVEL in web"]
        );
        assert_eq!(
            spec_refs(&s, Source::Secret, "tls"),
            ["volume bundle", "volume certs", "key password in web", "imagePullSecrets"]
        );
        assert!(spec_refs(&s, Source::ConfigMap, "missing").is_empty());
        // A Secret and a ConfigMap with the same name are different objects.
        assert_eq!(spec_refs(&s, Source::Secret, "app"), Vec::<String>::new());
    }

    /// `KC_TEST_CONTEXT=<ctx> KC_TEST_CONFIGMAP=<namespace>/<name> cargo test --lib refs::tests::live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_usage() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (Ok(ctx), Ok(target)) = (std::env::var("KC_TEST_CONTEXT"), std::env::var("KC_TEST_CONFIGMAP")) else { return };
        let (ns, name) = target.split_once('/').expect("namespace/name");
        let state = crate::state::AppState::new(std::env::temp_dir().join("steerglass-test").join("settings.json"));
        let client = state.client(&ctx).await.expect("client");
        println!("{:#?}", usage(&client, "ConfigMap", ns, name).await.expect("usage"));
    }
}
