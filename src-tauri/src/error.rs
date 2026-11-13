use serde::{Serialize, Serializer};

/// Error returned by every Tauri command. It serializes to a plain string so the
/// frontend can show it directly.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{}", kube_message(.0))]
    Kube(#[from] kube::Error),
    #[error(transparent)]
    Kubeconfig(#[from] kube::config::KubeconfigError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("invalid YAML: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Msg(String),
}

fn kube_message(e: &kube::Error) -> String {
    if let kube::Error::Api(s) = e {
        return format!("{} ({})", s.message, s.reason);
    }
    friendly(e).unwrap_or_else(|| e.to_string())
}

/// Turns common low-level failures (credential plugins, unreachable servers) into short,
/// actionable messages instead of multi-line debug dumps.
fn friendly(e: &(dyn std::error::Error + 'static)) -> Option<String> {
    use kube::client::AuthError;
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    let mut deepest = e.to_string();
    let mut connect = false;
    while let Some(err) = cur {
        if let Some(auth) = err.downcast_ref::<AuthError>() {
            return Some(match auth {
                AuthError::AuthExecRun { cmd, out, status } => {
                    let text = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr }).into_owned();
                    let detail = text
                        .lines()
                        .map(str::trim)
                        .rfind(|l| !l.is_empty())
                        .map(String::from)
                        .unwrap_or_else(|| format!("exited with {status}"));
                    let program = cmd.split_whitespace().find(|w| !w.contains('=')).unwrap_or(cmd).trim_matches('"');
                    format!("Credential plugin `{program}` failed: {detail}. Try running it in a terminal or re-login to your cloud CLI.")
                }
                AuthError::AuthExecStart(io) => {
                    format!("Credential plugin could not be started ({io}). Is it installed and on your PATH?")
                }
                other => format!("Authentication failed: {other}"),
            });
        }
        let msg = err.to_string();
        if msg.contains("(Connect)") || msg.contains("tcp connect error") {
            connect = true;
        }
        deepest = msg;
        cur = err.source();
    }
    connect.then(|| format!("Cannot reach the API server: {deepest}"))
}

impl Error {
    pub fn msg(s: impl Into<String>) -> Self {
        Error::Msg(s.into())
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
