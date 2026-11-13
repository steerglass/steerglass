import { useEffect, useState } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { Cable, FilePlus, FileStack, Info, Layers, Monitor, Moon, Palette, Sun, Trash2, X } from "lucide-react";
import type { Theme } from "../theme";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errText, type Settings } from "../api";
import { forwardUrl, stopForward } from "./ForwardPort";
import { useStore } from "../store";
import { shortContext } from "../util";
import { detectEnv, ENV_NAME, ENVS, resolveEnv, type EnvChoice } from "../env";
import { GrantKubeDirButton, grant } from "./Dialogs";
import { UpdateSettings } from "./Updates";
import { SettingGroup, SettingRow } from "./SettingRow";
import { EnvTag } from "./EnvTag";
import { Logo } from "./Logo";

type Section = "general" | "appearance" | "kubeconfig" | "environments" | "forwards";

const SECTIONS: [Section, string, React.ReactNode][] = [
  ["general", "General", <Info size={14} />],
  ["appearance", "Appearance", <Palette size={14} />],
  ["kubeconfig", "Kubeconfig", <FileStack size={14} />],
  ["environments", "Environments", <Layers size={14} />],
  ["forwards", "Port forwards", <Cable size={14} />],
];

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const [section, setSection] = useState<Section>("general");
  if (!open) return null;
  const close = () => useStore.getState().set({ settingsOpen: false });
  const title = SECTIONS.find(([s]) => s === section)?.[1];
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog settings" role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-title">Settings</div>
          {SECTIONS.map(([id, label, icon]) => (
            <button key={id} className={`nav-item ${section === id ? "active" : ""}`} onClick={() => setSection(id)}>
              {icon}
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <div className="settings-head">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={close} aria-label="Close">
              <X size={15} />
            </button>
          </div>
          <div className="settings-content">
            {section === "general" && <General />}
            {section === "appearance" && <Appearance />}
            {section === "kubeconfig" && <Kubeconfig />}
            {section === "environments" && <Environments />}
            {section === "forwards" && <Forwards />}
          </div>
        </div>
      </div>
    </div>
  );
}

function General() {
  const store = useStore((s) => s.appStore);
  return (
    <>
      {!store && (
        <SettingGroup title="Updates">
          <UpdateSettings />
        </SettingGroup>
      )}
      <SettingGroup title="Changes">
        <SettingRow title="What's new" desc="What changed in each version of Steerglass.">
          <button className="btn" onClick={() => useStore.getState().set({ settingsOpen: false, whatsNew: "" })}>
            Show changes
          </button>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="About">
        <SettingRow
          title={
            <span className="set-brand">
              <Logo size={18} /> Steerglass
            </span>
          }
          desc="Version, author and links."
        >
          <button className="btn" onClick={() => useStore.getState().set({ settingsOpen: false, aboutOpen: true })}>
            About Steerglass
          </button>
        </SettingRow>
      </SettingGroup>
    </>
  );
}

const THEMES: [Theme, string, string, React.ReactNode][] = [
  ["auto", "Automatic", "Follows your system", <Monitor size={14} />],
  ["light", "Light", "Always light", <Sun size={14} />],
  ["dark", "Dark", "Always dark", <Moon size={14} />],
];

function Appearance() {
  const theme = useStore((s) => s.theme);
  return (
    <SettingGroup title="Theme">
      <div className="theme-picker" role="radiogroup" aria-label="Theme">
        {THEMES.map(([id, label, desc, icon]) => (
          <button key={id} role="radio" aria-checked={theme === id} className={`theme-option ${theme === id ? "on" : ""}`} onClick={() => useStore.getState().set({ theme: id })}>
            <span className={`theme-preview ${id}`} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="theme-label">
              {icon} {label}
            </span>
            <span className="muted small">{desc}</span>
          </button>
        ))}
      </div>
    </SettingGroup>
  );
}

function Kubeconfig() {
  const report = useStore((s) => s.report);
  const [settings, setSettings] = useState<Settings | null>(null);
  const { toast, loadContexts } = useStore.getState();
  useEffect(() => {
    api.getSettings().then(setSettings);
  }, []);
  if (!settings) return null;

  const save = async (next: Settings) => {
    setSettings(next);
    try {
      await api.updateSettings(next);
      await loadContexts(true);
    } catch (e) {
      toast(errText(e), "error");
    }
  };
  const addFile = async () => {
    const path = await openFile({ multiple: false, directory: false, title: "Choose a kubeconfig file" });
    if (typeof path === "string") await grant(path);
  };

  return (
    <>
      <p className="set-intro">
        Steerglass reads <span className="mono">$KUBECONFIG</span>, <span className="mono">~/.kube/config</span> and the files below, like kubectl. Contexts with
        the same name are taken from the first file.
      </p>
      <SettingGroup title="Sources">
        <SettingRow title="Scan ~/.kube" desc="Also load every kubeconfig file found in the ~/.kube folder.">
          <input
            type="checkbox"
            className="switch"
            checked={settings.scanKubeDir}
            onChange={(e) => save({ ...settings, scanKubeDir: e.target.checked })}
            aria-label="Scan ~/.kube"
          />
        </SettingRow>
        {report?.files.map((f) => (
          <SettingRow key={f} title={<span className="mono set-sub">{f}</span>} desc={settings.extraKubeconfigs.includes(f) ? "Added by you" : "Found automatically"}>
            {settings.extraKubeconfigs.includes(f) && (
              <button className="icon-btn" onClick={() => save({ ...settings, extraKubeconfigs: settings.extraKubeconfigs.filter((x) => x !== f) })} aria-label={`Remove ${f}`}>
                <Trash2 size={13} />
              </button>
            )}
          </SettingRow>
        ))}
      </SettingGroup>
      {report?.errors.map((e) => (
        <div key={e} className="error small">
          {e}
        </div>
      ))}
      <div className="row-gap">
        <button className="btn" onClick={addFile}>
          <FilePlus size={13} /> Add kubeconfig file…
        </button>
        <GrantKubeDirButton />
      </div>
    </>
  );
}

function Environments() {
  const report = useStore((s) => s.report);
  const envs = useStore((s) => s.envs);
  const confirmProd = useStore((s) => s.confirmProd);
  const { setEnv } = useStore.getState();
  return (
    <>
      <p className="set-intro">
        The environment colors a cluster everywhere, and production asks before every change. It is guessed from the context name; change it here or by
        right-clicking a cluster in the sidebar.
      </p>
      <SettingGroup title="Production">
        <SettingRow
          title="Confirm changes on production"
          desc="Ask before saving YAML, applying, scaling, restarting, cordoning, suspending, or starting a debug container or node shell. Deleting always asks you to type the name."
        >
          <input
            type="checkbox"
            className="switch"
            checked={confirmProd}
            onChange={(e) => useStore.getState().set({ confirmProd: e.target.checked })}
            aria-label="Confirm changes on production"
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Clusters">
        {(report?.contexts ?? []).map((c) => {
          const detected = detectEnv(c.name);
          const choice = (envs[c.name] as EnvChoice | undefined) ?? "auto";
          return (
            <SettingRow
              key={c.name}
              title={
                <span className="set-env">
                  {shortContext(c.name)} <EnvTag env={resolveEnv(envs, c.name)} />
                </span>
              }
            >
              <select value={choice} onChange={(e) => setEnv(c.name, e.target.value as EnvChoice | "auto")} aria-label={`Environment of ${c.name}`}>
                <option value="auto">Automatic{detected ? ` (${ENV_NAME[detected]})` : " (none)"}</option>
                {ENVS.map((e) => (
                  <option key={e} value={e}>
                    {ENV_NAME[e]}
                  </option>
                ))}
                <option value="none">None</option>
              </select>
            </SettingRow>
          );
        })}
      </SettingGroup>
    </>
  );
}

function Forwards() {
  const forwards = useStore((s) => s.forwards);
  const { toast } = useStore.getState();
  return (
    <SettingGroup title="Active">
      {forwards.length === 0 && <SettingRow title="None active" desc="Click a port in a pod's or service's details to forward it to localhost." />}
      {forwards.map((f) => (
        <SettingRow
          key={f.id}
          title={
            <span className="mono">
              localhost:{f.localPort} → {f.target}:{f.remotePort}
            </span>
          }
          desc={`${shortContext(f.context)} / ${f.namespace}`}
        >
          <button className="btn small" onClick={() => openUrl(forwardUrl(f))}>
            Open
          </button>
          <button className="btn small" onClick={() => stopForward(f).catch((e) => toast(errText(e), "error"))}>
            Stop
          </button>
        </SettingRow>
      ))}
      {forwards.length > 1 && (
        <SettingRow title="Stop all" desc={`${forwards.length} forwards are running.`}>
          <button className="btn small danger" onClick={() => Promise.all(forwards.map(stopForward)).catch((e) => toast(errText(e), "error"))}>
            Stop all
          </button>
        </SettingRow>
      )}
    </SettingGroup>
  );
}
