import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Maximize2, Search, ShieldCheck, X } from "lucide-react";
import { api, errText, type ObjRef } from "../api";
import { BUILTIN } from "../kinds";
import { useStore } from "../store";
import {
  byteSize,
  detectFormat,
  FORMAT_LABEL,
  humanBytes,
  parsePairs,
  parsePem,
  prettyJson,
  sniffBinary,
  type Format,
  type PemBlock,
} from "../configFormat";

const CodeEditor = lazy(() => import("./YamlEditor").then((m) => ({ default: m.CodeEditor })));

const copy = (text: string) => {
  navigator.clipboard.writeText(text);
  useStore.getState().toast("Copied", "success");
};

/** The Data section of a ConfigMap: one card per key, shown according to what the value holds. */
export function ConfigData({ obj }: { obj: any }) {
  const [filter, setFilter] = useState("");
  const data: Record<string, string> = obj.data ?? {};
  const binary: Record<string, string> = obj.binaryData ?? {};
  const keys = [...Object.keys(data), ...Object.keys(binary)];
  if (!keys.length) return null;
  const q = filter.toLowerCase();
  const match = (k: string) => !q || k.toLowerCase().includes(q);
  return (
    <section className="obj-section">
      <div className="cfg-title">
        <h3>
          Data <span className="count">{keys.length}</span>
        </h3>
        {keys.length > 5 && (
          <label className="filter cfg-filter">
            <Search size={12} />
            <input placeholder="Filter keys" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {filter && (
              <button onClick={() => setFilter("")} title="Clear">
                <X size={12} />
              </button>
            )}
          </label>
        )}
      </div>
      <div className="cfg-list">
        {Object.entries(data)
          .filter(([k]) => match(k))
          .map(([k, v]) => (
            <ValueCard key={k} name={k} value={v} />
          ))}
        {Object.entries(binary)
          .filter(([k]) => match(k))
          .map(([k, v]) => (
            <BinaryCard key={k} name={k} b64={v} />
          ))}
      </div>
    </section>
  );
}

type View = "pretty" | "raw";

export function ValueCard({ name, value }: { name: string; value: string }) {
  const format = detectFormat(name, value);
  const [view, setView] = useState<View>("pretty");
  const [full, setFull] = useState(false);

  if (format === "line") {
    return (
      <div className="cfg-line">
        <span className="cfg-key">{name}</span>
        <span className="mono small cfg-line-value">{value || <span className="muted">(empty)</span>}</span>
        <button className="icon-btn tiny" onClick={() => copy(value)} title="Copy value">
          <Copy size={11} />
        </button>
      </div>
    );
  }

  const lines = value.split("\n").length;
  const switchable = ["json", "env", "properties", "pem"].includes(format);
  return (
    <div className="cfg-card">
      <div className="cfg-head">
        <span className="cfg-key">{name}</span>
        <span className="cfg-badge">{FORMAT_LABEL[format]}</span>
        <span className="muted small">
          {humanBytes(byteSize(value))} · {lines} line{lines === 1 ? "" : "s"}
        </span>
        <span className="spacer" />
        {switchable && (
          <div className="segmented small">
            <button className={view === "pretty" ? "on" : ""} onClick={() => setView("pretty")}>
              {format === "json" ? "Formatted" : format === "pem" ? "Decoded" : "Table"}
            </button>
            <button className={view === "raw" ? "on" : ""} onClick={() => setView("raw")}>
              Original
            </button>
          </div>
        )}
        <button className="icon-btn" onClick={() => copy(value)} title="Copy value">
          <Copy size={13} />
        </button>
        <button className="icon-btn" onClick={() => setFull(true)} title="Open full screen">
          <Maximize2 size={13} />
        </button>
      </div>
      <ValueBody format={format} value={value} view={view} />
      {full && <FullScreen name={name} format={format} value={format === "json" && view === "pretty" ? tryPretty(value).text : value} raw={value} onClose={() => setFull(false)} />}
    </div>
  );
}

/** A value full screen; `raw` is what Copy copies. */
function FullScreen({ name, format, value, raw, onClose }: { name: string; format: Format; value: string; raw: string; onClose: () => void }) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog wide tall"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Keep keys away from the table's window shortcuts (Esc would also close the detail panel).
          e.stopPropagation();
          if (e.key === "Escape") onClose();
        }}
        tabIndex={-1}
        ref={(el) => el?.focus()}
      >
        <div className="dialog-head">
          <h2 className="mono">{name}</h2>
          <span className="cfg-badge">{FORMAT_LABEL[format]}</span>
          <button className="icon-btn" onClick={() => copy(raw)} title="Copy value">
            <Copy size={13} />
          </button>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <X size={14} />
          </button>
        </div>
        <Code format={format} value={value} />
      </div>
    </div>
  );
}

const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";
const SHORT = 120;

/**
 * One annotation value. Short ones are shown as they are; JSON and long ones collapse to a one-line
 * preview that opens formatted and highlighted, like a ConfigMap key.
 */
export function AnnotationValue({ name, value }: { name: string; value: string }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const format = detectFormat(name, value);
  if (format !== "json" && value.length <= SHORT && !value.includes("\n")) return <span className="mono small">{value}</span>;

  const shown = format === "json" ? tryPretty(value).text : value;
  const shownFormat = format === "line" ? "text" : format;
  return (
    <div className="ann">
      <div className="ann-head">
        <button className="ann-toggle" onClick={() => setOpen((o) => !o)} title={open ? "Collapse" : "Expand"}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {format !== "line" && format !== "text" && <span className="cfg-badge">{FORMAT_LABEL[format]}</span>}
          <span className="muted small">{humanBytes(byteSize(value))}</span>
          {!open && <span className="mono small ann-preview">{name === LAST_APPLIED ? "the object as last applied by kubectl apply" : value}</span>}
        </button>
        <button className="icon-btn tiny" onClick={() => copy(value)} title="Copy value">
          <Copy size={11} />
        </button>
        <button className="icon-btn tiny" onClick={() => setFull(true)} title="Open full screen">
          <Maximize2 size={11} />
        </button>
      </div>
      {open && <Code format={shownFormat} value={shown} limited />}
      {full && <FullScreen name={name} format={shownFormat} value={shown} raw={value} onClose={() => setFull(false)} />}
    </div>
  );
}

const tryPretty = (v: string): { text: string; error?: string } => {
  try {
    return { text: prettyJson(v) };
  } catch (e) {
    return { text: v, error: errText(e) };
  }
};

function ValueBody({ format, value, view }: { format: Format; value: string; view: View }) {
  if (view === "pretty" && (format === "env" || format === "properties")) return <PairsTable pairs={parsePairs(value, format)} />;
  if (view === "pretty" && format === "pem") return <PemView blocks={parsePem(value)} />;
  if (view === "pretty" && format === "json") {
    const { text, error } = tryPretty(value);
    return (
      <>
        {error && <div className="error-banner">Not valid JSON: {error}</div>}
        <Code format={format} value={text} limited />
      </>
    );
  }
  return <Code format={format} value={value} limited />;
}

function Code({ format, value, limited }: { format: Format; value: string; limited?: boolean }) {
  const language = format === "pem" || format === "line" ? "text" : format;
  const fallback = <pre className="cfg-pre">{value}</pre>;
  return (
    <div className={limited ? "cfg-code limited" : "cfg-code"}>
      <Suspense fallback={fallback}>
        <CodeEditor value={value} language={language} readOnly />
      </Suspense>
    </div>
  );
}

function PairsTable({ pairs }: { pairs: [string, string][] }) {
  if (!pairs.length) return <div className="pad muted small">No KEY=VALUE pairs.</div>;
  return (
    <table className="mini cfg-pairs">
      <tbody>
        {pairs.map(([k, v], i) => (
          <tr key={`${k}-${i}`}>
            <td className="mono">{k}</td>
            <td className="mono">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const DAY = 86_400_000;

function PemView({ blocks }: { blocks: PemBlock[] }) {
  const now = Date.now();
  return (
    <div className="cfg-certs">
      {blocks.map((b, i) => {
        if (!b.cert) {
          return (
            <div key={i} className="cfg-cert">
              <b>{b.label}</b>
              {b.error && <span className="error small">Could not decode: {b.error}</span>}
            </div>
          );
        }
        const c = b.cert;
        const left = Math.floor((c.notAfter.getTime() - now) / DAY);
        const health = c.notBefore.getTime() > now || left < 0 ? "error" : left < 30 ? "warn" : "ok";
        const status = c.notBefore.getTime() > now ? "Not yet valid" : left < 0 ? `Expired ${-left} days ago` : `Expires in ${left} days`;
        const cn = /CN=([^,]+)/.exec(c.subject)?.[1] ?? c.subject;
        return (
          <div key={i} className="cfg-cert">
            <div className="row-gap">
              <ShieldCheck size={14} />
              <b>{cn}</b>
              {c.isCA && <span className="cfg-badge">CA</span>}
              <span className={`pill s-${health}`}>{status}</span>
            </div>
            <dl className="props">
              <dt>Subject</dt>
              <dd className="mono small">{c.subject}</dd>
              <dt>Issuer</dt>
              <dd className="mono small">{c.selfSigned ? "Self-signed" : c.issuer}</dd>
              <dt>Valid</dt>
              <dd>
                {c.notBefore.toLocaleDateString()} → {c.notAfter.toLocaleDateString()}
              </dd>
              {c.sans.length > 0 && (
                <>
                  <dt>Names</dt>
                  <dd className="chips">
                    {c.sans.map((s) => (
                      <span key={s} className="chip mono">
                        {s}
                      </span>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function BinaryCard({ name, b64 }: { name: string; b64: string }) {
  const size = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return (
    <div className="cfg-line">
      <span className="cfg-key">{name}</span>
      <span className="cfg-badge">binary</span>
      <span className="muted small cfg-line-value">
        {sniffBinary(b64)} · {humanBytes(size)}
      </span>
      <button className="icon-btn tiny" onClick={() => copy(b64)} title="Copy as base64">
        <Copy size={11} />
      </button>
    </div>
  );
}

interface Usage {
  kind: string;
  name: string;
  via: string[];
}

/** Workloads in the namespace that mount the ConfigMap/Secret or read it into their environment. */
export function UsedBy({ objRef }: { objRef: ObjRef }) {
  const [usage, setUsage] = useState<Usage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { openDetail } = useStore.getState();
  useEffect(() => {
    let alive = true;
    setUsage(null);
    setError(null);
    api
      .configUsage(objRef.context, objRef.kind.kind, objRef.namespace ?? "", objRef.name)
      .then((u) => alive && setUsage(u))
      .catch((e) => alive && setError(errText(e)));
    return () => {
      alive = false;
    };
  }, [objRef]);
  const kinds = useMemo(() => new Map(BUILTIN.map((b) => [b.ref.kind, b.ref])), []);

  return (
    <section className="obj-section">
      <h3>Used by</h3>
      {error ? (
        <div className="muted small">Could not check: {error}</div>
      ) : !usage ? (
        <div className="muted small">Looking for workloads…</div>
      ) : !usage.length ? (
        <div className="muted small">No workload in this namespace mounts it or reads it into its environment.</div>
      ) : (
        <table className="mini">
          <tbody>
            {usage.map((u) => (
              <tr key={`${u.kind}/${u.name}`}>
                <td className="muted">{u.kind}</td>
                <td>
                  <button
                    className="link"
                    onClick={() => openDetail({ context: objRef.context, kind: kinds.get(u.kind)!, namespace: objRef.namespace, name: u.name })}
                  >
                    {u.name}
                  </button>
                </td>
                <td className="muted small">{u.via.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
