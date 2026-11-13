import { useEffect, useMemo, useState } from "react";
import { CircleHelp, LayoutGrid, Search, Settings, Star, Upload } from "lucide-react";
import { orderedContexts, shortcutContexts, useStore } from "../store";
import { CATEGORIES, customGroups, kindKey } from "../kinds";
import { fuzzy, isMac, modKey, shortContext } from "../util";
import { Logo } from "./Logo";
import { EnvTag } from "./EnvTag";
import { ENV_NAME, ENVS, resolveEnv, type EnvChoice } from "../env";

export function Sidebar() {
  const report = useStore((s) => s.report);
  const contexts = useStore((s) => s.contexts);
  const view = useStore((s) => s.view);
  const kind = useStore((s) => s.kind);
  const favorites = useStore((s) => s.favorites);
  const probes = useStore((s) => s.probes);
  const discovered = useStore((s) => s.discovered);
  const envs = useStore((s) => s.envs);
  const { toggleContext, setKind, set, toggleFavorite, setEnv } = useStore.getState();
  const [envMenu, setEnvMenu] = useState<{ ctx: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!envMenu) return;
    const close = () => setEnvMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [envMenu]);
  const [q, setQ] = useState("");

  const list = useMemo(() => {
    const all = report?.contexts ?? [];
    const filtered = q ? all.filter((c) => fuzzy(q.toLowerCase(), c.name) >= 0) : all;
    return orderedContexts(filtered, favorites);
  }, [report, q, favorites]);
  const shortcuts = useMemo(() => shortcutContexts(report, favorites), [report, favorites]);

  const custom = useMemo(() => customGroups(discovered[contexts[0]] ?? []), [discovered, contexts]);
  const activeKind = kindKey(kind);

  return (
    <aside className="sidebar">
      <div className="brand" data-tauri-drag-region>
        <Logo size={22} />
        <span className="brand-name" data-tauri-drag-region>
          Steerglass
        </span>
      </div>

      <button className={`nav-item ${view === "overview" ? "active" : ""}`} onClick={() => set({ view: "overview" })}>
        <LayoutGrid size={14} /> Overview
      </button>

      <div className="section-title">
        Clusters <span className="muted">{report?.contexts.length ?? 0}</span>
      </div>
      <div className="ctx-search">
        <Search size={12} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter clusters" spellCheck={false} />
      </div>
      <div className="ctx-list" title={`${isMac ? "⌘" : "Ctrl"}+click to select multiple clusters`}>
        {list.map((c) => {
          const p = probes[c.name];
          const dot = !p ? "idle" : p.state === "ok" ? "ok" : p.state === "error" ? "error" : "loading";
          const active = view === "resources" && contexts.includes(c.name);
          return (
            <div
              key={c.name}
              className={`ctx-item ${active ? "active" : ""}`}
              onClick={(e) => toggleContext(c.name, e.metaKey || e.ctrlKey)}
              onContextMenu={(e) => {
                e.preventDefault();
                setEnvMenu({ ctx: c.name, x: e.clientX, y: e.clientY });
              }}
              title={`${c.name}\n${c.server ?? ""}\n${c.source}\nRight-click to set its environment`}
            >
              <span className={`dot ${dot}`} />
              <span className="ctx-name">{shortContext(c.name)}</span>
              <EnvTag env={resolveEnv(envs, c.name)} />
              {shortcuts.includes(c.name) && (
                <kbd className="ctx-key" title={`${modKey}${shortcuts.indexOf(c.name) + 1} opens this cluster`}>
                  {modKey}
                  {shortcuts.indexOf(c.name) + 1}
                </kbd>
              )}
              <button
                className={`star ${favorites.includes(c.name) ? "on" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(c.name);
                }}
                aria-label="Favorite"
              >
                <Star size={11} />
              </button>
            </div>
          );
        })}
        {report && report.contexts.length === 0 && (
          <div className="empty-small">No kubeconfig contexts found. Add a kubeconfig in Settings.</div>
        )}
      </div>

      {view === "resources" && (
        <div className="kinds">
          {CATEGORIES.map((cat) => (
            <div key={cat.name}>
              <div className="section-title">{cat.name}</div>
              {cat.kinds.map((k) => (
                <button
                  key={k.label}
                  className={`nav-item ${activeKind === kindKey(k.ref) ? "active" : ""}`}
                  onClick={() => setKind(k.ref)}
                >
                  {k.label}
                </button>
              ))}
            </div>
          ))}
          {custom.length > 0 && <div className="section-title">Custom resources</div>}
          {custom.map((g) => (
            <details key={g.group} className="crd-group" open={g.kinds.some((k) => kindKey(k) === activeKind)}>
              <summary>{g.group}</summary>
              {g.kinds.map((k) => (
                <button
                  key={k.plural}
                  className={`nav-item ${activeKind === kindKey(k) ? "active" : ""}`}
                  onClick={() => setKind(k)}
                >
                  {k.kind}
                </button>
              ))}
            </details>
          ))}
        </div>
      )}

      {envMenu && (
        <div className="menu" style={{ left: Math.min(envMenu.x, window.innerWidth - 200), top: Math.min(envMenu.y, window.innerHeight - 200) }}>
          <div className="menu-title">Environment</div>
          {([...ENVS, "none", "auto"] as (EnvChoice | "auto")[]).map((choice) => {
            const current = envs[envMenu.ctx] ?? "auto";
            return (
              <button key={choice} onClick={() => setEnv(envMenu.ctx, choice)}>
                {choice === "auto" ? "Detect from name" : choice === "none" ? "None" : ENV_NAME[choice]}
                {current === choice && <kbd>✓</kbd>}
              </button>
            );
          })}
        </div>
      )}

      <div className="sidebar-footer">
        <button className="icon-btn" onClick={() => set({ applyOpen: true })} title="Apply YAML">
          <Upload size={14} />
        </button>
        <button className="icon-btn" onClick={() => set({ settingsOpen: true })} title="Settings">
          <Settings size={14} />
        </button>
        <button className="icon-btn" onClick={() => set({ helpOpen: true })} title="Help & keyboard shortcuts (?)">
          <CircleHelp size={14} />
        </button>
      </div>
    </aside>
  );
}
