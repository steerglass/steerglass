import { useEffect, useState } from "react";
import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Download, X } from "lucide-react";
import { errText } from "../api";
import { useStore } from "../store";
import { SettingRow } from "./SettingRow";

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

type Phase = { state: "idle" } | { state: "available" } | { state: "downloading"; done: number; total?: number } | { state: "error"; message: string };

interface UpdateState {
  update: Update | null;
  phase: Phase;
  dismissed: string | null;
  checkedAt: number | null;
}

const useUpdates = create<UpdateState>(() => ({ update: null, phase: { state: "idle" }, dismissed: null, checkedAt: null }));

/** App Store builds are updated by the store; dev builds have nothing to update to. */
const enabled = () => !import.meta.env.DEV && !useStore.getState().appStore;

async function checkNow(): Promise<Update | null> {
  const update = await check();
  useUpdates.setState({ update, checkedAt: Date.now(), ...(update ? { phase: { state: "available" } } : {}) });
  return update;
}

async function install() {
  const update = useUpdates.getState().update;
  if (!update) return;
  let done = 0;
  try {
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") useUpdates.setState({ phase: { state: "downloading", done: 0, total: e.data.contentLength } });
      if (e.event === "Progress") {
        done += e.data.chunkLength;
        useUpdates.setState((s) => ({ phase: { state: "downloading", done, total: s.phase.state === "downloading" ? s.phase.total : undefined } }));
      }
    });
    await relaunch();
  } catch (e) {
    useUpdates.setState({ phase: { state: "error", message: errText(e) } });
  }
}

/** Checks steerglass.com shortly after launch and then every few hours. */
export function useUpdateChecks() {
  const store = useStore((s) => s.appStore);
  useEffect(() => {
    if (store || !enabled()) return;
    const quiet = () => checkNow().catch(() => {});
    const first = setTimeout(quiet, FIRST_CHECK_MS);
    const every = setInterval(quiet, CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [store]);
}

export function UpdateBanner() {
  const { update, phase, dismissed } = useUpdates();
  if (!update || phase.state === "idle" || dismissed === update.version) return null;
  const pct = phase.state === "downloading" && phase.total ? Math.round((phase.done / phase.total) * 100) : null;
  return (
    <div className="update-banner">
      <Download size={15} className="update-icon" />
      <div className="update-body">
        <div>
          <b>Steerglass {update.version}</b> is available
        </div>
        {phase.state === "downloading" ? (
          <div className="small muted">Downloading{pct !== null ? ` ${pct}%` : "…"} The app restarts when it's done.</div>
        ) : phase.state === "error" ? (
          <div className="error small">{phase.message}</div>
        ) : (
          <div className="dialog-actions left">
            <button className="btn primary small" onClick={install}>
              Update and restart
            </button>
            <button className="btn small" onClick={() => useUpdates.setState({ dismissed: update.version })}>
              Later
            </button>
          </div>
        )}
      </div>
      {phase.state !== "downloading" && (
        <button className="icon-btn tiny" onClick={() => useUpdates.setState({ dismissed: update.version })} aria-label="Dismiss">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function UpdateSettings() {
  const store = useStore((s) => s.appStore);
  const update = useUpdates((s) => s.update);
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getVersion().then(setVersion);
  }, []);
  if (store) return null;

  const run = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const found = await checkNow();
      useUpdates.setState({ dismissed: null });
      setStatus(found ? null : "You're on the latest version.");
    } catch (e) {
      setStatus(`Couldn't check for updates: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow
      title={`Steerglass ${version}`}
      desc={status ?? (update ? `Version ${update.version} is available.` : "Checks steerglass.com for new versions every few hours.")}
    >
      {update ? (
        <button className="btn primary" onClick={install}>
          Update and restart
        </button>
      ) : (
        <button className="btn" disabled={busy} onClick={run}>
          {busy ? "Checking…" : "Check for updates"}
        </button>
      )}
    </SettingRow>
  );
}
