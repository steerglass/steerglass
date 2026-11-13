import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api, errText, type NodeUsage, type NodeUsageReport, type ObjRef, type PodHistory, type PodUsage, type UsageSample } from "../api";
import { fmtBytes, fmtCores, pct, share } from "../units";
import { shortContext } from "../util";

/** At or above this share of the limit a value is flagged. */
const HOT = 0.9;
const POLL_MS = 15_000;

// ---------------------------------------------------------------- table cells

/** "238m ▬▬▬── 60%": usage, and its share of the limit (or of the request when there is no limit). */
export function UsageCell({ value, limit, request, fmt }: { value: number; limit?: number | null; request: number; fmt: (v: number) => string }) {
  const f = share(value, limit) ?? share(value, request);
  const hot = limit ? value / limit >= HOT : false;
  return (
    <span className="usage-cell" title={`${fmt(value)} used${request ? ` · request ${fmt(request)}` : ""}${limit ? ` · limit ${fmt(limit)}` : " · no limit"}`}>
      <span className="usage-val">{fmt(value)}</span>
      {f !== null ? (
        <span className="usage-bar">
          <span style={{ width: pct(Math.min(1, f)) }} />
        </span>
      ) : (
        <span className="usage-none">no limit</span>
      )}
      <span className={`usage-pct ${hot ? "hot" : ""}`}>{f === null ? "" : `${hot ? "⚠ " : ""}${pct(f)}`}</span>
    </span>
  );
}

export function podUsageCell(header: string, u: PodUsage) {
  return header === "CPU" ? (
    <UsageCell value={u.cpu} limit={u.cpuLimit} request={u.cpuRequest} fmt={fmtCores} />
  ) : (
    <UsageCell value={u.mem} limit={u.memLimit} request={u.memRequest} fmt={fmtBytes} />
  );
}

/** Node cell: used and requested, each against the allocatable capacity. */
export function NodeUsageCell({ header, n }: { header: string; n: NodeUsage }) {
  const cpu = header === "CPU";
  const used = cpu ? n.cpu : n.mem;
  const req = cpu ? n.cpuRequested : n.memRequested;
  const alloc = cpu ? n.cpuAllocatable : n.memAllocatable;
  const fmt = cpu ? fmtCores : fmtBytes;
  const hot = used != null && alloc > 0 && used / alloc >= 0.85;
  return (
    <span className="node-usage" title={`${used != null ? `${fmt(used)} used · ` : ""}${fmt(req)} requested · ${fmt(alloc)} allocatable`}>
      <span className="node-usage-head">
        <span>
          {used != null ? fmt(used) : "–"} / {fmt(alloc)}
        </span>
        <span className={hot ? "hot" : "muted"}>{hot ? `⚠ ${pct(used! / alloc)}` : `${alloc ? pct(req / alloc) : "–"} req`}</span>
      </span>
      <span className="usage-bar thin">{used != null && alloc > 0 && <span style={{ width: pct(Math.min(1, used / alloc)) }} />}</span>
      <span className="usage-bar thin req">{alloc > 0 && <span style={{ width: pct(Math.min(1, req / alloc)) }} />}</span>
    </span>
  );
}

// ---------------------------------------------------------------- node capacity

/** Polls node usage for the given clusters while mounted. */
export function useNodeUsage(contexts: string[], enabled: boolean) {
  const [reports, setReports] = useState<Record<string, NodeUsageReport>>({});
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      contexts.forEach((c) =>
        api
          .nodeUsage(c)
          .then((r) => alive && setReports((s) => ({ ...s, [c]: r })))
          .catch(() => {}),
      );
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [contexts, enabled]);
  return reports;
}

/** Cluster totals (used and requested against allocatable) and the busiest pods. */
export function NodeCapacity({ reports }: { reports: Record<string, NodeUsageReport> }) {
  const totals = useMemo(() => {
    const t = { cpu: 0, mem: 0, cpuAlloc: 0, memAlloc: 0, cpuReq: 0, memReq: 0, measured: false };
    for (const r of Object.values(reports)) {
      for (const n of r.nodes) {
        t.cpuAlloc += n.cpuAllocatable;
        t.memAlloc += n.memAllocatable;
        t.cpuReq += n.cpuRequested;
        t.memReq += n.memRequested;
        if (n.cpu != null) {
          t.cpu += n.cpu;
          t.mem += n.mem ?? 0;
          t.measured = true;
        }
      }
    }
    return t;
  }, [reports]);
  const multi = Object.keys(reports).length > 1;
  const top = Object.entries(reports)
    .flatMap(([ctx, r]) => r.top.map((p) => ({ ...p, ctx })))
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 5);
  if (!totals.cpuAlloc) return null;
  const maxTop = top[0]?.cpu || 1;
  const card = (title: string, used: number, req: number, alloc: number, fmt: (v: number) => string) => (
    <section className="cap-card">
      <div className="cap-head">
        <h3>{title}</h3>
        {totals.measured ? (
          <>
            <b>{pct(used / alloc)}</b>
            <span className="muted">
              used · {fmt(used)} of {fmt(alloc)}
            </span>
          </>
        ) : (
          <span className="muted">{fmt(alloc)} allocatable</span>
        )}
      </div>
      {totals.measured && (
        <span className="usage-bar wide">
          <span style={{ width: pct(Math.min(1, used / alloc)) }} />
        </span>
      )}
      <span className="usage-bar wide req">
        <span style={{ width: pct(Math.min(1, req / alloc)) }} />
      </span>
      <span className="muted small">
        {pct(req / alloc)} requested ({fmt(req)}) · {fmt(Math.max(0, alloc - req))} still schedulable
      </span>
    </section>
  );
  return (
    <div className="capacity">
      {card("CPU", totals.cpu, totals.cpuReq, totals.cpuAlloc, fmtCores)}
      {card("Memory", totals.mem, totals.memReq, totals.memAlloc, fmtBytes)}
      <section className="cap-card">
        <div className="cap-head">
          <h3>Top pods by CPU</h3>
        </div>
        {top.length === 0 && <span className="muted small">{totals.measured ? "Measuring…" : "Needs metrics-server."}</span>}
        {top.map((p) => (
          <div key={`${p.ctx}/${p.namespace}/${p.name}`} className="top-pod" title={`${p.namespace}/${p.name}`}>
            <span className="top-name">
              {p.name} <span className="muted">{multi ? `${shortContext(p.ctx)} · ` : ""}{p.namespace}</span>
            </span>
            <span className="usage-bar">
              <span style={{ width: pct(p.cpu / maxTop) }} />
            </span>
            <span className="top-val">{fmtCores(p.cpu)}</span>
          </div>
        ))}
      </section>
      <div className="cap-legend muted small">
        <span>
          <i className="sw used" /> Used
        </span>
        <span>
          <i className="sw req" /> Requested by pods
        </span>
        <span>Track = allocatable</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pod history

const RANGES: [string, number][] = [
  ["15m", 15 * 60],
  ["1h", 60 * 60],
  ["6h", 6 * 60 * 60],
  ["24h", 24 * 60 * 60],
];

export function PodResources({ objRef }: { objRef: ObjRef }) {
  const [range, setRange] = useState(3600);
  const [h, setH] = useState<PodHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .podHistory(objRef.context, objRef.namespace ?? "", objRef.name, range)
        .then((r) => {
          if (!alive) return;
          setH(r);
          setError(null);
          setNow(Date.now());
        })
        .catch((e) => alive && setError(errText(e)));
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [objRef, range]);

  if (error && !h) return <div className="pad error">{error}</div>;
  if (!h) return <div className="pad muted">Loading…</div>;
  if (!h.available)
    return (
      <div className="pad muted">
        This cluster has no metrics-server, so CPU and memory usage aren't available. Most managed clusters (GKE, EKS, AKS) include it; elsewhere it can be
        installed from kubernetes-sigs/metrics-server.
      </div>
    );

  return (
    <div className="resources-tab">
      <div className="res-toolbar">
        <span className="muted small">Sampled every 15 s while the cluster is open in Steerglass</span>
        <div className="segmented" role="group" aria-label="Time range">
          {RANGES.map(([label, secs]) => (
            <button key={label} className={range === secs ? "on" : ""} onClick={() => setRange(secs)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <UsageChart title="CPU" samples={h.samples} pick={(s) => s.cpu} request={h.cpuRequest} limit={h.cpuLimit} fmt={fmtCores} unit={1000} range={range} now={now} />
      <UsageChart title="Memory" samples={h.samples} pick={(s) => s.mem} request={h.memRequest} limit={h.memLimit} fmt={fmtBytes} unit={1 / 1048576} range={range} now={now} />
      {h.containers.length > 0 && (
        <section className="res-containers">
          <h3>By container · now</h3>
          {h.containers.map((c) => (
            <div key={c.name} className="res-container">
              <b>{c.name}</b>
              <UsageCell value={c.cpu} limit={c.cpuLimit} request={c.cpuRequest} fmt={fmtCores} />
              <UsageCell value={c.mem} limit={c.memLimit} request={c.memRequest} fmt={fmtBytes} />
            </div>
          ))}
          <span className="muted small">Bars show usage against each container's limit, or its request when it has no limit.</span>
        </section>
      )}
    </div>
  );
}

/** Smallest "round" number (1, 2, 2.5, 5 × 10ⁿ) at or above `v`. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

const H = 170;
const PAD = { l: 52, r: 10, t: 12, b: 22 };
/** Samples further apart than this are not joined (the cluster wasn't open in between). */
const GAP_MS = 2 * 60 * 1000;

function UsageChart(props: {
  title: string;
  samples: UsageSample[];
  pick: (s: UsageSample) => number;
  request: number;
  limit?: number | null;
  fmt: (v: number) => string;
  /** Display unit per raw unit (millicores per core, MiB per byte), so axis ticks are round in it. */
  unit: number;
  range: number;
  now: number;
}) {
  const { title, samples, pick, request, limit, fmt, unit, range, now } = props;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(520);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const t0 = now - range * 1000;
  const values = samples.map(pick);
  const current = values.length ? values[values.length - 1] : null;
  const peak = values.length ? Math.max(...values) : 0;
  const yMax = niceCeil(Math.max(peak, limit ?? 0, request) * 1.1 * unit) / unit;
  const x = (t: number) => PAD.l + ((t - t0) / (range * 1000)) * (width - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - (v / yMax) * (H - PAD.t - PAD.b);

  const { line, area } = useMemo(() => {
    let line = "";
    let area = "";
    let seg: [number, number][] = [];
    const flush = () => {
      if (seg.length) {
        line += seg.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
        area += `M${seg[0][0].toFixed(1)} ${H - PAD.b} ` + seg.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ") + ` L${seg[seg.length - 1][0].toFixed(1)} ${H - PAD.b} Z`;
      }
      seg = [];
    };
    samples.forEach((s, i) => {
      if (i && s.t - samples[i - 1].t > GAP_MS) flush();
      seg.push([x(s.t), y(pick(s))]);
    });
    flush();
    return { line, area };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, width, yMax, t0]);

  const ref = limit ?? request;
  const refName = limit ? "limit" : "request";
  const hovered = hover !== null ? samples[hover] : null;
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!samples.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left - PAD.l) / (width - PAD.l - PAD.r)) * range * 1000;
    let best = 0;
    for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i].t - t) < Math.abs(samples[best].t - t)) best = i;
    setHover(best);
  };
  const ticks = [0, yMax / 2, yMax];
  const label = (secs: number) => (secs >= 3600 ? `−${secs / 3600} h` : `−${secs / 60} min`);

  return (
    <section className="usage-chart">
      <div className="uc-head">
        <h3>{title}</h3>
        {current !== null ? (
          <>
            <b>{fmt(current)}</b>
            <span className="muted">{ref ? `${pct(current / ref)} of ${refName}` : "no request or limit"}</span>
            <span className="uc-peak muted">peak {fmt(peak)}</span>
          </>
        ) : (
          <span className="muted">Collecting samples…</span>
        )}
      </div>
      <div className="uc-plot" ref={box}>
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={`${title} over the last ${label(range).slice(1)}${current !== null ? `, now ${fmt(current)}` : ""}${limit ? `, limit ${fmt(limit)}` : ""}`}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line className="uc-grid" x1={PAD.l} x2={width - PAD.r} y1={y(v)} y2={y(v)} />
              <text className="uc-axis" x={PAD.l - 8} y={y(v) + 4} textAnchor="end">
                {fmt(v)}
              </text>
            </g>
          ))}
          <path className="uc-area" d={area} />
          <path className="uc-line" d={line} />
          {request > 0 && (
            <g>
              <line className="uc-ref req" x1={PAD.l} x2={width - PAD.r} y1={y(request)} y2={y(request)} />
              <text className="uc-ref-label" x={width - PAD.r} y={y(request) - 5} textAnchor="end">
                request {fmt(request)}
              </text>
            </g>
          )}
          {limit ? (
            <g>
              <line className="uc-ref lim" x1={PAD.l} x2={width - PAD.r} y1={y(limit)} y2={y(limit)} />
              <text className="uc-ref-label strong" x={width - PAD.r} y={y(limit) - 5} textAnchor="end">
                limit {fmt(limit)}
              </text>
            </g>
          ) : null}
          {hovered && (
            <g>
              <line className="uc-cross" x1={x(hovered.t)} x2={x(hovered.t)} y1={PAD.t} y2={H - PAD.b} />
              <circle className="uc-dot" cx={x(hovered.t)} cy={y(pick(hovered))} r={5} />
            </g>
          )}
          <text className="uc-axis" x={PAD.l} y={H - 5}>
            {label(range)}
          </text>
          <text className="uc-axis" x={width - PAD.r} y={H - 5} textAnchor="end">
            now
          </text>
        </svg>
        {hovered && (
          <div className="uc-tip" style={{ left: Math.min(x(hovered.t) + 12, width - 170) }}>
            <span className="muted">{new Date(hovered.t).toLocaleTimeString()}</span>
            <b>{fmt(pick(hovered))}</b>
            {ref ? (
              <span className="muted">
                {pct(pick(hovered) / ref)} of {refName}
                {limit && request ? ` · ${pct(pick(hovered) / request)} of request` : ""}
              </span>
            ) : null}
          </div>
        )}
        {samples.length < 2 && current !== null && <div className="uc-empty muted small">The chart fills in as samples arrive, every 15 s.</div>}
      </div>
      {limit && current !== null && current / limit >= HOT && (
        <div className="uc-warn">
          <AlertTriangle size={12} /> Using {pct(current / limit)} of its {title.toLowerCase()} limit
        </div>
      )}
    </section>
  );
}
