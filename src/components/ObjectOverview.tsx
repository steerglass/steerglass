import { useEffect, useState } from "react";
import { Eye, EyeOff, Copy, FileCode, History, ScrollText, SquareTerminal } from "lucide-react";
import { api, errText, type ObjRef } from "../api";
import { AnnotationValue, ConfigData, UsedBy } from "./ConfigData";
import { ForwardPort } from "./ForwardPort";
import { useStore } from "../store";
import { age, b64decode, useNow } from "../util";
import { parseQuantity, pct } from "../units";

export function ObjectOverview({ objRef }: { objRef: ObjRef }) {
  const [obj, setObj] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(5000);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getObject(objRef)
        .then((o) => alive && (setObj(o), setError(null)))
        .catch((e) => alive && setError(errText(e)));
    load();
    const id = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [objRef]);

  if (error && !obj) return <div className="pad error">{error}</div>;
  if (!obj) return <div className="pad muted">Loading…</div>;

  const md = obj.metadata ?? {};
  const kind = objRef.kind;
  return (
    <div className="overview-obj">
      {error && <div className="error-banner">{error}</div>}
      {kind.group === "" && kind.kind === "Pod" && <PodSummary obj={obj} now={now} />}
      <dl className="props">
        <dt>Created</dt>
        <dd>
          {md.creationTimestamp} <span className="muted">({age(md.creationTimestamp, now)} ago)</span>
        </dd>
        {md.ownerReferences?.length > 0 && (
          <>
            <dt>Owner</dt>
            <dd>{md.ownerReferences.map((o: any) => `${o.kind}/${o.name}`).join(", ")}</dd>
          </>
        )}
        <dt>UID</dt>
        <dd className="mono small">{md.uid}</dd>
        {kind.kind === "Pod" && (
          <>
            <dt>Node</dt>
            <dd>{obj.spec?.nodeName ?? "–"}</dd>
            <dt>Pod IP</dt>
            <dd>{obj.status?.podIP ?? "–"}</dd>
            <dt>QoS</dt>
            <dd>{obj.status?.qosClass}</dd>
            <dt>Service account</dt>
            <dd>{obj.spec?.serviceAccountName}</dd>
          </>
        )}
      </dl>

      <KindSpecific obj={obj} objRef={objRef} />

      {obj.status?.conditions?.length > 0 && (
        <Section title="Conditions">
          <table className="mini">
            <thead>
              <tr>
                <th>Type</th>
                <th>Status</th>
                <th>Reason</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {obj.status.conditions.map((c: any) => (
                <tr key={c.type} title={c.message}>
                  <td>{c.type}</td>
                  <td className={c.status === "True" ? "ok" : c.status === "False" ? "error" : "warn"}>{c.status}</td>
                  <td>{c.reason}</td>
                  <td>{age(c.lastTransitionTime, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <KeyValues title="Labels" data={md.labels} chips />
      <KeyValues title="Annotations" data={md.annotations} />
    </div>
  );
}

/** Status and restarts at a glance, plus the actions used most on a pod. */
function PodSummary({ obj, now }: { obj: any; now: number }) {
  const { setDetailTab } = useStore.getState();
  const statuses: any[] = obj.status?.containerStatuses ?? [];
  const all = [...statuses, ...(obj.status?.initContainerStatuses ?? [])];
  const restarts = all.reduce((n, c) => n + (c.restartCount ?? 0), 0);
  const lastRestart = all
    .map((c) => c.lastState?.terminated?.finishedAt as string | undefined)
    .filter(Boolean)
    .sort()
    .pop();
  const waiting = statuses.find((c) => c.state?.waiting?.reason)?.state.waiting.reason;
  const terminated = statuses.find((c) => c.state?.terminated?.reason)?.state.terminated.reason;
  const phase: string = obj.status?.phase ?? "Unknown";
  const allReady = statuses.length > 0 && statuses.every((c) => c.ready);
  const status = obj.metadata?.deletionTimestamp ? "Terminating" : (waiting ?? terminated ?? phase);
  const health =
    status === "Running"
      ? allReady
        ? "ok"
        : "warn"
      : ["Pending", "ContainerCreating", "PodInitializing", "Terminating"].includes(status)
        ? "warn"
        : ["Succeeded", "Completed"].includes(status)
          ? "neutral"
          : "error";
  const actions: [string, string, React.ReactNode, () => void][] = [
    ["Logs", "L", <ScrollText size={13} />, () => setDetailTab("logs")],
    ["Shell", "S", <SquareTerminal size={13} />, () => setDetailTab("shell")],
    ["YAML", "E", <FileCode size={13} />, () => setDetailTab("yaml")],
    ["Events", "", <History size={13} />, () => setDetailTab("events")],
  ];
  return (
    <div className="pod-summary">
      <div className="row-gap">
        <span className={`pill s-${health}`}>{status}</span>
        <span className="muted">
          {restarts === 0
            ? "No restarts"
            : `Restarted ${restarts} time${restarts === 1 ? "" : "s"}${lastRestart ? ` · last ${age(lastRestart, now)} ago` : ""}`}
        </span>
      </div>
      <div className="quick-actions">
        {actions.map(([label, key, icon, run]) => (
          <button key={label} className={`btn ${label === "Logs" ? "accent" : ""}`} onClick={run}>
            {icon}
            {label}
            {key && <kbd>{key}</kbd>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One bar per quota resource, fullest first: yellow from 80%, red when full (new pods are refused). */
function QuotaUsage({ obj }: { obj: any }) {
  const hard: Record<string, string> = obj.status?.hard ?? obj.spec?.hard ?? {};
  const used: Record<string, string> = obj.status?.used ?? {};
  const items = Object.entries(hard)
    .map(([res, h]) => {
      const u = used[res] ?? "0";
      const hv = parseQuantity(h);
      const uv = parseQuantity(u) ?? 0;
      const share = hv ? uv / hv : uv > 0 ? 1 : 0;
      return { res, h, u, share };
    })
    .sort((a, b) => b.share - a.share || a.res.localeCompare(b.res));
  if (items.length === 0) return null;
  const scopes: string[] = obj.spec?.scopes ?? [];
  return (
    <Section title="Usage">
      <div className="quota-list">
        {items.map((i) => {
          const h = i.share >= 1 ? "error" : i.share >= 0.8 ? "warn" : "ok";
          return (
            <div key={i.res} className="quota-row">
              <span className="mono small">{i.res}</span>
              <span className="ready-bar wide">
                <span className={`s-${h}`} style={{ width: `${Math.min(100, i.share * 100)}%` }} />
              </span>
              <span className="small quota-num">
                {i.u} / {i.h} <span className={i.share >= 0.8 ? `quota-pct s-${h}` : "muted"}>{pct(i.share)}</span>
              </span>
            </div>
          );
        })}
      </div>
      {scopes.length > 0 && <div className="muted small">Scopes: {scopes.join(", ")}</div>}
    </Section>
  );
}

function LimitRangeTable({ obj }: { obj: any }) {
  const rows: { type: string; res: string; vals: Record<string, string | undefined> }[] = [];
  for (const l of obj.spec?.limits ?? []) {
    const fields = ["min", "max", "defaultRequest", "default", "maxLimitRequestRatio"];
    const resources = new Set<string>(fields.flatMap((f) => Object.keys(l[f] ?? {})));
    for (const res of [...resources].sort()) rows.push({ type: l.type, res, vals: Object.fromEntries(fields.map((f) => [f, l[f]?.[res]])) });
  }
  if (rows.length === 0) return null;
  return (
    <Section title="Limits">
      <table className="mini">
        <thead>
          <tr>
            <th>Type</th>
            <th>Resource</th>
            <th>Min</th>
            <th>Max</th>
            <th>Default request</th>
            <th>Default limit</th>
            <th>Max ratio</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.type}-${r.res}`}>
              <td>{r.type}</td>
              <td className="mono">{r.res}</td>
              {["min", "max", "defaultRequest", "default", "maxLimitRequestRatio"].map((f) => (
                <td key={f} className="mono">{r.vals[f] ?? "–"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="obj-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function KeyValues({ title, data, chips }: { title: string; data?: Record<string, string>; chips?: boolean }) {
  if (!data || Object.keys(data).length === 0) return null;
  return (
    <Section title={title}>
      {chips ? (
        <div className="chips">
          {Object.entries(data).map(([k, v]) => (
            <span key={k} className="chip" onClick={() => navigator.clipboard.writeText(`${k}=${v}`)} title="Click to copy">
              {k}={v}
            </span>
          ))}
        </div>
      ) : (
        <dl className="props kv">
          {Object.entries(data).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>
                <AnnotationValue name={k} value={v} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

function KindSpecific({ obj, objRef }: { obj: any; objRef: ObjRef }) {
  const { kind } = objRef;
  if (kind.group === "" && kind.kind === "Pod") return <PodContainers obj={obj} objRef={objRef} />;
  if (kind.group === "" && kind.kind === "Service") return <ServicePorts obj={obj} objRef={objRef} />;
  if (kind.group === "" && (kind.kind === "Secret" || kind.kind === "ConfigMap")) {
    return (
      <>
        {kind.kind === "Secret" ? <SecretData obj={obj} /> : <ConfigData obj={obj} />}
        <UsedBy objRef={objRef} />
      </>
    );
  }
  if (kind.group === "" && kind.kind === "ResourceQuota") return <QuotaUsage obj={obj} />;
  if (kind.group === "" && kind.kind === "LimitRange") return <LimitRangeTable obj={obj} />;
  if (kind.group === "apps" && obj.spec?.template?.spec?.containers) {
    return (
      <Section title="Containers">
        {obj.spec.template.spec.containers.map((c: any) => (
          <div key={c.name} className="container-card">
            <b>{c.name}</b> <span className="mono small">{c.image}</span>
          </div>
        ))}
        {obj.spec.replicas !== undefined && (
          <div className="muted small">
            Replicas: {obj.status?.readyReplicas ?? 0} ready / {obj.spec.replicas} desired
          </div>
        )}
      </Section>
    );
  }
  return null;
}

function PodContainers({ obj, objRef }: { obj: any; objRef: ObjRef }) {
  const { setDetailTab } = useStore.getState();
  const statuses: Record<string, any> = {};
  for (const s of [...(obj.status?.containerStatuses ?? []), ...(obj.status?.initContainerStatuses ?? [])]) statuses[s.name] = s;
  const containers = [
    ...(obj.spec?.initContainers ?? []).map((c: any) => ({ ...c, init: true })),
    ...(obj.spec?.containers ?? []),
  ];
  return (
    <Section title="Containers">
      {containers.map((c: any) => {
        const s = statuses[c.name];
        const state = s?.state ? Object.keys(s.state)[0] : "unknown";
        const reason = s?.state?.[state]?.reason;
        return (
          <div key={c.name} className="container-card">
            <div className="container-head">
              <span className={`hdot ${s?.ready ? "ok" : state === "running" ? "warn" : state === "terminated" && s?.state?.terminated?.exitCode === 0 ? "neutral" : "error"}`} />
              <b>{c.name}</b>
              {c.init && <span className="tag">init</span>}
              <span className="muted small">
                {state}
                {reason ? ` · ${reason}` : ""} · {s?.restartCount ?? 0} restarts
              </span>
              <div className="spacer" />
              <button className="btn small" onClick={() => setDetailTab("logs", c.name)}>
                <ScrollText size={12} /> Logs
              </button>
              {!c.init && (
                <button className="btn small" onClick={() => setDetailTab("shell", c.name)}>
                  <SquareTerminal size={12} /> Shell
                </button>
              )}
            </div>
            <div className="mono small muted">{c.image}</div>
            {(c.resources?.requests || c.resources?.limits) && (
              <div className="small muted">
                {c.resources.requests && `requests: ${Object.entries(c.resources.requests).map(([k, v]) => `${k} ${v}`).join(", ")}`}
                {c.resources.limits && `  limits: ${Object.entries(c.resources.limits).map(([k, v]) => `${k} ${v}`).join(", ")}`}
              </div>
            )}
            {c.ports?.length > 0 && (
              <div className="ports">
                {c.ports.map((p: any) => (
                  <ForwardPort key={p.containerPort} context={objRef.context} namespace={objRef.namespace!} kind="Pod" name={objRef.name} port={p.containerPort}>
                    {p.name ? `${p.name}:` : ""}
                    {p.containerPort}/{p.protocol ?? "TCP"}
                  </ForwardPort>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </Section>
  );
}

function ServicePorts({ obj, objRef }: { obj: any; objRef: ObjRef }) {
  return (
    <Section title="Ports">
      <div className="ports">
        {(obj.spec?.ports ?? []).map((p: any) => (
          <ForwardPort key={p.port} context={objRef.context} namespace={objRef.namespace!} kind="Service" name={objRef.name} port={p.port}>
            {p.name ? `${p.name}: ` : ""}
            {p.port}
            {p.targetPort !== undefined && String(p.targetPort) !== String(p.port) && <span className="faint">pod {p.targetPort}</span>}
          </ForwardPort>
        ))}
      </div>
      {obj.spec?.selector && <div className="small muted">Selector: {Object.entries(obj.spec.selector).map(([k, v]) => `${k}=${v}`).join(", ")}</div>}
    </Section>
  );
}

function SecretData({ obj }: { obj: any }) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const data: Record<string, string> = obj.data ?? {};
  if (!Object.keys(data).length) return null;
  return (
    <Section title="Data">
      <dl className="props kv">
        {Object.entries(data).map(([k, v]) => (
          <div key={k}>
            <dt>
              {k}
              <button className="icon-btn tiny" onClick={() => setShown((s) => ({ ...s, [k]: !s[k] }))} title={shown[k] ? "Hide" : "Reveal"}>
                {shown[k] ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
              <button className="icon-btn tiny" onClick={() => navigator.clipboard.writeText(b64decode(v))} title="Copy decoded value">
                <Copy size={11} />
              </button>
            </dt>
            <dd className="mono small">{shown[k] ? b64decode(v) : "••••••••"}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
