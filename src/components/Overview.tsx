import { useEffect, useMemo } from "react";
import { RefreshCw, Star } from "lucide-react";
import { orderedContexts, shortcutContexts, useStore } from "../store";
import { age, modKey, shortContext, useNow } from "../util";
import { BUILTIN } from "../kinds";
import { resolveEnv } from "../env";
import type { Issue } from "../api";
import { GrantKubeDirButton } from "./Dialogs";
import { EnvTag } from "./EnvTag";

const ISSUES_EVERY_MS = 60_000;
const MAX_LISTED = 30;

const groupOf = (kind: Issue["kind"]) => (kind === "Job" ? "batch" : "");

/** Opens the resource view on the object an issue is about, with its details. */
async function openIssue(context: string, issue: Issue) {
  const kind = BUILTIN.find((b) => b.ref.group === groupOf(issue.kind) && b.ref.kind === issue.kind)?.ref;
  if (!kind) return;
  const s = useStore.getState();
  await s.openResources([context], kind, issue.namespace ?? "");
  if (useStore.getState().contexts.includes(context)) s.openDetail({ context, kind, namespace: issue.namespace, name: issue.name });
}

export function Overview() {
  const report = useStore((s) => s.report);
  const probes = useStore((s) => s.probes);
  const issues = useStore((s) => s.issues);
  const favorites = useStore((s) => s.favorites);
  const envs = useStore((s) => s.envs);
  const { probeAll, probe, openResources, loadIssues } = useStore.getState();
  const now = useNow(5000);

  useEffect(() => {
    if (report) probeAll(true);
  }, [report, probeAll]);

  // Problems change faster than cluster sizes: refresh them while the overview is open.
  useEffect(() => {
    const id = setInterval(() => {
      for (const [ctx, p] of Object.entries(useStore.getState().probes)) if (p.state === "ok") loadIssues(ctx);
    }, ISSUES_EVERY_MS);
    return () => clearInterval(id);
  }, [loadIssues]);

  const contexts = useMemo(() => orderedContexts(report?.contexts ?? [], favorites), [report, favorites]);
  const shortcuts = useMemo(() => shortcutContexts(report, favorites), [report, favorites]);

  const stats = useMemo(() => {
    let ok = 0,
      err = 0,
      nodes = 0,
      pods = 0;
    for (const p of Object.values(probes)) {
      if (p.state === "ok") {
        ok++;
        nodes += p.data.nodes;
        pods += p.data.pods ?? 0;
      } else if (p.state === "error") err++;
    }
    return { ok, err, nodes, pods };
  }, [probes]);

  const attention = useMemo(() => {
    const list: { context: string; issue: Issue }[] = [];
    for (const c of contexts) {
      const found = issues[c.name];
      if (found && "items" in found && probes[c.name]?.state === "ok") found.items.forEach((issue) => list.push({ context: c.name, issue }));
    }
    return list;
  }, [contexts, issues, probes]);
  const troubled = new Set(attention.map((a) => a.context));
  const lastCheck = Math.max(0, ...Object.values(issues).map((i) => i.at));

  return (
    <div className="overview">
      <header className="toolbar" data-tauri-drag-region>
        <div className="spacer" data-tauri-drag-region />
        <button className="btn" onClick={() => probeAll()}>
          <RefreshCw size={13} /> Refresh all
        </button>
      </header>

      <div className="ov-body">
        <div className="ov-head">
          <h1>Your clusters</h1>
          <div className="muted">
            {stats.ok} connected
            {troubled.size > 0 && <span className="warn"> · {troubled.size} need attention</span>}
            {stats.err > 0 && <span className="error"> · {stats.err} unreachable</span>}
            {stats.ok > 0 && ` · ${stats.nodes} nodes · ${stats.pods.toLocaleString()} pods`}
            {lastCheck > 0 && ` · checked ${age(new Date(lastCheck).toISOString(), now)} ago`}
          </div>
        </div>

        {report && report.contexts.length === 0 && (
          <div className="onboarding">
            <h2>Connect your clusters</h2>
            <p className="muted">
              Steerglass reads the same kubeconfig files as kubectl. No contexts were found
              {report.files.length ? ` in ${report.files.join(", ")}` : ""}.
            </p>
            <div className="row-gap">
              <GrantKubeDirButton primary />
              <button className="btn" onClick={() => useStore.getState().set({ settingsOpen: true })}>
                Add a kubeconfig file…
              </button>
            </div>
            {report.errors.map((e) => (
              <div key={e} className="error small">
                {e}
              </div>
            ))}
          </div>
        )}

        {attention.length > 0 && (
          <section className="attention">
            <h2>Needs attention</h2>
            <div className="attention-list">
              {attention.slice(0, MAX_LISTED).map(({ context, issue }) => (
                <button key={`${context}|${issue.kind}|${issue.namespace}|${issue.name}`} onClick={() => openIssue(context, issue)}>
                  <span className={`hdot ${issue.kind === "Node" ? "warn" : "error"}`} />
                  <span className="attention-what">
                    <b>{issue.name}</b> {issue.reason}
                  </span>
                  <span className="muted">
                    {shortContext(context)}
                    {issue.namespace ? ` · ${issue.namespace}` : ` · ${issue.kind.toLowerCase()}`}
                  </span>
                  <span className="attention-when muted">{issue.since ? age(issue.since, now) : ""}</span>
                </button>
              ))}
              {attention.length > MAX_LISTED && <div className="attention-more muted">and {attention.length - MAX_LISTED} more</div>}
            </div>
          </section>
        )}

        <div className="cards">
          {contexts.map((c) => {
            const p = probes[c.name];
            const found = issues[c.name];
            const count = found && "items" in found ? found.items.length : 0;
            const nodesDown = p?.state === "ok" ? p.data.nodes - p.data.nodesReady : 0;
            const warn = p?.state === "ok" && (count > 0 || nodesDown > 0);
            return (
              <div key={c.name} className={`card ${p?.state ?? "idle"} ${warn ? "attn" : ""}`} onClick={() => openResources([c.name])}>
                <div className="card-head">
                  <span className={`dot ${p ? (p.state === "ok" ? (warn ? "warn" : "ok") : p.state === "error" ? "error" : "loading") : "idle"}`} />
                  <span className="card-title" title={c.name}>
                    {shortContext(c.name)}
                  </span>
                  {favorites.includes(c.name) && <Star size={11} className="star on" />}
                  {shortcuts.includes(c.name) && (
                    <kbd className="ctx-key">
                      {modKey}
                      {shortcuts.indexOf(c.name) + 1}
                    </kbd>
                  )}
                  <EnvTag env={resolveEnv(envs, c.name)} />
                </div>
                <div className="card-sub" title={c.server}>
                  {c.name !== shortContext(c.name) ? c.name : c.server}
                </div>
                {p?.state === "ok" && (
                  <>
                    <div className="card-metrics">
                      <div>
                        <b className={nodesDown > 0 ? "warn" : ""}>
                          {p.data.nodesReady}/{p.data.nodes}
                        </b>
                        <span>nodes ready</span>
                      </div>
                      <div>
                        <b>{p.data.pods?.toLocaleString() ?? "–"}</b>
                        <span>pods</span>
                      </div>
                      <div>
                        <b>{p.data.namespaces ?? "–"}</b>
                        <span>namespaces</span>
                      </div>
                    </div>
                    <div className="ready-bar wide">
                      <span className={nodesDown > 0 ? "s-warn" : "s-ok"} style={{ width: `${p.data.nodes ? (p.data.nodesReady / p.data.nodes) * 100 : 0}%` }} />
                    </div>
                    <div className="card-foot">
                      <span className={warn ? "warn" : "muted"}>
                        {nodesDown > 0
                          ? `${nodesDown} node${nodesDown === 1 ? "" : "s"} not ready`
                          : count > 0
                            ? `${count} issue${count === 1 ? "" : "s"}`
                            : found
                              ? "Healthy"
                              : "Checking…"}
                      </span>
                      <span className="mono muted">
                        {p.data.version} · {p.data.latencyMs} ms
                      </span>
                    </div>
                  </>
                )}
                {p?.state === "loading" && <div className="card-msg muted">Connecting…</div>}
                {p?.state === "error" && (
                  <div className="card-msg error" title={p.error}>
                    {p.error}
                    <button
                      className="link"
                      onClick={(e) => {
                        e.stopPropagation();
                        probe(c.name);
                      }}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {c.namespace && <div className="card-ns">ns: {c.namespace}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
