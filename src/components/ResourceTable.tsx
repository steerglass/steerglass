import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, Search, X } from "lucide-react";
import { useStore } from "../store";
import { useWatch, type CtxRow } from "../useWatch";
import { kindLabel } from "../kinds";
import { actionsFor, runShortcut, type Action } from "../actions";
import { NamespacePicker } from "./NamespacePicker";
import { age, fuzzy, modKey, shortContext, typingIn, useNow } from "../util";
import type { Health, ObjRef } from "../api";
import { resolveEnv, strictestEnv } from "../env";
import { EnvTag } from "./EnvTag";
import { NodeCapacity, NodeUsageCell, podUsageCell, useNodeUsage } from "./Usage";
import type { NodeUsage, PodUsage } from "../api";

const ROW_H = 32;
const NODE_ROW_H = 44;

const HEALTH_CHIPS: [Health, string][] = [
  ["ok", "Healthy"],
  ["warn", "Warning"],
  ["error", "Failing"],
  ["neutral", "Other"],
];

/** Columns holding addresses and machine names: monospaced. */
const MONO = new Set(["Node", "IP", "Cluster IP", "External IP", "Internal IP", "Endpoints", "Ports", "Volume", "Claim"]);

type SortKey = { col: string; dir: 1 | -1 };

/** Sorts "2/3", "15", "web-10" style values naturally. One shared collator: `localeCompare` with
 * options builds a new one per call, which made sorting 5k rows ~16x slower. */
const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

/** Lowercased text the filter matches against, cached per row object (rows are replaced on change). */
const haystacks = new WeakMap<CtxRow, string>();
function haystack(r: CtxRow) {
  let h = haystacks.get(r);
  if (h === undefined) {
    h = `${r.name} ${r.namespace ?? ""} ${r.cells.join(" ")}`.toLowerCase();
    haystacks.set(r, h);
  }
  return h;
}

/** Value a column sorts by: independent of the clock, so the list isn't re-sorted every tick. */
function sortValue(r: CtxRow, col: string, colIndex: Map<string, number>): string {
  switch (col) {
    case "Cluster":
      return shortContext(r.context);
    case "Name":
      return r.name;
    case "Namespace":
      return r.namespace ?? "";
    default: {
      const i = colIndex.get(col);
      return i === undefined ? "" : (r.cells[i] ?? "");
    }
  }
}

export function ResourceTable() {
  const contexts = useStore((s) => s.contexts);
  const kind = useStore((s) => s.kind);
  const namespace = useStore((s) => s.namespace);
  const filter = useStore((s) => s.filter);
  const selected = useStore((s) => s.selected);
  const detailOpen = useStore((s) => !!s.detail);
  const namespacesByCtx = useStore((s) => s.namespaces);
  const envs = useStore((s) => s.envs);
  const env = strictestEnv(contexts.map((c) => resolveEnv(envs, c)));
  const [healthFilter, setHealthFilter] = useState<Health | null>(null);
  const usageMap = useStore((s) => s.usage);
  const isPods = kind.group === "" && kind.kind === "Pod";
  const isNodes = kind.group === "" && kind.kind === "Node";
  const nodeReports = useNodeUsage(contexts, isNodes);
  const nodeIndex = useMemo(() => {
    const m = new Map<string, NodeUsage>();
    for (const [ctx, r] of Object.entries(nodeReports)) for (const n of r.nodes) m.set(`${ctx}|${n.name}`, n);
    return m;
  }, [nodeReports]);
  const usageOn = isPods && contexts.some((c) => usageMap[c]?.available);
  const nodeOn = isNodes && nodeIndex.size > 0;
  const usageOf = useCallback(
    (r: CtxRow): PodUsage | undefined => (isPods ? usageMap[r.context]?.byKey.get(`${r.namespace}/${r.name}`) : undefined),
    [isPods, usageMap],
  );
  const nodeOf = useCallback((r: CtxRow): NodeUsage | undefined => (isNodes ? nodeIndex.get(`${r.context}|${r.name}`) : undefined), [isNodes, nodeIndex]);
  useEffect(() => setHealthFilter(null), [contexts, kind]);
  const { setFilter, select, openDetail } = useStore.getState();

  const { rows, columns, synced, errors } = useWatch(contexts, kind, namespace);
  const now = useNow(5000);
  const [sort, setSort] = useState<SortKey>({ col: "Name", dir: 1 });
  const [menu, setMenu] = useState<{ x: number; y: number; actions: Action[] } | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const multi = contexts.length > 1;
  const showNs = kind.namespaced && !namespace;
  const headers = useMemo(
    () => [...(multi ? ["Cluster"] : []), "Name", ...(showNs ? ["Namespace"] : []), ...columns, ...(usageOn || nodeOn ? ["CPU", "Memory"] : []), "Age"],
    [multi, showNs, columns, usageOn, nodeOn],
  );

  const colIndex = useMemo(() => new Map(columns.map((c, i) => [c, i])), [columns]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = healthFilter ? rows.filter((r) => r.health === healthFilter) : rows;
    if (q) {
      // "status:error" style shortcut filters by health; otherwise fuzzy match on name + cells.
      const health = q.match(/^(is|status):(ok|warn|error|neutral|bad)$/)?.[2];
      if (health) list = list.filter((r) => (health === "bad" ? r.health === "error" || r.health === "warn" : r.health === health));
      else {
        // Substring match first; fall back to fuzzy on the name only when nothing matches literally.
        const words = q.split(/\s+/);
        const base = list;
        list = base.filter((r) => {
          const h = haystack(r);
          return words.every((w) => h.includes(w));
        });
        if (list.length === 0) list = base.filter((r) => fuzzy(q, r.name) >= 0);
      }
    }
    const { col, dir } = sort;
    if (col === "CPU" || col === "Memory") {
      // Busiest first for dir = 1; rows without a measurement last.
      const cpu = col === "CPU";
      const keyed = list.map((r) => {
        const u = usageOf(r);
        const n = nodeOf(r);
        const v = u ? (cpu ? u.cpu : u.mem) : n ? ((cpu ? n.cpu : n.mem) ?? -1) : -1;
        return { r, v };
      });
      keyed.sort((a, b) => dir * (b.v - a.v) || cmp(a.r.name, b.r.name));
      return keyed.map((k) => k.r);
    }
    if (col === "Age") {
      // Newest first for dir = 1; timestamps parsed once per row, not once per comparison.
      const keyed = list.map((r) => ({ r, t: Date.parse(r.created ?? "") || 0 }));
      keyed.sort((a, b) => dir * (b.t - a.t));
      return keyed.map((k) => k.r);
    }
    const keyed = list.map((r) => ({ r, v: sortValue(r, col, colIndex) }));
    keyed.sort((a, b) => dir * cmp(a.v, b.v) || cmp(a.r.name, b.r.name));
    return keyed.map((k) => k.r);
  }, [rows, filter, healthFilter, sort, colIndex, usageOf, nodeOf]);

  // Node rows with usage hold two bars per cell.
  const rowH = nodeOn ? NODE_ROW_H : ROW_H;
  const virt = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 20,
  });
  useEffect(() => virt.measure(), [rowH, virt]);

  const refOf = useCallback((r: CtxRow): ObjRef => ({ context: r.context, kind, namespace: r.namespace, name: r.name }), [kind]);
  const selectedIdx = useMemo(() => visible.findIndex((r) => r.key === selected), [visible, selected]);

  const moveSelection = useCallback(
    (delta: number) => {
      if (!visible.length) return;
      const next = Math.max(0, Math.min(visible.length - 1, (selectedIdx < 0 ? -1 : selectedIdx) + delta));
      select(visible[next].key, refOf(visible[next]));
      virt.scrollToIndex(next, { align: "auto" });
    },
    [visible, selectedIdx, select, virt, refOf],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (st.paletteOpen || st.confirm || st.helpOpen || st.settingsOpen || st.applyOpen) return;
      if ((e.key === "f" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typingIn(e))) {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
        return;
      }
      if (e.target === filterRef.current) {
        if (e.key === "ArrowDown" || e.key === "Enter") {
          e.preventDefault();
          filterRef.current?.blur();
          if (selectedIdx < 0) moveSelection(1);
        } else if (e.key === "Escape") {
          if (filter) setFilter("");
          else filterRef.current?.blur();
        }
        return;
      }
      if (typingIn(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const row = selectedIdx >= 0 ? visible[selectedIdx] : null;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === "PageDown") {
        e.preventDefault();
        moveSelection(20);
      } else if (e.key === "PageUp") {
        e.preventDefault();
        moveSelection(-20);
      } else if (e.key === "Home" || e.key === "g") {
        moveSelection(-visible.length);
      } else if (e.key === "End" || e.key === "G") {
        moveSelection(visible.length);
      } else if (e.key === "Enter" && row) {
        openDetail(refOf(row));
      } else if (e.key === "Escape") {
        if (useStore.getState().detail) useStore.getState().closeDetail();
        else if (filter) setFilter("");
        else select(null);
      } else if (row && runShortcut(refOf(row), e.key)) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selectedIdx, moveSelection, filter, setFilter, select, openDetail, refOf]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  // Namespaces come and go: read them again every 30 s and whenever the picker is opened.
  const refreshNamespaces = useCallback(() => contexts.forEach((c) => useStore.getState().ensureNamespaces(c, true)), [contexts]);
  useEffect(() => {
    const id = setInterval(refreshNamespaces, 30_000);
    return () => clearInterval(id);
  }, [refreshNamespaces]);

  const namespaces = useMemo(() => {
    const set = new Set<string>();
    contexts.forEach((c) => namespacesByCtx[c]?.forEach((n) => set.add(n)));
    return [...set].sort();
  }, [contexts, namespacesByCtx]);

  const loading = contexts.some((c) => !synced.has(c));
  const errorList = Object.entries(errors);
  const healthCounts = useMemo(() => {
    const n: Record<Health, number> = { ok: 0, warn: 0, error: 0, neutral: 0 };
    for (const r of rows) n[r.health]++;
    return n;
  }, [rows]);

  const toggleSort = (col: string) => setSort((s) => (s.col === col ? { col, dir: (s.dir * -1) as 1 | -1 } : { col, dir: col === "Age" ? 1 : 1 }));

  const gridTemplate = useMemo(
    () =>
      headers
        .map((h) => {
          if (h === "Name") return "minmax(220px, 3fr)";
          if (h === "CPU" || h === "Memory") return "minmax(170px, 1.4fr)";
          if (h === "Usage") return "minmax(130px, 1fr)";
          if (h === "Message" || h === "Images" || h === "Hosts" || h === "Subjects" || h === "Endpoints" || h === "Most used") return "minmax(200px, 4fr)";
          if (h === "Age" || h === "Restarts" || h === "Ready" || h === "Count" || h === "Data") return "minmax(60px, 0.5fr)";
          return "minmax(90px, 1.2fr)";
        })
        .join(" "),
    [headers],
  );

  return (
    <div className="resources">
      {env && <div className={`env-strip env-${env}`} />}
      <header className="toolbar" data-tauri-drag-region>
        <h1>
          {kindLabel(kind)}
          <span className="count">{visible.length !== rows.length ? `${visible.length} / ${rows.length}` : rows.length}</span>
          {loading && <Loader2 size={14} className="spin muted" />}
        </h1>
        <div className="ctx-chips">
          {contexts.map((c) => (
            <span key={c} className="chip" title={c}>
              <EnvTag env={resolveEnv(envs, c)} full={contexts.length === 1} />
              {shortContext(c)}
              {contexts.length > 1 && (
                <button onClick={() => useStore.getState().toggleContext(c, true)} aria-label="Remove">
                  <X size={10} />
                </button>
              )}
            </span>
          ))}
        </div>
        <div className="spacer" data-tauri-drag-region />
        {kind.namespaced && (
<NamespacePicker namespaces={namespaces} onOpen={refreshNamespaces} />
        )}
        <div className="filter">
          <Search size={13} />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter  (/ or ${modKey}F)`}
            spellCheck={false}
          />
          {filter && (
            <button onClick={() => setFilter("")} aria-label="Clear">
              <X size={12} />
            </button>
          )}
        </div>
      </header>

      {rows.length > 0 && (
        <div className="health-chips">
          <button className={`hchip ${healthFilter === null ? "on" : ""}`} onClick={() => setHealthFilter(null)}>
            All <span>{rows.length}</span>
          </button>
          {HEALTH_CHIPS.filter(([h]) => healthCounts[h] > 0).map(([h, label]) => (
            <button key={h} className={`hchip ${healthFilter === h ? "on" : ""}`} onClick={() => setHealthFilter(healthFilter === h ? null : h)}>
              <i className={`hdot ${h}`} />
              {label} <span>{healthCounts[h]}</span>
            </button>
          ))}
        </div>
      )}

      {errorList.length > 0 && (
        <div className="error-banner">
          {errorList.map(([ctx, msg]) => (
            <div key={ctx}>
              <AlertTriangle size={13} /> <b>{shortContext(ctx)}</b>: {msg}
            </div>
          ))}
        </div>
      )}

      {nodeOn && <NodeCapacity reports={nodeReports} />}

      <div className="table" style={{ ["--grid" as any]: gridTemplate }}>
        <div className="thead">
          {headers.map((h) => (
            <div key={h} className="th" onClick={() => toggleSort(h)}>
              {h}
              {sort.col === h && (sort.dir === 1 ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
            </div>
          ))}
        </div>
        <div className="tbody" ref={scrollRef}>
          {visible.length === 0 && !loading && (
            <div className="empty">{rows.length ? "No matches for this filter." : `No ${kindLabel(kind).toLowerCase()} found.`}</div>
          )}
          {visible.length === 0 && loading && <div className="empty muted">Loading…</div>}
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((v) => {
              const r = visible[v.index];
              return (
                <TableRow
                  key={r.key}
                  row={r}
                  headers={headers}
                  colIndex={colIndex}
                  now={now}
                  top={v.start}
                  height={rowH}
                  selected={r.key === selected}
                  usage={usageOf(r)}
                  node={nodeOf(r)}
                  onSelect={(row) => select(row.key, refOf(row))}
                  onOpen={(row) => openDetail(refOf(row))}
                  onMenu={(row, x, y) => {
                    select(row.key, refOf(row));
                    setMenu({ x, y, actions: actionsFor(refOf(row)) });
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
      {!detailOpen && (
        <footer className="hint">
          <span>↑↓ navigate</span>
          <span>↵ details</span>
          {kind.kind === "Pod" && !kind.group && (
            <>
              <span>L logs</span>
              <span>S shell</span>
            </>
          )}
          <span>E yaml</span>
          <span>⌫ delete</span>
          <span>{modKey}K commands</span>
          <span>? help</span>
        </footer>
      )}

      {menu && (
        <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - menu.actions.length * 28 - 10) }}>
          {menu.actions.map((a) => (
            <button key={a.id} className={a.danger ? "danger" : ""} onClick={a.run}>
              {a.label}
              {a.shortcut && <kbd>{a.shortcut}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Cell content: status pills, readiness bars and recent restarts get a visual form. */
function Cell({ header, value, row, now }: { header: string; value: string; row: CtxRow; now: number }) {
  if (header === "Status" && value) return <span className={`pill s-${row.health}`}>{value}</span>;
  if (header === "Ready") {
    const m = /^(\d+)\/(\d+)$/.exec(value);
    if (m) {
      const pct = Number(m[2]) ? Math.min(100, (Number(m[1]) / Number(m[2])) * 100) : 0;
      return (
        <span className="ready">
          <span className="ready-bar">
            <span className={`s-${row.health}`} style={{ width: `${pct}%` }} />
          </span>
          {value}
        </span>
      );
    }
  }
  if (header === "Usage" && value.endsWith("%")) {
    return (
      <span className="ready">
        <span className="ready-bar quota-bar">
          <span className={`s-${row.health}`} style={{ width: `${Math.min(100, parseFloat(value))}%` }} />
        </span>
        {value}
      </span>
    );
  }
  if (header === "Restarts" && Number(value) > 0) {
    return (
      <>
        <span className="restarts">{value}</span>
        {row.lastRestart && <span className="muted"> · {age(row.lastRestart, now)} ago</span>}
      </>
    );
  }
  return <>{value}</>;
}

interface TableRowProps {
  row: CtxRow;
  headers: string[];
  colIndex: Map<string, number>;
  now: number;
  top: number;
  height: number;
  selected: boolean;
  usage?: PodUsage;
  node?: NodeUsage;
  onSelect: (r: CtxRow) => void;
  onOpen: (r: CtxRow) => void;
  onMenu: (r: CtxRow, x: number, y: number) => void;
}

/** Memoized: a live update re-renders only the rows that changed, moved or got selected. */
const TableRow = memo(
  function TableRow({ row: r, headers, colIndex, now, top, height, selected, usage, node, onSelect, onOpen, onMenu }: TableRowProps) {
    return (
      <div
        className={`tr h-${r.health} ${selected ? "selected" : ""}`}
        style={{ transform: `translateY(${top}px)`, height }}
        onClick={() => onSelect(r)}
        onDoubleClick={() => onOpen(r)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(r, e.clientX, e.clientY);
        }}
      >
        {headers.map((h) => {
          const val = h === "Age" ? age(r.created, now) : sortValue(r, h, colIndex);
          return (
            <div key={h} className={`td ${h === "Name" ? "name" : ""} ${MONO.has(h) ? "mono-cell" : ""}`} title={val}>
              {h === "Name" && <span className={`hdot ${r.health}`} />}
              {(h === "CPU" || h === "Memory") && (usage || node) ? (
                usage ? (
                  podUsageCell(h, usage)
                ) : (
                  <NodeUsageCell header={h} n={node!} />
                )
              ) : (
                <Cell header={h} value={val} row={r} now={now} />
              )}
            </div>
          );
        })}
      </div>
    );
  },
  // Handlers are recreated every render but always do the same thing for a given row.
  (a, b) =>
    a.row === b.row &&
    a.headers === b.headers &&
    a.colIndex === b.colIndex &&
    a.top === b.top &&
    a.height === b.height &&
    a.selected === b.selected &&
    a.usage === b.usage &&
    a.node === b.node &&
    (a.now === b.now || !a.headers.includes("Age")),
);
