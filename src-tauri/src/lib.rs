mod commands;
mod console;
mod debug;
mod error;
mod kubeconfig;
mod metrics;
mod refs;
mod rows;
mod sandbox;
mod state;
mod streams;
mod table;

use tauri::Manager;

static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// With `STEERGLASS_TIMING=1`, prints how long after launch `event` first happened (to measure
/// startup on release builds). Each event is printed once.
pub(crate) fn timing(event: &str) {
    static SEEN: parking_lot::Mutex<Vec<String>> = parking_lot::Mutex::new(Vec::new());
    if std::env::var_os("STEERGLASS_TIMING").is_none() {
        return;
    }
    let mut seen = SEEN.lock();
    if seen.iter().any(|e| e == event) {
        return;
    }
    seen.push(event.to_string());
    if let Some(t) = STARTED.get() {
        eprintln!("[timing] {event}: {} ms after launch", t.elapsed().as_millis());
    }
}

/// macOS app menu: the standard items plus our own About and Settings, which open in-app dialogs
/// (the system About panel can't show the app's look). The UI listens for the "menu" event.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::Emitter;
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as P, Submenu};
    let about = MenuItem::with_id(app, "about", "About Steerglass", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let steerglass = Submenu::with_items(
        app,
        "Steerglass",
        true,
        &[
            &about,
            &P::separator(app)?,
            &settings,
            &P::separator(app)?,
            &P::services(app, None)?,
            &P::separator(app)?,
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &P::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[&P::undo(app, None)?, &P::redo(app, None)?, &P::separator(app)?, &P::cut(app, None)?, &P::copy(app, None)?, &P::paste(app, None)?, &P::select_all(app, None)?],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&P::fullscreen(app, None)?])?;
    let window = Submenu::with_items(app, "Window", true, &[&P::minimize(app, None)?, &P::maximize(app, None)?, &P::separator(app)?, &P::close_window(app, None)?])?;
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, "help", "Steerglass Help", true, None::<&str>)?,
            &P::separator(app)?,
            &MenuItem::with_id(app, "feedback", "Send Feedback…", true, None::<&str>)?,
            &MenuItem::with_id(app, "bug", "Report a Bug…", true, None::<&str>)?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&steerglass, &edit, &view, &window, &help])?)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if ["about", "settings", "help", "feedback", "bug"].contains(&id) {
            let _ = app.emit("menu", id);
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    STARTED.get_or_init(std::time::Instant::now);
    kubeconfig::fix_path_env();
    kubeconfig::hide_plugin_consoles();
    let _ = rustls::crypto::ring::default_provider().install_default();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    // App Store builds are updated by the store; direct downloads update themselves from steerglass.com.
    #[cfg(all(desktop, not(feature = "appstore")))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(state::AppState::new(dir.join("settings.json")));
            #[cfg(target_os = "macos")]
            app_menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_contexts,
            commands::app_store_build,
            commands::reload_contexts,
            commands::get_settings,
            commands::update_settings,
            commands::grant_access,
            commands::environment,
            commands::cluster_summary,
            commands::cluster_issues,
            metrics::pod_usage,
            metrics::pod_history,
            metrics::node_usage,
            commands::list_namespaces,
            commands::discover,
            commands::get_object,
            refs::config_usage,
            commands::get_yaml,
            commands::replace_yaml,
            commands::apply_manifest,
            commands::delete_object,
            commands::scale,
            commands::rollout_restart,
            commands::set_cordon,
            commands::suspend_cronjob,
            streams::stream_stop,
            streams::watch_start,
            streams::logs_start,
            streams::exec_start,
            debug::debug_start,
            debug::node_shell_start,
            streams::exec_input,
            streams::exec_resize,
            streams::portforward_start,
            streams::portforward_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Read-only checks against a real cluster: `KC_TEST_CONTEXT=<ctx> cargo test --lib live -- --ignored --nocapture`
#[cfg(test)]
mod live_tests {
    use futures::StreamExt;
    use kube::runtime::{WatchStreamExt, watcher};

    #[tokio::test]
    #[ignore]
    async fn live_read_only() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        crate::kubeconfig::fix_path_env();
        let Ok(ctx) = std::env::var("KC_TEST_CONTEXT") else { return };
        let dir = std::env::temp_dir().join("steerglass-test");
        let state = crate::state::AppState::new(dir.join("settings.json"));
        let report = state.report.read().clone();
        println!("files: {:?}\ncontexts: {}\nerrors: {:?}", report.files, report.contexts.len(), report.errors);

        let client = state.client(&ctx).await.expect("client");
        let t = std::time::Instant::now();
        let v = client.apiserver_version().await.expect("version");
        println!("version {} in {:?}", v.git_version, t.elapsed());

        let t = std::time::Instant::now();
        let kinds = crate::commands::kinds_for(&state, &ctx, false).await.expect("discovery");
        println!("discovered {} kinds in {:?}", kinds.len(), t.elapsed());

        let pods = kinds.iter().find(|k| k.group.is_empty() && k.kind == "Pod").expect("pods");
        let api = crate::commands::dyn_api(client, pods, None);
        let t = std::time::Instant::now();
        let mut stream = watcher(api, watcher::Config::default().page_size(500)).default_backoff().boxed();
        let mut n = 0;
        let mut sample = None;
        while let Some(ev) = stream.next().await {
            match ev.expect("watch") {
                watcher::Event::InitApply(o) => {
                    n += 1;
                    let row = crate::rows::to_row("", "Pod", &serde_json::to_value(&o).unwrap());
                    sample.get_or_insert(row);
                }
                watcher::Event::InitDone => break,
                _ => {}
            }
        }
        println!("listed {n} pods in {:?}; sample: {:?}", t.elapsed(), sample);

        // Logs: tail a few lines of the first running pod.
        let sample = sample.expect("at least one pod");
        let client = state.client(&ctx).await.unwrap();
        let pods: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(client, sample.namespace.as_deref().unwrap());
        let lp = kube::api::LogParams { tail_lines: Some(3), ..Default::default() };
        let logs = pods.logs(&sample.name, &lp).await.expect("logs");
        println!("last log lines of {}: {} lines", sample.name, logs.lines().count());
    }
}

#[cfg(test)]
mod live_error_tests {
    /// `KC_TEST_FAILING=ctx1,ctx2 cargo test --lib live_errors -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_errors_are_readable() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        crate::kubeconfig::fix_path_env();
        let Ok(list) = std::env::var("KC_TEST_FAILING") else { return };
        let state = crate::state::AppState::new(std::env::temp_dir().join("steerglass-test/settings.json"));
        for ctx in list.split(',') {
            let res = async { Ok::<_, crate::error::Error>(state.client(ctx).await?.apiserver_version().await?) }.await;
            println!("{ctx}: {}", res.err().map(|e| e.to_string()).unwrap_or_else(|| "OK".into()));
        }
    }
}
