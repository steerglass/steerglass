import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useStore, type DetailTab } from "../store";
import { actionsFor } from "../actions";
import { shortContext } from "../util";
import { ObjectOverview } from "./ObjectOverview";
import { LogsView } from "./LogsView";
import { EventsView } from "./EventsView";
import { PodResources } from "./Usage";

const YamlEditor = lazy(() => import("./YamlEditor").then((m) => ({ default: m.YamlEditor })));
const Terminal = lazy(() => import("./Terminal").then((m) => ({ default: m.Terminal })));

export function DetailPanel() {
  const detail = useStore((s) => s.detail)!;
  const width = useStore((s) => s.detailWidth);
  const { setDetailTab, closeDetail, set } = useStore.getState();
  const { ref, tab } = detail;
  const isPod = ref.kind.group === "" && ref.kind.kind === "Pod";
  const isNode = ref.kind.group === "" && ref.kind.kind === "Node";
  const dragging = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const tabs: [DetailTab, string][] = [
    ["overview", "Overview"],
    ...(isPod ? ([["resources", "Resources"]] as [DetailTab, string][]) : []),
    ["yaml", "YAML"],
    ...(isPod ? ([["logs", "Logs"], ["shell", "Shell"]] as [DetailTab, string][]) : []),
    ...(isNode ? ([["shell", "Shell"]] as [DetailTab, string][]) : []),
    ["events", "Events"],
  ];

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      const w = Math.max(380, Math.min(window.innerWidth - 420, window.innerWidth - e.clientX));
      set({ detailWidth: w });
    };
    const up = () => {
      dragging.current = false;
      document.body.classList.remove("resizing");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [set]);

  const actions = actionsFor(ref).filter((a) => !["details", "logs", "shell", "yaml", "events"].includes(a.id));
  const key = `${ref.context}|${ref.kind.kind}|${ref.namespace}|${ref.name}`;

  return (
    <section className="detail" style={{ width }}>
      <div
        className="resizer"
        onMouseDown={() => {
          dragging.current = true;
          document.body.classList.add("resizing");
        }}
      />
      <header className="detail-head" data-tauri-drag-region>
        <div className="detail-title">
          <span className="kind-tag">{ref.kind.kind}</span>
          <span className="obj-name" title={ref.name}>
            {ref.name}
          </span>
          <span className="muted small">
            {shortContext(ref.context)}
            {ref.namespace ? ` / ${ref.namespace}` : ""}
          </span>
        </div>
        <div className="detail-actions">
          <div className="dropdown">
            <button className="btn small" onClick={() => setMenuOpen((o) => !o)} onBlur={() => setTimeout(() => setMenuOpen(false), 150)}>
              Actions ▾
            </button>
            {menuOpen && (
              <div className="menu right">
                {actions.map((a) => (
                  <button key={a.id} className={a.danger ? "danger" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => { setMenuOpen(false); a.run(); }}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={closeDetail} title="Close (Esc)">
            <X size={15} />
          </button>
        </div>
      </header>
      <nav className="tabs">
        {tabs.map(([t, label]) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setDetailTab(t)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="detail-body">
        <Suspense fallback={<div className="pad muted">Loading…</div>}>
        {tab === "overview" && <ObjectOverview key={key} objRef={ref} />}
        {tab === "resources" && <PodResources key={key} objRef={ref} />}
        {tab === "yaml" && <YamlEditor key={key} objRef={ref} />}
        {tab === "logs" && <LogsView key={key} objRef={ref} initialContainer={detail.container} />}
        {tab === "shell" && <Terminal key={key + (detail.container ?? "")} objRef={ref} initialContainer={detail.container} />}
        {tab === "events" && <EventsView key={key} objRef={ref} />}
        </Suspense>
      </div>
    </section>
  );
}
